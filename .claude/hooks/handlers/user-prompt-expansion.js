/**
 * UserPromptExpansion hook handler.
 *
 * Fires when Claude Code expands a slash-command (or similar) prompt. We use
 * the event itself as confirmation that an invoked skill actually exists and
 * ran — if it had been deleted or intercepted, no expansion would occur. Any
 * "pending" gate younger than the promotion window is promoted to "open".
 *
 * Silent regardless of outcome.
 */

'use strict';

const path = require('path');
const SkillGate = require('../lib/SkillGate');

module.exports = function userPromptExpansion(payload, ctx) {
  if (!payload) return;

  const projectDir = ctx.projectDir || payload.cwd || process.cwd();
  const configPath = path.join(
    projectDir, '.claude', 'hooks', 'config', 'conditionalTools.json',
  );

  try {
    const gate = new SkillGate(configPath, projectDir, payload.session_id);
    gate.confirmExpansion(payload);
  } catch (err) {
    process.stderr.write(`[user-prompt-expansion] SkillGate failed: ${err && err.message}\n`);
  }
};
