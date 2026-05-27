'use strict';

/**
 * Shared helpers for the per-session master log used by the router and
 * the dispatch-sentinel.
 *
 * The master log is one file per Claude Code session:
 *   .claude/hooks/logs/master-<sanitizedSessionId>.log
 *
 * Append-only, one line per component invocation, format:
 *   <isoTs>  <component(padded36)>  <outcome>
 *
 * Disable globally with CLAUDE_HOOK_LOG=0 (or false/off/no).
 *
 * This module exists to keep filename sanitisation, line formatting,
 * and the off-switch consistent between:
 *   - router.js (writes one line per hook event invocation, per session)
 *   - dispatch-sentinel.js (writes a `BgDispatch:<name>` end-line to the
 *     ORIGIN session's master log when a bg dispatch finishes)
 *
 * Both reach the same path through the same code path, so the entries
 * a user finds in `master-<sid>.log` always come out identically.
 */

const fs = require('fs');
const path = require('path');

const MASTER_LOG_OUTCOME_MAX = 240;
const COMPONENT_PAD = 36;

/**
 * Honor CLAUDE_HOOK_LOG=0 (or false/off/no) as a global off-switch.
 * Defaults to ON.
 */
function isLoggingEnabled(env) {
  const v = (env || process.env).CLAUDE_HOOK_LOG || '';
  return !/^(0|false|off|no)$/i.test(v);
}

/** Replace characters illegal in filenames on Windows/macOS/Linux. */
function sanitizeForFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Absolute path to the master log file for `sessionId`. */
function masterLogPath(logsDir, sessionId) {
  return path.join(logsDir, `master-${sanitizeForFilename(sessionId)}.log`);
}

/**
 * Build a single log line. Newlines inside `outcome` are flattened so
 * each entry stays on one line; outcomes longer than
 * MASTER_LOG_OUTCOME_MAX are truncated.
 */
function formatLine(component, outcome) {
  const ts = new Date().toISOString();
  const comp = String(component || '').padEnd(COMPONENT_PAD);
  let out = String(outcome == null ? '' : outcome);
  if (out.length > MASTER_LOG_OUTCOME_MAX) {
    out = out.slice(0, MASTER_LOG_OUTCOME_MAX) + '…';
  }
  out = out.replace(/\r?\n/g, ' ⏎ ');
  return `${ts}  ${comp}  ${out}\n`;
}

/**
 * Append one entry to `master-<sessionId>.log`. Best-effort: never
 * throws, writes a stderr diagnostic on failure.
 *
 * Note: fs.appendFileSync is atomic on POSIX for writes ≤ PIPE_BUF,
 * but Windows offers no equivalent guarantee. In rare cases two
 * processes appending simultaneously can interleave bytes. For a
 * line-oriented debug log this is acceptable; for stricter ordering
 * a lock file would be needed.
 */
function appendMasterLog(logsDir, sessionId, component, outcome, env) {
  if (!isLoggingEnabled(env)) return;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(masterLogPath(logsDir, sessionId), formatLine(component, outcome));
  } catch (err) {
    process.stderr.write(`[master-log] append failed: ${err && err.message}\n`);
  }
}

module.exports = {
  MASTER_LOG_OUTCOME_MAX,
  COMPONENT_PAD,
  isLoggingEnabled,
  sanitizeForFilename,
  masterLogPath,
  formatLine,
  appendMasterLog,
};
