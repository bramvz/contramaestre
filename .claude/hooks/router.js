#!/usr/bin/env node
/**
 * Claude Code hook router.
 *
 * Invoked once per hook event by .claude/settings.json. All hook events route
 * through this single entry point, then dispatch to a per-event handler in
 * ./handlers/<event-name>.js (kebab-case).
 *
 * Contract (per https://code.claude.com/docs/en/hooks):
 *   - argv[2] is the hook event name (e.g. "SessionStart")
 *   - stdin is a JSON payload describing the event
 *   - exit code 0 with no stdout = Claude continues normally
 *   - stderr is surfaced to the user but NOT fed back into the model
 *   - stdout on SessionStart/UserPromptSubmit is injected as model context,
 *     so handlers that just want to log should write to stderr
 *
 * Design goals:
 *   - Cross-platform (Windows + macOS + Linux). No shell-specific syntax.
 *   - Never block Claude on an internal error. Errors go to stderr; exit 0.
 *   - Optional per-invocation JSON logs + a per-session "master" log with
 *     one line per module invocation. Both default ON. Set
 *     CLAUDE_HOOK_LOG=0 (or false/off/no) in the environment to disable.
 *   - Handlers are pure functions: (payload, ctx) => Promise<void> | void.
 *     ctx.masterLog(component, outcome) is provided so dispatcher / checks
 *     can record fine-grained entries beyond the router's default
 *     one-line-per-event entry.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const masterLogLib = require('./lib/master-log');

const HOOKS_DIR = __dirname;
const HANDLERS_DIR = path.join(HOOKS_DIR, 'handlers');
const LOGS_DIR = path.join(HOOKS_DIR, 'logs');

/**
 * Logging is ON by default. Disable by setting CLAUDE_HOOK_LOG to one of:
 *   0, false, off, no  (case-insensitive)
 */
const LOGGING_ENABLED = masterLogLib.isLoggingEnabled(process.env);

const sanitizeForFilename = masterLogLib.sanitizeForFilename;

/** Convert "SessionStart" -> "session-start". */
function toKebabCase(eventName) {
  return eventName
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Read all of stdin as a string. Resolves to "" if stdin is a TTY. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

/**
 * Persist a structured record of this invocation to ./logs/<sessionId>_<ts>.log.
 * Best-effort: never throws, never blocks Claude.
 */
function writeInvocationLog(record) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    const sessionId = sanitizeForFilename(
      (record.payload && record.payload.session_id) || 'no-session'
    );
    // ISO 8601 with filename-safe punctuation: 2026-05-15T12-05-33-433Z
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(LOGS_DIR, `${sessionId}_${timestamp}.log`);
    fs.writeFileSync(logPath, JSON.stringify(record, null, 2));
  } catch (err) {
    process.stderr.write(`[hook-router] log write failed: ${err.message}\n`);
  }
}

/**
 * Append a single line to the per-session master log AND, when this
 * session is a background dispatch (i.e. CLAUDE_HOOK_SENTINEL_SESSION
 * names an originating session id), mirror the line to that origin's
 * master log with a `bg[<short-bg-sid>] <component>` prefix.
 *
 * The mirroring is what gives the originating user a unified timeline of
 * "what the bg agent did" in their own session's log; the bg session's
 * own master log is left intact for standalone debugging.
 *
 * `CLAUDE_HOOK_LOG=0` disables BOTH writes.
 */
function appendMasterLog(sessionId, component, outcome) {
  if (!LOGGING_ENABLED) return;

  // Always write to the current session's own master log.
  masterLogLib.appendMasterLog(LOGS_DIR, sessionId, component, outcome, process.env);

  // If this process is running inside a bg dispatch, also mirror to the
  // originating main session's master log so the user sees their bg
  // agent's activity in their own log.
  const origin = process.env.CLAUDE_HOOK_SENTINEL_SESSION;
  if (origin && origin !== sessionId) {
    const shortBgSid = String(sessionId || 'no-sid').slice(0, 6);
    masterLogLib.appendMasterLog(
      LOGS_DIR,
      origin,
      `bg[${shortBgSid}] ${component}`,
      outcome,
      process.env,
    );
  }
}

/**
 * Inspect what a handler wrote to stdout and describe it for the master log.
 * Recognises the standard Claude Code hook outputs:
 *   - { decision: "block", reason }
 *   - { hookSpecificOutput: { permissionDecision, permissionDecisionReason } }
 *   - { systemMessage }
 * Anything else is logged as "stdout: <head>".
 */
function describeOutcome(capturedStdout) {
  const trimmed = String(capturedStdout || '').trim();
  if (!trimmed) return 'no-op';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.decision === 'block') {
      return `block: ${parsed.reason || ''}`;
    }
    if (parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision) {
      return `${parsed.hookSpecificOutput.permissionDecision}: ${
        parsed.hookSpecificOutput.permissionDecisionReason || ''
      }`;
    }
    if (parsed && parsed.systemMessage) {
      return `systemMessage: ${parsed.systemMessage}`;
    }
    return `stdout: ${trimmed}`;
  } catch (_e) {
    return `stdout: ${trimmed}`;
  }
}

async function main() {
  const eventName = process.argv[2];
  if (!eventName) {
    process.stderr.write('[hook-router] missing event name (argv[2])\n');
    process.exit(0); // never block Claude on a config error
  }

  const rawStdin = await readStdin();
  // Strip a leading UTF-8 BOM if present (PowerShell pipes add one on Windows).
  const cleanStdin = rawStdin.replace(/^﻿/, '');

  let payload = {};
  let parseError = null;
  if (cleanStdin.trim().length > 0) {
    try {
      payload = JSON.parse(cleanStdin);
    } catch (err) {
      parseError = err.message;
      payload = { __rawStdin: cleanStdin };
    }
  }

  const sessionId = (payload && payload.session_id) || 'no-session';

  // Filter env down to CLAUDE_* — full env would be huge and may contain secrets.
  const claudeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('CLAUDE_'))
  );

  // Per-invocation structured log (defaults on; CLAUDE_HOOK_LOG=0 to disable).
  if (LOGGING_ENABLED) {
    writeInvocationLog({
      timestamp: new Date().toISOString(),
      eventName,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      node: {
        version: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      claudeEnv,
      parseError,
      payload,
    });
  }

  // Dispatch to handler if one exists. Missing handler = silent no-op.
  const handlerPath = path.join(HANDLERS_DIR, `${toKebabCase(eventName)}.js`);
  if (!fs.existsSync(handlerPath)) {
    appendMasterLog(sessionId, eventName, 'no-handler');
    process.exit(0);
  }

  const ctx = {
    eventName,
    rawStdin: cleanStdin,
    argv: process.argv.slice(2),
    env: process.env,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    hooksDir: HOOKS_DIR,
    logsDir: LOGS_DIR,
    log: (msg) => process.stderr.write(`${msg}\n`),
    /**
     * Append a fine-grained entry to the master log. Used by the Stop
     * dispatcher and individual checks to record per-component outcomes
     * beyond the router's default one-line-per-event entry. No-op when
     * logging is disabled.
     */
    masterLog: (component, outcome) => appendMasterLog(sessionId, component, outcome),
  };

  // Capture handler stdout so we can describe the outcome in the master log.
  let capturedStdout = '';
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encOrCb, cb) => {
    try { capturedStdout += chunk.toString(); } catch (_e) { /* ignore */ }
    return origStdoutWrite(chunk, encOrCb, cb);
  };

  try {
    const handler = require(handlerPath);
    const fn = typeof handler === 'function' ? handler : handler.default;
    if (typeof fn !== 'function') {
      process.stderr.write(
        `[hook-router] ${eventName}: handler ${handlerPath} did not export a function\n`
      );
      appendMasterLog(sessionId, eventName, 'no-handler-function');
      process.exit(0);
    }
    await fn(payload, ctx);
    process.stdout.write = origStdoutWrite;
    appendMasterLog(sessionId, eventName, describeOutcome(capturedStdout));
    process.exit(0);
  } catch (err) {
    // Never block Claude on a handler error — log and continue.
    process.stdout.write = origStdoutWrite;
    process.stderr.write(
      `[hook-router] ${eventName}: handler threw: ${err && err.stack ? err.stack : err}\n`
    );
    appendMasterLog(sessionId, eventName, `error: ${err && err.message ? err.message : err}`);
    process.exit(0);
  }
}

main();
