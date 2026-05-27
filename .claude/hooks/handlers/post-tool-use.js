/**
 * PostToolUse hook handler.
 *
 * Fires after a tool call completes.
 *
 * Payload:
 *   { session_id, transcript_path, cwd, hook_event_name: "PostToolUse",
 *     tool_name, tool_input, tool_response }
 *
 * Exit 2 sends a follow-up message to Claude (good for "you edited X but it
 * still has lint errors — here they are").
 *
 * Common uses:
 *   - Auto-format / lint after Edit|Write|MultiEdit.
 *   - Audit log of every tool call.
 *
 * Currently a no-op.
 */

'use strict';

module.exports = function postToolUse(payload, ctx) {
  // no-op
};
