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
 * Currently a no-op.
 */

'use strict';

module.exports = function sessionEnd(payload, ctx) {
  // no-op
};
