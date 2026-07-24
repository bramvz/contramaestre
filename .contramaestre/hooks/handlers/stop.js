/**
 * Stop hook handler — aggregating dispatcher.
 *
 * Loads every `.js` file in ../checks/ alphabetically and runs each as a
 * check. Every check that returns `{block:true, reason}` contributes its
 * reason to a single combined Stop-decision payload emitted to stdout —
 * Claude refuses the stop once and sees all the reasons together.
 *
 * Multi-item framing: when more than one check blocks, the combined
 * payload wraps each reason in a numbered banner ("ITEM N of M") and
 * adds a preamble + outro instructing the model to address EVERY item,
 * with explicit permission to invoke multiple skills in one turn.
 * Single-item case is rendered cleanly (no banners, no preamble).
 *
 * Check module contract:
 *   module.exports = async function check(payload, ctx)
 *     -> { block: true, reason: string } | null | undefined
 *
 *   - Return `{block:true, reason}` to halt the stop.
 *   - Return null/undefined to pass.
 *   - Do NOT write to stdout — only the dispatcher owns stdout. Use
 *     ctx.log() / stderr for diagnostics.
 *   - A check that throws is logged to stderr; remaining checks still
 *     run.
 *   - Checks should not assume order; the dispatcher composes reasons
 *     in alphabetical filename order.
 *
 * Reentrancy: when `payload.stop_hook_active === true`, Claude Code is
 * telling us a previous Stop hook already requested continued work in
 * this chain. The dispatcher bails immediately so we don't ping-pong.
 *
 * Check-in gate: when `checkinEnabled` is on (router.json) and this session
 * has no fresh check-in, ALL checks are skipped — the session is still gated
 * at the prompt level, so no real work has happened, and dispatching
 * adr/docs/format reviews (which spawn background claude agents) would be
 * wasted. No-op when the check-in feature is disabled.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const CheckinReminder = require('../lib/CheckinReminder');

const CHECKS_DIR = path.join(__dirname, '..', 'checks');
const BANNER = '═'.repeat(67);

module.exports = async function stop(payload, ctx) {
  if (payload && payload.stop_hook_active === true) return;
  if (!fs.existsSync(CHECKS_DIR)) return;

  // Skip every check while the session is still behind the check-in gate.
  // hasPassed() is side-effect-free and returns true when the feature is
  // disabled. Best-effort: on an unexpected error, run the checks as before.
  try {
    const projectDir = (ctx && ctx.projectDir) || (payload && payload.cwd) || process.cwd();
    const sessionId = (payload && payload.session_id) || 'no-session';
    if (!CheckinReminder.hasPassed(projectDir, sessionId)) {
      if (ctx && typeof ctx.masterLog === 'function') {
        ctx.masterLog('Stop:dispatcher', 'skipped all checks: no active check-in');
      }
      return;
    }
  } catch (err) {
    process.stderr.write(`[stop-dispatcher] check-in gate errored (running checks anyway): ${err && err.message}\n`);
  }

  const files = fs.readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  const reasons = [];
  for (const file of files) {
    const full = path.join(CHECKS_DIR, file);
    const moduleName = `Stop:${file.replace(/\.js$/, '')}`;
    let mod;
    try {
      mod = require(full);
    } catch (err) {
      process.stderr.write(
        `[stop-dispatcher] failed to load ${file}: ${err && err.message}\n`
      );
      if (ctx && typeof ctx.masterLog === 'function') {
        ctx.masterLog(moduleName, `load-error: ${err && err.message}`);
      }
      continue;
    }
    const fn = typeof mod === 'function' ? mod : (mod && mod.default);
    if (typeof fn !== 'function') {
      process.stderr.write(
        `[stop-dispatcher] ${file} did not export a function\n`
      );
      if (ctx && typeof ctx.masterLog === 'function') {
        ctx.masterLog(moduleName, 'not-a-function');
      }
      continue;
    }

    let result;
    try {
      result = await fn(payload, ctx);
    } catch (err) {
      process.stderr.write(
        `[stop-dispatcher] ${file} threw: ${err && err.stack ? err.stack : err}\n`
      );
      if (ctx && typeof ctx.masterLog === 'function') {
        ctx.masterLog(moduleName, `error: ${err && err.message}`);
      }
      continue;
    }

    if (result && result.block && result.reason) {
      reasons.push(result.reason);
      if (ctx && typeof ctx.masterLog === 'function') {
        ctx.masterLog(moduleName, `block: ${result.reason}`);
      }
    } else if (ctx && typeof ctx.masterLog === 'function') {
      ctx.masterLog(moduleName, 'silent');
    }
  }

  if (reasons.length === 0) {
    if (ctx && typeof ctx.masterLog === 'function') {
      ctx.masterLog('Stop:dispatcher', 'no-block');
    }
    return;
  }

  if (ctx && typeof ctx.masterLog === 'function') {
    ctx.masterLog('Stop:dispatcher', `emit ${reasons.length} reason(s)`);
  }
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: composeReason(reasons),
  }));
};

/**
 * Build the final reason text. Single item is rendered as-is for
 * cleanliness. Multi-item wraps each section in a numbered banner with
 * an explicit "address EACH" preamble and outro.
 */
function composeReason(reasons) {
  if (reasons.length === 1) return reasons[0];

  const n = reasons.length;
  const preamble =
    `Stop blocked by ${n} outstanding item(s). Address EACH in this turn ` +
    `— they are independent; you must decide on every one. You may invoke ` +
    `multiple skills in a single turn, and you should.`;

  const sections = reasons.map((r, i) => {
    const header = `${BANNER}\nITEM ${i + 1} of ${n}\n${BANNER}`;
    return `${header}\n${r}`;
  });

  const outro =
    `${BANNER}\nEnd of stop reasons. For each item: take the prescribed ` +
    `action OR state explicitly why you are skipping. Do not respond ` +
    `without addressing all ${n} items.`;

  return [preamble, ...sections, outro].join('\n\n');
}
