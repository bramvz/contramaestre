/**
 * SubagentStop hook handler.
 *
 * Fires when a subagent (Agent tool task) finishes.
 *
 * Payload:
 *   { session_id, transcript_path, cwd, hook_event_name: "SubagentStop" }
 *
 * Exit 2 keeps the subagent going (same semantics as Stop, scoped to subagents).
 *
 * Common uses:
 *   - Verify a subagent actually produced expected artifacts before letting it stop.
 *   - Metrics: count subagent invocations / duration.
 *
 * Currently a no-op.
 */

'use strict';

module.exports = function subagentStop(payload, ctx) {
  // no-op
};
