/**
 * UserPromptSubmit hook handler.
 *
 * Fires every time the user submits a prompt (before Claude sees it). Used
 * here to record tentative ("pending") skill-gate state — captured variables
 * from any rule whose skillGateRegEx matches the literal prompt are stored
 * to disk. UserPromptExpansion later promotes them to "open".
 *
 * Silent (no stdout output) regardless of outcome.
 */

'use strict';

const path = require('path');
const SkillGate = require('../lib/SkillGate');
const CheckinReminder = require('../lib/CheckinReminder');

module.exports = function userPromptSubmit(payload, ctx) {
  if (!payload || typeof payload.prompt !== 'string') return;

  const projectDir = ctx.projectDir || payload.cwd || process.cwd();

  const configPath = path.join(
    projectDir, '.contramaestre', 'config', 'conditionalTools.json',
  );

  try {
    const gate = new SkillGate(configPath, projectDir, payload.session_id);
    gate.recordPromptSubmit(payload.prompt);
  } catch (err) {
    process.stderr.write(`[user-prompt-submit] SkillGate failed: ${err && err.message}\n`);
  }

  // Check-in gate. Skip when the prompt is itself a check-in invocation in any
  // of the skill's documented forms — "/checkin …", "checkin", "check in" /
  // "check-in", or a leading "continue" (the skill's refresh trigger) — since
  // the skill manages the state file and the user must always be able to clear
  // the block. Otherwise: refuse the prompt if there is no check-in or it's
  // stale (>2h), or silently refresh the timestamp if it's recent. A returned
  // reason is injected as additionalContext directing Claude to refuse the
  // request this turn (see below — a hard block would yield no visible reply).
  try {
    const isCheckinPrompt = /^\s*(\/?check[-\s]?in\b|continue\b)/i.test(payload.prompt);
    if (!isCheckinPrompt) {
      const { reason, refreshed } = CheckinReminder.evaluate(
        projectDir, payload.session_id || 'no-session',
      );
      if (reason) {
        if (typeof ctx.masterLog === 'function') {
          ctx.masterLog('CheckinReminder', `gate: ${reason}`);
        }
        // Inject a directive so Claude refuses the work this turn and replies
        // ONLY with the check-in instructions. additionalContext is the
        // UserPromptSubmit channel that yields a VISIBLE agent message — a hard
        // block has no agent turn, so the user sees nothing.
        const directive =
          "CHECK-IN REQUIRED — do not fulfill or answer the user's request this " +
          'turn. Do not write code, edit files, or run tools. Your entire reply ' +
          'must be only the following message, addressed to the user:\n\n' + reason;
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: directive,
          },
        }));
      } else if (refreshed && typeof ctx.masterLog === 'function') {
        // Only when the check-in was actually refreshed (feature enabled +
        // fresh). When disabled, evaluate is a no-op and we stay silent.
        ctx.masterLog('CheckinReminder', 'fresh: refreshed timestamp');
      }
    }
  } catch (err) {
    process.stderr.write(`[user-prompt-submit] CheckinReminder failed: ${err && err.message}\n`);
  }
};
