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

module.exports = function userPromptSubmit(payload, ctx) {
  if (!payload || typeof payload.prompt !== 'string') return;

  const projectDir = ctx.projectDir || payload.cwd || process.cwd();
  const configPath = path.join(
    projectDir, '.claude', 'hooks', 'config', 'conditionalTools.json',
  );

  try {
    const gate = new SkillGate(configPath, projectDir, payload.session_id);
    gate.recordPromptSubmit(payload.prompt);
  } catch (err) {
    process.stderr.write(`[user-prompt-submit] SkillGate failed: ${err && err.message}\n`);
  }
};
