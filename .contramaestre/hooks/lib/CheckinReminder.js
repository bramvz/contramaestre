'use strict';

/**
 * CheckinReminder — keep the per-session check-in fresh and nudge when needed.
 *
 * Gated by `checkinEnabled` in .contramaestre/config/router.json (default
 * DISABLED — also when the key is unset/missing). When disabled, evaluate() is
 * a no-op: no block, no nudge, and no state write (not even a timestamp
 * refresh). The `checkin` skill itself is NOT gated — it writes its state file
 * regardless; only this reminder hook honors the toggle.
 *
 * The `checkin` skill writes .contramaestre/.state/<sessionId>.json with
 * { jira, newTicket, ticketNumber, desc, type, timestamp }. This module runs
 * from the UserPromptSubmit hook on each user message and decides:
 *
 *   - No state file (or unreadable): the session was never checked in →
 *     BLOCK with a reason telling the user to run `/checkin` (only `jira` /
 *     `non-jira` — NOT `continue`, since there's nothing to continue from).
 *   - timestamp > 2h old (or missing/invalid): the check-in is stale → BLOCK
 *     with a reason naming the current task (desc + ticket) and offering
 *     `/checkin continue` (valid here — a record exists) or a fresh `/checkin`.
 *     The timestamp is NOT refreshed — so it stays blocked until re-checked-in.
 *   - timestamp <= 2h old: still active → refresh `timestamp` to now (preserving
 *     every other field) and return no reason (the message proceeds).
 *
 * A non-null `reason` is injected by the handler as UserPromptSubmit
 * `additionalContext`, wrapped in a directive telling Claude to refuse the
 * request this turn and reply ONLY with `reason`. This is the one approach that
 * yields a VISIBLE agent message telling the user how to check in — a hard hook
 * block (decision:block / exit 2) stops Claude from running at all, so the user
 * sees no agent reply. Enforcement is therefore agent-level (Claude obeying the
 * injected directive), not a kernel block. The handler skips this check when
 * the prompt is itself a check-in invocation in any documented form ("/checkin",
 * "checkin", "check in"/"check-in", or a leading "continue"), so the user can
 * always clear the gate.
 *
 * Best-effort: never throws outward (handler also wraps in try/catch). The only
 * write is the in-place timestamp refresh, done atomically (tmp+rename).
 */

const fs = require('fs');
const path = require('path');

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

function sanitize(value) {
  return String(value == null ? '' : value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
}

function stateFile(projectDir, sessionId) {
  return path.join(
    projectDir,
    '.contramaestre',
    '.state',
    `${sanitize(sessionId)}.json`,
  );
}

/**
 * The whole check-in feature (block/nudge + state writes) is gated by
 * `checkinEnabled` in .contramaestre/config/router.json. Default DISABLED:
 * missing, unset, false, or unreadable config → false.
 */
function isCheckinEnabled(projectDir) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(
        path.join(projectDir, '.contramaestre', 'config', 'router.json'),
        'utf8',
      ),
    );
    return cfg.checkinEnabled === true;
  } catch (_e) {
    return false;
  }
}

/** UTC ISO 8601 without milliseconds, matching the checkin skill's format. */
function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
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

// Single line: only the first line of stderr surfaces in the block notice.
const NO_CHECKIN_REASON =
  'No active check-in for this session. Run /checkin jira (work on a Jira ticket: ' +
  'a number, a description to search, or create one) or /checkin non-jira ' +
  '(describe the work — feature/bug/customer/other), then resend your message.';

/** Human-readable description of the checked-in task for the stale nudge. */
function describeTask(state) {
  if (state && state.jira) {
    const ticket = state.ticketNumber ? `Jira ${state.ticketNumber}` : 'a Jira ticket';
    return state.desc ? `${ticket} — "${state.desc}"` : ticket;
  }
  if (state && state.desc) {
    return state.type ? `${state.type} work — "${state.desc}"` : `"${state.desc}"`;
  }
  return 'an unspecified task';
}

/**
 * Side-effect-free predicate: has this session passed the check-in gate?
 * True when the feature is disabled (the gate is not in force) or a readable,
 * fresh (<= STALE_MS) check-in record exists for the session. Never writes —
 * unlike evaluate(), the timestamp is NOT refreshed. Used by other hooks
 * (e.g. the Stop dispatcher) to skip work in sessions that are still gated.
 */
function hasPassed(projectDir, sessionId) {
  if (!isCheckinEnabled(projectDir)) return true;
  try {
    const state = JSON.parse(
      fs.readFileSync(stateFile(projectDir, sessionId), 'utf8'),
    );
    const parsedMs = Date.parse(state && state.timestamp);
    if (Number.isNaN(parsedMs)) return false;
    return Date.now() - parsedMs <= STALE_MS;
  } catch (_e) {
    return false; // no file / unreadable → never checked in
  }
}

/**
 * Evaluate the session's check-in. Returns { reason } — a string to BLOCK the
 * prompt with, or { reason: null } when the check-in is fresh (just refreshed).
 */
function evaluate(projectDir, sessionId) {
  // Feature toggle (router.json `checkinEnabled`, default false). When
  // disabled: no block, no nudge, and NO state write (not even a refresh).
  if (!isCheckinEnabled(projectDir)) return { reason: null, refreshed: false };

  const file = stateFile(projectDir, sessionId);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return { reason: NO_CHECKIN_REASON }; // no file → never checked in
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (_e) {
    return { reason: NO_CHECKIN_REASON }; // unreadable → treat as none
  }

  const parsedMs = Date.parse(state && state.timestamp);
  const ageMs = Number.isNaN(parsedMs) ? Infinity : Date.now() - parsedMs;

  if (ageMs > STALE_MS) {
    const task = describeTask(state);
    const when = state && state.timestamp ? state.timestamp : 'an unknown time';
    // Single line: only the first line of stderr surfaces in the block notice.
    const reason =
      `Check-in stale (>2h, last updated ${when}). Current task: ${task}. ` +
      `Run /checkin continue if you're still on it, or a fresh /checkin ` +
      `(jira / non-jira), then resend your message.`;
    return { reason }; // do NOT refresh — stays blocked until they re-check-in
  }

  // Fresh: refresh timestamp to now, preserve every other field, allow through.
  try {
    state.timestamp = nowIso();
    atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch (_e) { /* best-effort; non-fatal */ }
  return { reason: null, refreshed: true };
}

module.exports = {
  STALE_MS,
  evaluate,
  hasPassed,
  stateFile,
  isCheckinEnabled,
  _internals: { describeTask, nowIso, sanitize, NO_CHECKIN_REASON },
};
