/**
 * Notification hook handler.
 *
 * Fires when Claude Code wants the user's attention (idle, permission prompt, etc.).
 *
 * Payload:
 *   { session_id, transcript_path, cwd, hook_event_name: "Notification", message }
 *
 * Common uses:
 *   - Desktop notification (osascript on macOS, BurntToast/PowerShell on Windows).
 *   - Slack / Teams ping when Claude is waiting on you.
 *
 * Currently a no-op.
 */

'use strict';

module.exports = function notification(payload, ctx) {
  // no-op
};
