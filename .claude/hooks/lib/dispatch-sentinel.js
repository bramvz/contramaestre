#!/usr/bin/env node
/**
 * dispatch-sentinel — wrap a detached `claude -p` so we can reliably know
 * when it has finished.
 *
 * BackgroundDispatcher spawns this script instead of invoking `claude.cmd`
 * directly. The sentinel:
 *
 *   1. Forwards its own stdin (the prompt) to the child process.
 *   2. Waits for the child to exit.
 *   3. Appends a `dispatch-end` record to the dispatch-log JSONL so
 *      BgBusyGuard.listInFlight can pair it with the parent's start
 *      record and treat the dispatch as completed.
 *
 * End records are written on every plausible exit path — normal exit,
 * child spawn error, uncaught exception, SIGINT/SIGTERM, and the
 * top-level `process.on('exit')` catch-all. SIGKILL is the only case
 * where no end record is written; BgBusyGuard's pid-liveness +
 * staleness fallback covers that.
 *
 * The pid recorded by BackgroundDispatcher's parent process is this
 * sentinel's own pid (because the parent spawned `node sentinel.js …`
 * directly, with no shell wrapping needed since node.exe is a real
 * executable on Windows). The sentinel writes the same `process.pid`
 * into its end record so the two match.
 *
 * CLI:
 *
 *   node dispatch-sentinel.js <dispatchLogPath> <name> -- <childCmd> [args...]
 *
 * The `--` separator is required and distinguishes our own args from
 * the args we pass through to the child.
 *
 * Environment:
 *
 *   CLAUDE_HOOK_SENTINEL_SESSION  optional; recorded in the end entry.
 *                                 BackgroundDispatcher sets this to the
 *                                 originating main-thread session id.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const masterLogLib = require('./master-log');

const IS_WIN = process.platform === 'win32';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 2) {
    throw new Error("missing '--' separator (usage: sentinel.js <log> <name> -- <cmd> [args...])");
  }
  const head = argv.slice(0, sep);
  if (head.length !== 2) {
    throw new Error(`expected 2 args before '--', got ${head.length}`);
  }
  const tail = argv.slice(sep + 1);
  if (tail.length < 1) {
    throw new Error(`expected at least 1 arg after '--', got ${tail.length}`);
  }
  return {
    dispatchLogPath: head[0],
    name: head[1],
    childCmd: tail[0],
    childArgs: tail.slice(1),
  };
}

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`[sentinel] ${err.message}\n`);
  process.exit(2);
}

const { dispatchLogPath, name, childCmd, childArgs } = parsed;

let endWritten = false;
function writeEnd(reason, extra) {
  if (endWritten) return;
  endWritten = true;
  const originSid = process.env.CLAUDE_HOOK_SENTINEL_SESSION || null;
  try {
    fs.mkdirSync(path.dirname(dispatchLogPath), { recursive: true });
    const record = {
      event: 'dispatch-end',
      at: new Date().toISOString(),
      sessionId: originSid,
      name,
      pid: process.pid,
      reason,
      ...(extra || {}),
    };
    fs.appendFileSync(dispatchLogPath, JSON.stringify(record) + '\n');
  } catch (_e) {
    // best-effort; never let a logging failure crash the sentinel
  }
  // Also surface the end in the originating session's master log so the
  // user sees a matching `end` line next to the `start` line that
  // docs-review / adr-review emitted before us. Best-effort, honors
  // CLAUDE_HOOK_LOG=0 via the shared helper.
  if (originSid) {
    const parts = [reason];
    if (extra && extra.exitCode !== undefined) parts.push(`exit=${extra.exitCode}`);
    if (extra && extra.signal) parts.push(`signal=${extra.signal}`);
    if (extra && extra.error) parts.push(`error=${extra.error}`);
    masterLogLib.appendMasterLog(
      LOGS_DIR,
      originSid,
      `BgDispatch:${name}`,
      `end (${parts.join(', ')})`,
      process.env,
    );
  }
}

// Catch-alls. process.on('exit') is the last line of defense — it fires
// for any exit reason except SIGKILL or a hard process.abort().
process.on('exit', () => writeEnd('exit'));
process.on('uncaughtException', (err) => {
  writeEnd('uncaught', { error: err && err.message });
  // Re-raise as a non-zero exit so the harness still sees something went wrong.
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  writeEnd('unhandled-rejection', { error: err && err.message });
  process.exit(1);
});
process.on('SIGINT', () => { writeEnd('sigint'); process.exit(130); });
process.on('SIGTERM', () => { writeEnd('sigterm'); process.exit(143); });

/**
 * Spawn the claude child cross-platform.
 *
 * On Windows, `spawn('claude.cmd', argv, {shell:false})` fails with EINVAL
 * under the Node 20.12+/22+ CVE-2024-27980 hardening. The naïve workaround
 * `shell: true` works for the launch but re-tokenizes the command line
 * inside cmd.exe, which mangles arguments that contain spaces (e.g. a
 * settings-file path under "C:\Users\Some User\..."). To avoid both, we
 * spawn `cmd.exe` directly (a real .exe so {shell:false} is allowed) and
 * pass `/d /s /c <quoted-cmdline>`, controlling the quoting ourselves.
 */
function spawnChildCrossPlatform(childCmd, childArgs) {
  if (!IS_WIN) {
    return spawn(childCmd, childArgs, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
  }
  // Build the quoted command line. cmd.exe has a notorious quirk: when
  // the string passed to /c starts AND ends with a double quote, cmd.exe
  // strips that outer pair before parsing. To preserve our quoting we
  // wrap the entire string in one additional outer quote pair. /d
  // disables AutoRun, /s tells cmd.exe to keep the quotes after the
  // FIRST char (necessary for the wrap trick to be reliable).
  const inner = [childCmd, ...childArgs].map(quoteForCmd).join(' ');
  const cmdline = '"' + inner + '"';
  return spawn('cmd.exe', ['/d', '/s', '/c', cmdline], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    // Pass our /c argument verbatim — without this, Node re-quotes
    // argv using MSVCRT rules and double-escapes our explicit quoting.
    windowsVerbatimArguments: true,
  });
}

/**
 * Quote a single argument for cmd.exe's /c command-line parser. Wraps in
 * double quotes if the argument contains any character outside a
 * conservative safe-set. Embedded double quotes are escaped by doubling
 * (cmd.exe rule). Backslashes pass through.
 *
 * Sufficient for our real-world inputs (alphanumeric flags + absolute
 * file paths). Not a full implementation of MS_CRT quoting.
 */
function quoteForCmd(s) {
  if (s.length > 0 && /^[A-Za-z0-9_\-.\\/:=]+$/.test(s)) return s;
  return '"' + String(s).replace(/"/g, '""') + '"';
}

let child;
try {
  child = spawnChildCrossPlatform(childCmd, childArgs);
} catch (err) {
  writeEnd('spawn-error', { error: err && err.message });
  process.exit(1);
}

// Pipe parent stdin (prompt) into child stdin. Both sides can be torn
// down independently so we attach defensive error handlers.
if (child.stdin) {
  child.stdin.on('error', () => { /* EPIPE on child early-exit, ok */ });
  process.stdin.on('error', () => { /* ignore */ });
  process.stdin.pipe(child.stdin);
}

child.on('error', (err) => {
  writeEnd('child-error', { error: err && err.message });
  process.exit(1);
});

child.on('exit', (code, signal) => {
  writeEnd('child-exit', { exitCode: code, signal: signal || null });
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
