'use strict';

/**
 * PlanCapture — persist Claude Code plan-mode plans and classify their
 * terminal state.
 *
 * A plan is the `plan` argument of the built-in `ExitPlanMode` tool. That
 * single tool call surfaces as two hook events:
 *   - PreToolUse  (the proposal — fires before the approval dialog)
 *   - PostToolUse (fires only if the plan is approved and the tool runs)
 *
 * We record exactly ONE terminal state per plan in the master log:
 *
 *   proposed     Shown to the user but never accepted (rejected/superseded, or
 *                the session ended first). LOGGED to the master log, but its
 *                draft file is NOT retained on disk (it's deleted). Emitted when
 *                a still-pending plan is superseded by a NEW proposal, or
 *                flushed at SessionEnd.
 *   accepted     The user approved it via the dialog. PostToolUse fired after
 *                a human-length gap (> autoAcceptGapMs).
 *   autoAccepted Approved with no human in the loop — either contramaestre
 *                auto-approved it (config.autoApprove, deterministic via the
 *                `forcedAuto` marker) OR an external auto-approver was detected
 *                because PostToolUse followed PreToolUse within autoAcceptGapMs.
 *
 * Because `proposed` is only emitted on NON-acceptance, an auto-approved plan
 * yields `autoAccepted` and nothing else — never a stray `proposed` line.
 *
 * Edited-at-approval: Claude Code lets the user edit the plan in the approval
 * dialog, so the approved text (PostToolUse `tool_input.plan`) can differ from
 * what Claude proposed (PreToolUse). The approved text is authoritative and is
 * what gets written. Exactly ONE file is kept per proposal; the `edited`
 * metadata flag records whether the user changed the plan (`true`) or accepted
 * it unchanged (`false`). The original proposed text is not retained separately.
 *
 * Only accepted/autoAccepted plans are retained as files in
 * .contramaestre/plans/; a proposed-but-rejected plan is logged only (its draft
 * file is deleted). Pending state lives at .contramaestre/.state/plan-<session>.json
 * (one active proposal per session — plan mode is sequential). Both dirs sit
 * under the gitignored .contramaestre/** tree; only config/ is tracked.
 *
 * All functions are best-effort and self-contained: they never throw outward
 * (callers still wrap them) and never write to stdout, so they cannot disturb
 * a hook's permission decision.
 */

const fs = require('fs');
const path = require('path');

const TOOL_NAME = 'ExitPlanMode';

const DEFAULTS = {
  enabled: true,
  autoApprove: false,
  autoAcceptGapMs: 1000,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function configPath(projectDir) {
  return path.join(projectDir, '.contramaestre', 'config', 'planCapture.json');
}

/** Load planCapture.json, falling back to DEFAULTS for any missing/invalid key. */
function loadConfig(projectDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(projectDir), 'utf8'));
  } catch (_e) {
    return { ...DEFAULTS };
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    autoApprove:
      typeof raw.autoApprove === 'boolean' ? raw.autoApprove : DEFAULTS.autoApprove,
    autoAcceptGapMs:
      typeof raw.autoAcceptGapMs === 'number' && raw.autoAcceptGapMs >= 0
        ? raw.autoAcceptGapMs
        : DEFAULTS.autoAcceptGapMs,
  };
}

function isExitPlanMode(toolName) {
  return toolName === TOOL_NAME;
}

// ---------------------------------------------------------------------------
// Paths + IO helpers (atomic writes mirror SkillGate's tmp+rename pattern)
// ---------------------------------------------------------------------------

function sanitize(value) {
  return String(value == null ? '' : value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
}

function plansDir(projectDir) {
  return path.join(projectDir, '.contramaestre', 'plans');
}

function pendingFile(projectDir, sessionId) {
  return path.join(
    projectDir,
    '.contramaestre',
    '.state',
    `plan-${sanitize(sessionId)}.json`,
  );
}

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* ignore */ }
    throw err;
  }
}

function readPending(projectDir, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(pendingFile(projectDir, sessionId), 'utf8'));
  } catch (_e) {
    return null;
  }
}

function writePending(projectDir, sessionId, data) {
  atomicWrite(pendingFile(projectDir, sessionId), JSON.stringify(data, null, 2));
}

function clearPending(projectDir, sessionId) {
  try { fs.unlinkSync(pendingFile(projectDir, sessionId)); } catch (_e) { /* ignore */ }
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Plan files
// ---------------------------------------------------------------------------

/** First non-empty line, stripped of leading markdown heading marks. */
function planTitle(plan) {
  const line = String(plan || '')
    .split(/\r?\n/)
    .find((l) => l.trim().length);
  if (!line) return '(untitled plan)';
  return line.replace(/^#+\s*/, '').trim().slice(0, 80) || '(untitled plan)';
}

function renderPlanFile(meta, plan) {
  const lines = [
    '---',
    `session: ${meta.session}`,
    `toolUseId: ${meta.toolUseId || ''}`,
    `proposedAt: ${meta.proposedAt}`,
    `resolvedAt: ${meta.resolvedAt || ''}`,
    `status: ${meta.status}`,
  ];
  // For resolved (accepted/autoAccepted) plans, record whether the user edited
  // the plan at approval (true) or accepted it unchanged (false).
  if (typeof meta.edited === 'boolean') lines.push(`edited: ${meta.edited}`);
  lines.push('---', '');
  return `${lines.join('\n')}${String(plan || '')}\n`;
}

/**
 * Normalize plan text for equality comparison: CRLF→LF and trailing
 * whitespace stripped, so cosmetic line-ending/trailing-newline differences
 * don't read as a user edit.
 */
function normalizePlan(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Write (or rewrite) a plan file at `absPath` with the given metadata + body.
 * Returns the project-relative path for logging.
 */
function writePlanAt(projectDir, absPath, meta, plan) {
  atomicWrite(absPath, renderPlanFile(meta, plan));
  return path.relative(projectDir, absPath);
}

/** Stable plan-file path derived from the proposal's identity. */
function planFilePath(projectDir, sessionId, proposedTsForName, toolUseId) {
  const shortId = sanitize(toolUseId).slice(-8) || 'noid';
  const fname = `${sanitize(sessionId)}__${proposedTsForName}__${shortId}.md`;
  return path.join(plansDir(projectDir), fname);
}

// ---------------------------------------------------------------------------
// Hook entry points
// ---------------------------------------------------------------------------

/**
 * PreToolUse(ExitPlanMode): record the proposed plan.
 *
 * Returns { autoApproved, logEntries } where:
 *   - autoApproved   true when config.autoApprove is set; the caller should
 *                    emit a PreToolUse `allow` decision to skip the dialog.
 *   - logEntries     zero or more { status, title, relPath } the caller should
 *                    write to the master log. Non-empty only when a prior,
 *                    still-pending proposal was superseded (⇒ 'proposed').
 */
function onPropose(projectDir, payload) {
  const cfg = loadConfig(projectDir);
  if (!cfg.enabled) return { autoApproved: false, logEntries: [] };

  const sessionId = payload.session_id || 'no-session';
  const toolUseId = payload.tool_use_id || '';
  const plan = (payload.tool_input && payload.tool_input.plan) || '';
  const logEntries = [];

  // A still-pending prior proposal means the user did NOT accept it (Claude is
  // now re-proposing). Log the 'proposed' event but DELETE its draft file —
  // rejected/superseded plans are recorded in the log, not retained on disk.
  const prior = readPending(projectDir, sessionId);
  if (prior && prior.planFile) {
    try { fs.unlinkSync(prior.planFile); } catch (_e) { /* already gone */ }
    logEntries.push({
      status: 'proposed',
      title: prior.title,
      relPath: '(not retained)',
      note: 'superseded — file removed',
    });
  }

  const proposedAtIso = nowIso();
  const proposedTsForName = proposedAtIso.replace(/[:.]/g, '-');
  const title = planTitle(plan);
  const planFile = planFilePath(projectDir, sessionId, proposedTsForName, toolUseId);

  writePlanAt(
    projectDir,
    planFile,
    { session: sessionId, toolUseId, proposedAt: proposedAtIso, resolvedAt: '', status: 'pending' },
    plan,
  );

  writePending(projectDir, sessionId, {
    session: sessionId,
    toolUseId,
    preTsMs: Date.now(),
    proposedAtIso,
    planFile,
    forcedAuto: cfg.autoApprove,
    title,
    plan,
  });

  return { autoApproved: cfg.autoApprove, logEntries };
}

/**
 * PostToolUse(ExitPlanMode): the plan was approved (PostToolUse only fires on
 * acceptance). The PostToolUse payload's `tool_input.plan` is the AUTHORITATIVE
 * approved text — Claude Code lets the user edit the plan in the approval
 * dialog, so it may differ from what Claude proposed at PreToolUse.
 *
 * Behavior:
 *   - approved == proposed (or Post carries no plan): one record, finalized
 *     with the approved text and the terminal status.
 *   - approved != proposed (user edited): BOTH versions are kept as separate
 *     files — the original proposal (status 'proposed', superseded) and the
 *     approved version (status accepted/autoAccepted) — cross-linked via
 *     `counterpart`, and TWO log entries are emitted.
 *
 * Returns { logEntries: [{status, title, relPath, note?}] } (empty when
 * capture is disabled).
 */
function onResolve(projectDir, payload) {
  const cfg = loadConfig(projectDir);
  if (!cfg.enabled) return { logEntries: [] };

  const sessionId = payload.session_id || 'no-session';
  const toolUseId = payload.tool_use_id || '';
  const resolvedAtIso = nowIso();
  const pending = readPending(projectDir, sessionId);
  const approvedRaw = payload.tool_input && payload.tool_input.plan;

  if (!pending || !pending.planFile) {
    // No proposal was captured (capture enabled mid-flight, or state lost).
    // Persist the approved plan now; we can't compare to a proposal, so
    // `edited` is unknown → record false.
    const plan = approvedRaw || '';
    const status = cfg.autoApprove ? 'autoAccepted' : 'accepted';
    const proposedTsForName = resolvedAtIso.replace(/[:.]/g, '-');
    const planFile = planFilePath(projectDir, sessionId, proposedTsForName, toolUseId);
    const relPath = writePlanAt(
      projectDir,
      planFile,
      { session: sessionId, toolUseId, proposedAt: resolvedAtIso, resolvedAt: resolvedAtIso, status, edited: false },
      plan,
    );
    return { logEntries: [{ status, edited: false, title: planTitle(plan), relPath, note: 'unchanged' }] };
  }

  const gapMs = Date.now() - (pending.preTsMs || 0);
  const status =
    pending.forcedAuto || gapMs <= cfg.autoAcceptGapMs ? 'autoAccepted' : 'accepted';

  // Approved text is authoritative (user may have edited at the dialog). Fall
  // back to the proposed text if Post carries no plan — then it's "unchanged".
  const approvedPlan =
    approvedRaw != null && String(approvedRaw).length ? approvedRaw : pending.plan;
  const edited = normalizePlan(pending.plan) !== normalizePlan(approvedPlan);

  // ONE file: body = the approved plan; metadata records the terminal status
  // and whether the user edited it (true) or accepted it unchanged (false).
  const relPath = writePlanAt(
    projectDir,
    pending.planFile,
    {
      session: sessionId,
      toolUseId: pending.toolUseId,
      proposedAt: pending.proposedAtIso,
      resolvedAt: resolvedAtIso,
      status,
      edited,
    },
    approvedPlan,
  );
  clearPending(projectDir, sessionId);
  return {
    logEntries: [{
      status,
      edited,
      title: planTitle(approvedPlan),
      relPath,
      note: edited ? 'edited' : 'unchanged',
    }],
  };
}

/**
 * SessionEnd: a plan still pending at session end was proposed but never
 * accepted. Finalize it as 'proposed'. Returns the entry to log, or null.
 */
function flushPending(projectDir, sessionId) {
  const cfg = loadConfig(projectDir);
  if (!cfg.enabled) return { logEntries: [] };

  const pending = readPending(projectDir, sessionId);
  if (!pending || !pending.planFile) return { logEntries: [] };

  // Pending at session end = proposed but never accepted. Log the event and
  // delete the draft file (rejected/abandoned plans are not retained on disk).
  try { fs.unlinkSync(pending.planFile); } catch (_e) { /* already gone */ }
  clearPending(projectDir, sessionId);
  return {
    logEntries: [{
      status: 'proposed',
      title: pending.title,
      relPath: '(not retained)',
      note: 'abandoned — file removed',
    }],
  };
}

module.exports = {
  TOOL_NAME,
  DEFAULTS,
  isExitPlanMode,
  loadConfig,
  onPropose,
  onResolve,
  flushPending,
  // exposed for tests
  _internals: { planTitle, sanitize, planFilePath, renderPlanFile },
};
