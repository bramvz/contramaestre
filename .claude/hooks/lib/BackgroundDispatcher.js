'use strict';

/**
 * BackgroundDispatcher — spawn a detached headless `claude -p` process.
 *
 * Used by Stop-checks running in `background` mode (see docs-review and
 * adr-review). Writes the dispatched process's prompt + name to a JSONL
 * audit log at .claude/.state/dispatch-log.jsonl so cost/activity is
 * traceable after the fact.
 *
 * Design choices captured here (cross-reference: ADR-0002 follow-up):
 *
 *   - Uses `claude -p` (headless), NOT `claude --bg` (background-agent
 *     supervisor). Headless writes to the cwd it was spawned in — i.e.
 *     the main thread's working tree — so the agent's modifications
 *     land directly as uncommitted changes the user can review in
 *     `git status`. `claude --bg` would isolate writes to
 *     `.claude/worktrees/<id>/` and require a separate merge step.
 *
 *   - Does NOT auto-commit. The prompt explicitly instructs the agent
 *     to leave changes uncommitted. The user reviews and commits when
 *     ready.
 *
 *   - Permission mode = `acceptEdits`. Non-interactive Edit/Write
 *     succeed without prompting. Wider modes (`auto`,
 *     `bypassPermissions`) require prior interactive opt-in per
 *     project and are intentionally not used here.
 *
 *   - No timeout. Detached processes have no enforced runtime cap. The
 *     user kills via OS task manager if needed. Could add
 *     `--max-turns` to the spawn args if hangs become a problem.
 *
 *   - No agent-view visibility. Headless `claude -p` does not appear
 *     in the agent-view sidebar and produces no desktop notification.
 *     The dispatch-log file is the only signal that something ran.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const CLI = IS_WIN ? 'claude.cmd' : 'claude';
const WHICH = IS_WIN ? 'where' : 'which';
const MAX_DIFF_CHARS = 4000;
// Stale-file cleanup: any leftover dispatched-settings tempfile older than
// this is assumed orphaned (process crashed before it could clean up) and
// pruned on the next dispatch. Settings file lifetime in normal operation
// is seconds — claude reads it during startup.
const SETTINGS_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

class BackgroundDispatcher {
  /**
   * @param {string} projectDir - repo root.
   * @param {string} sessionId  - main-thread Claude Code session id (for audit).
   */
  constructor(projectDir, sessionId) {
    this.projectDir = projectDir || process.cwd();
    this.sessionId = String(sessionId || 'no-session');
    this.stateDir = path.join(this.projectDir, '.claude', '.state');
    this.logPath = path.join(this.stateDir, 'dispatch-log.jsonl');
  }

  /**
   * Is `claude` on PATH? Cheap sync check via `where`/`which`.
   */
  isAvailable() {
    try {
      const r = spawnSync(WHICH, ['claude'], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && (r.stdout || '').trim().length > 0;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Spawn a detached headless `claude -p` with the given prompt.
   *
   * @param {string} name           - identifier for this dispatch (logged + visible in `ps`).
   * @param {string} prompt         - the prompt text to send to Claude.
   * @param {string[]} [allowedTools] - per-spawn permission allowlist. Each entry
   *                                    is a Claude Code permission-rule string,
   *                                    e.g. "Read", "Write", "Bash(git diff *)".
   *                                    Passed via `--settings` so it doesn't
   *                                    widen permissions for interactive
   *                                    sessions. Without this, headless Bash
   *                                    and web tools would hang on permission
   *                                    prompts.
   * @returns {{ok: boolean, error?: string}}
   */
  dispatch(name, prompt, allowedTools) {
    if (!prompt || typeof prompt !== 'string') {
      return { ok: false, error: 'empty prompt' };
    }
    if (!this.isAvailable()) {
      return { ok: false, error: `\`${CLI}\` not found on PATH` };
    }

    // Best-effort cleanup of any orphaned settings tempfiles from prior runs.
    this._pruneStaleSettingsFiles();

    try {
      const tools = Array.isArray(allowedTools) ? allowedTools.filter(Boolean) : [];

      const childArgs = ['-p', '--permission-mode', 'acceptEdits'];
      // The prompt is passed via stdin — NOT as a positional argv. On
      // Windows Node 20.12+/22+, CVE-2024-27980 hardening makes
      // spawn('claude.cmd', [...], {shell:false}) fail with EINVAL, and
      // even with {shell:true} cmd.exe mangles long JSON-containing argv.
      // Sending the prompt over stdin (`claude -p` reads stdin when no
      // positional is provided) sidesteps that entirely. The sentinel
      // forwards our stdin into the claude child.

      // --settings accepts EITHER a JSON string OR a file path. On Windows
      // the JSON string is mangled by cmd.exe even with shell:true, so we
      // always route via a tempfile for cross-platform consistency.
      let settingsPath = null;
      if (tools.length > 0) {
        try {
          fs.mkdirSync(this.stateDir, { recursive: true });
          settingsPath = path.join(
            this.stateDir,
            `dispatched-settings-${sanitizeId(this.sessionId)}-${Date.now()}-${process.pid}.json`,
          );
          fs.writeFileSync(
            settingsPath,
            JSON.stringify({ permissions: { allow: tools } }),
          );
          childArgs.push('--settings', settingsPath);
        } catch (err) {
          return { ok: false, error: `settings tempfile: ${err && err.message}` };
        }
      }

      // Spawn the sentinel wrapper instead of claude directly. The sentinel:
      //   - forwards our stdin (the prompt) into the claude child;
      //   - waits for the claude child to exit;
      //   - appends a dispatch-end record to the dispatch-log so
      //     BgBusyGuard.listInFlight can reliably tell when this dispatch
      //     is finished (rather than relying solely on pid-liveness).
      //
      // We invoke the sentinel via `process.execPath` (node.exe on Windows,
      // a real executable not a .cmd) so shell:false works on every
      // platform and `proc.pid` is the sentinel's own pid — exactly the
      // pid the sentinel will write into its end record.
      const sentinelPath = path.join(__dirname, 'dispatch-sentinel.js');
      const sentinelArgv = [
        sentinelPath,
        this.logPath,
        name,
        '--',
        CLI,
        ...childArgs,
      ];

      const proc = spawn(process.execPath, sentinelArgv, {
        cwd: this.projectDir,
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: {
          ...process.env,
          // Recorded into the sentinel's end record for traceability.
          CLAUDE_HOOK_SENTINEL_SESSION: this.sessionId,
          // Prevent self-deadlock: if the bg session ever issues a
          // git commit / push / merge tool call, its own PreToolUse
          // BgBusyGuard would otherwise wait on its own pid being
          // in-flight. Skipping the guard in the bg child is correct
          // because the bg session by design does not commit anyway —
          // this just prevents a wedge if a future bg prompt ever does.
          CLAUDE_HOOK_SKIP_BG_GUARD: '1',
        },
      });

      // Hand the prompt over via the sentinel's stdin → child stdin.
      if (proc.stdin) {
        try {
          proc.stdin.write(prompt);
          proc.stdin.end();
        } catch (err) {
          return { ok: false, error: `stdin write: ${err && err.message}` };
        }
      }
      proc.unref();

      this._appendLog({
        event: 'dispatch',
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        name,
        pid: proc.pid || null,
        allowedTools: tools.length > 0 ? tools : null,
        settingsPath: settingsPath,
        promptHead: prompt.slice(0, 240) + (prompt.length > 240 ? '…' : ''),
      });
      // pid is surfaced so callers (docs-review / adr-review) can include
      // it in their master-log "start" entries.
      return { ok: true, pid: proc.pid || null, name };
    } catch (err) {
      return { ok: false, error: err && err.message };
    }
  }

  /**
   * Best-effort prune of leftover `dispatched-settings-*.json` files in
   * `.claude/.state/`. Anything older than SETTINGS_FILE_MAX_AGE_MS is
   * assumed orphaned (its owning claude process crashed before it could
   * be cleaned). Silently swallows errors — this is housekeeping, not
   * critical-path.
   */
  _pruneStaleSettingsFiles() {
    try {
      if (!fs.existsSync(this.stateDir)) return;
      const cutoff = Date.now() - SETTINGS_FILE_MAX_AGE_MS;
      const entries = fs.readdirSync(this.stateDir);
      for (const name of entries) {
        if (!name.startsWith('dispatched-settings-') || !name.endsWith('.json')) continue;
        const p = path.join(this.stateDir, name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs < cutoff) fs.unlinkSync(p);
        } catch (_e) {
          /* ignore */
        }
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /**
   * Build a concise repo-state context block for inclusion in a prompt.
   * Returns the current branch + a truncated git-diff against HEAD +
   * the list of untracked files. ~MAX_DIFF_CHARS chars total.
   */
  getRepoContext() {
    const branch = (this._git(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || '(detached)';
    let diff = this._git(['diff', 'HEAD']) || '';
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS) + `\n…(truncated; full diff is ${diff.length} chars)`;
    }
    const untracked = (this._git(['ls-files', '--others', '--exclude-standard']) || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const untrackedSection = untracked.length
      ? `Untracked files:\n${untracked.map((u) => `  - ${u}`).join('\n')}\n\n`
      : '';
    return (
      `Branch: ${branch}\n\n` +
      untrackedSection +
      `Diff against HEAD:\n` +
      '```diff\n' + (diff.trim() || '(no tracked changes)') + '\n```'
    );
  }

  _git(args) {
    try {
      const r = spawnSync('git', args, {
        cwd: this.projectDir,
        encoding: 'utf8',
        windowsHide: true,
      });
      return r.status === 0 ? r.stdout : null;
    } catch (_e) {
      return null;
    }
  }

  _appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      process.stderr.write(
        `[BackgroundDispatcher] log append failed: ${err && err.message}\n`,
      );
    }
  }
}

/**
 * Sanitize an identifier fragment so it's safe for filenames or process
 * names. Pure helper; exported for the checks that build dispatch names.
 */
function sanitizeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 32);
}

BackgroundDispatcher.sanitizeId = sanitizeId;
module.exports = BackgroundDispatcher;
