/**
 * PreCompact hook handler.
 *
 * Fires before transcript auto-compaction (or /compact). stdout is included in
 * the compacted summary.
 *
 * Payload:
 *   { session_id, transcript_path, cwd, hook_event_name: "PreCompact",
 *     trigger: "manual" | "auto" }
 *
 * Common uses:
 *   - Preserve critical state: write currently open files / outstanding TODOs /
 *     key decisions to stdout so they survive into the compacted summary.
 *
 * Currently a no-op.
 */

'use strict';

module.exports = function preCompact(payload, ctx) {
  // no-op
};
