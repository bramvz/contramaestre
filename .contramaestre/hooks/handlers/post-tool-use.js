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
 * Plan capture: PostToolUse for ExitPlanMode only fires when the plan was
 * approved, so its presence is the "accepted" signal. PlanCapture classifies
 * accepted vs autoAccepted and finalizes the stored plan file. All other tools
 * remain a no-op.
 */

'use strict';

const PlanCapture = require('../lib/PlanCapture');

module.exports = function postToolUse(payload, ctx) {
  if (!payload || !PlanCapture.isExitPlanMode(payload.tool_name)) return;

  const projectDir = (ctx && ctx.projectDir) || payload.cwd || process.cwd();
  try {
    const res = PlanCapture.onResolve(projectDir, payload);
    if (res && res.logEntries && ctx && typeof ctx.masterLog === 'function') {
      for (const e of res.logEntries) {
        const suffix = e.note ? ` (${e.note})` : '';
        ctx.masterLog('PlanCapture', `${e.status}${suffix}: ${e.title} -> ${e.relPath}`);
      }
    }
  } catch (err) {
    process.stderr.write(`[post-tool-use] PlanCapture.onResolve failed: ${err && err.message}\n`);
  }
};
