/**
 * PreToolUse hook handler.
 *
 * Fires before any tool call. Runs three screens in sequence:
 *
 *   1. AccessGuard — denies reads/writes/deletes against paths in
 *      .contramaestre/config/blockedPaths.json. Sensitive-data baseline.
 *
 *   2. SkillGate — denies tool calls that should only run after a specific
 *      skill was invoked. Driven by .contramaestre/config/conditionalTools.json
 *      and gate state at .contramaestre/.state/gates-<session>.json.
 *
 *   3. BgBusyGuard — for Bash calls that look like `git commit`,
 *      `git push`, `git merge`, `git rebase`, `git pull`, `gh pr create`,
 *      or `gh pr merge`: wait up to 30s for any in-flight background
 *      `claude -p` dispatches to finish. If they don't, deny the tool
 *      call with instructions to retry. This prevents the user pushing
 *      or branch-closing a half-baked state while docs-review or
 *      adr-review bg agents are still writing.
 *
 * The first deny wins; whichever screen denies emits the JSON
 * `permissionDecision: "deny"` payload to stdout and the handler returns.
 *
 * Self-protection of the hook tree itself is opt-in via the blocklist:
 * add `.contramaestre/hooks/` and `.claude/settings.json` to blockedPaths.json
 * to prevent Claude from tampering with the enforcement layer.
 *
 * Escape hatches:
 *   CLAUDE_HOOK_SKIP_BG_GUARD=1  bypass the bg-busy wait (for when the
 *                                user wants to push without the pending
 *                                bg writes).
 */

'use strict';

const path = require('path');
const AccessGuard = require('../lib/AccessGuard');
const SkillGate = require('../lib/SkillGate');
const BgBusyGuard = require('../lib/BgBusyGuard');
const PlanCapture = require('../lib/PlanCapture');

const ACCESS_BLOCK_REASON = 'Stop execution, tell user you tried to access a blocked path';

// Wait budget for bg dispatches to finish. Must stay under the PreToolUse
// hook timeout in settings.json (currently 60s) with margin for the other
// screens — AccessGuard + SkillGate together take <100ms, so 30s leaves
// ~30s of headroom.
const BG_AWAIT_MAX_MS = 30 * 1000;
const BG_AWAIT_POLL_MS = 1000;
// Retry hint shown to the model — matches BG_AWAIT_MAX_MS so a naïve
// retry-after-delay clears most short bg jobs on the second attempt.
const BG_RETRY_HINT_S = 30;

module.exports = async function preToolUse(payload, ctx) {
  if (!payload || !payload.tool_name) return;

  const projectDir = ctx.projectDir || payload.cwd || process.cwd();

  // --- 0. PlanCapture (ExitPlanMode) -----------------------------------------
  // ExitPlanMode is unrelated to the file/skill/git screens below — handle it
  // here and return. We record the proposed plan; if planCapture.autoApprove is
  // set we also emit an `allow` decision so the plan is accepted without the
  // dialog (logged as autoAccepted on the matching PostToolUse). Any superseded
  // prior proposal is finalized as 'proposed' here.
  if (PlanCapture.isExitPlanMode(payload.tool_name)) {
    try {
      const res = PlanCapture.onPropose(projectDir, payload);
      if (typeof ctx.masterLog === 'function') {
        for (const e of res.logEntries) {
          ctx.masterLog('PlanCapture', `${e.status}: ${e.title} -> ${e.relPath}`);
        }
      }
      if (res.autoApproved) {
        emitAllow('Plan auto-approved by contramaestre (planCapture.autoApprove=true)');
        return;
      }
    } catch (err) {
      process.stderr.write(`[pre-tool-use] PlanCapture.onPropose failed: ${err && err.message}\n`);
    }
    return;
  }

  // --- 1. AccessGuard --------------------------------------------------------
  const blocklistPath = path.join(
    projectDir, '.contramaestre', 'config', 'blockedPaths.json',
  );
  const guard = new AccessGuard(blocklistPath, projectDir);
  const access = guard.check(
    payload.tool_name,
    payload.tool_input || {},
    payload.cwd || projectDir,
  );
  if (access.blocked) {
    emitDeny(ACCESS_BLOCK_REASON);
    return;
  }

  // --- 2. SkillGate ----------------------------------------------------------
  const conditionalPath = path.join(
    projectDir, '.contramaestre', 'config', 'conditionalTools.json',
  );
  let verdict;
  try {
    const gate = new SkillGate(conditionalPath, projectDir, payload.session_id);
    verdict = gate.screenToolUse(
      payload.tool_name,
      payload.tool_input || {},
      payload.parent_tool_use_id,
    );
  } catch (err) {
    process.stderr.write(`[pre-tool-use] SkillGate failed: ${err && err.message}\n`);
    // never block on a guard error — fall through
    verdict = null;
  }

  if (verdict && verdict.decision === 'deny') {
    emitDeny(verdict.reason);
    return;
  }

  // --- 3. BgBusyGuard --------------------------------------------------------
  // Only applies to commit/push-shaped Bash calls. Anything else returns
  // null immediately and we exit allow.
  const classified = BgBusyGuard.classify(payload.tool_name, payload.tool_input || {});
  if (!classified) return;

  if (BgBusyGuard.isDisabled(process.env)) {
    if (typeof ctx.masterLog === 'function') {
      ctx.masterLog('BgBusyGuard', `skipped via env (${classified.kind})`);
    }
    return;
  }

  const bg = new BgBusyGuard(projectDir);

  // Cheap pre-check: if nothing is in flight right now, allow without sleeping.
  const initial = bg.listInFlight();
  if (initial.length === 0) {
    if (typeof ctx.masterLog === 'function') {
      ctx.masterLog('BgBusyGuard', `clear at entry (${classified.kind})`);
    }
    return;
  }

  process.stderr.write(
    `[pre-tool-use] ${classified.kind} blocked pending ${initial.length} bg dispatch(es); ` +
      `waiting up to ${Math.round(BG_AWAIT_MAX_MS / 1000)}s…\n`,
  );

  const remaining = await bg.awaitIdle(BG_AWAIT_MAX_MS, BG_AWAIT_POLL_MS);

  if (remaining.length === 0) {
    if (typeof ctx.masterLog === 'function') {
      ctx.masterLog('BgBusyGuard', `cleared after wait (${classified.kind})`);
    }
    process.stderr.write('[pre-tool-use] bg dispatches finished; allowing tool call.\n');
    return;
  }

  // Still in flight after the wait — deny and tell the model to retry.
  const list = remaining
    .map((d) => `  - ${d.name} (pid ${d.pid}, started ${d.at}, age ${Math.round(d.ageMs / 1000)}s)`)
    .join('\n');
  const reason =
    `Your \`${classified.kind}\` is blocked: ${remaining.length} background ` +
    `Claude dispatch(es) are still writing to the working tree:\n\n${list}\n\n` +
    `These were spawned by Stop checks (docs-review / adr-review) and have ` +
    `not finished. Committing or pushing now would either exclude their ` +
    `changes (leaving the working tree dirty after your push) or include ` +
    `half-written files (if a wildcard add picked them up).\n\n` +
    `Retry the same tool call in ~${BG_RETRY_HINT_S} seconds. The PreToolUse ` +
    `hook will re-check on each retry and allow the call once all bg ` +
    `dispatches have finished (or aged past 30 minutes). If you need to ` +
    `proceed without waiting, the user can set ` +
    `CLAUDE_HOOK_SKIP_BG_GUARD=1 in their environment.`;

  if (typeof ctx.masterLog === 'function') {
    ctx.masterLog('BgBusyGuard', `deny: ${remaining.length} bg in flight (${classified.kind})`);
  }
  emitDeny(reason);
};

function emitDeny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function emitAllow(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }));
}
