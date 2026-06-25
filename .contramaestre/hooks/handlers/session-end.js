/**
 * SessionEnd hook handler.
 *
 * Fires when a Claude Code session ends.
 *
 * Payload:
 *   { session_id, transcript_path, cwd, hook_event_name: "SessionEnd", reason }
 *
 * Common uses:
 *   - Flush metrics, archive transcripts, send summary notification.
 *
 * Plan capture: a plan still pending at session end was proposed but never
 * accepted — finalize it as 'proposed'. No-op when nothing is pending.
 */

'use strict';

const PlanCapture = require('../lib/PlanCapture');

module.exports = function sessionEnd(payload, ctx) {
  if (!payload) return;

  const projectDir = (ctx && ctx.projectDir) || payload.cwd || process.cwd();
  try {
    const res = PlanCapture.flushPending(projectDir, payload.session_id || 'no-session');
    if (res && res.logEntries && ctx && typeof ctx.masterLog === 'function') {
      for (const e of res.logEntries) {
        ctx.masterLog('PlanCapture', `${e.status}: ${e.title} -> ${e.relPath}`);
      }
    }
  } catch (err) {
    process.stderr.write(`[session-end] PlanCapture.flushPending failed: ${err && err.message}\n`);
  }
};
