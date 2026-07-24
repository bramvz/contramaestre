'use strict';

/**
 * SkillGate event-ordering tests.
 *
 * Covers the Expansion-before-Submit handling in recordPromptSubmit():
 *   - an expansion immediately followed by a matching submit opens the gate
 *     directly (the CLI's real ordering for a genuine skill invocation);
 *   - the expansion stamp is CONSUMED by that submit — a later matching
 *     submit with no expansion of its own must NOT open a gate (it goes
 *     pending), otherwise one expansion could vouch for skill-less prompts
 *     for the whole grace window;
 *   - the legacy Submit-then-Expansion ordering still promotes pending → open.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SkillGate = require('../SkillGate');

const SESSION = 'test-session';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillgate-order-'));
  const configPath = path.join(dir, 'conditionalTools.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      rules: [
        {
          name: 'deploy',
          skillName: 'deploy',
          skillGateRegEx: '^/deploy (?<env>\\w+)',
          trigger: 'gcloud',
          conditionalAllow: ['gcloud .* {env}'],
          unmatchedAction: 'deny',
        },
      ],
    }),
  );
  return { dir, gate: new SkillGate(configPath, dir, SESSION) };
}

function readState(dir) {
  const file = path.join(dir, '.contramaestre', '.state', `gates-${SESSION}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('Expansion-before-Submit opens the gate directly', () => {
  const { dir, gate } = setup();
  gate.confirmExpansion({});
  gate.recordPromptSubmit('/deploy prod');
  const state = readState(dir);
  assert.strictEqual(state.deploy.status, 'open');
  assert.deepStrictEqual(state.deploy.vars, { env: 'prod' });
});

test('the expansion stamp is consumed by the first submit', () => {
  const { dir, gate } = setup();
  gate.confirmExpansion({});
  gate.recordPromptSubmit('/deploy prod');
  assert.strictEqual(readState(dir).__lastExpansionAt, undefined);

  // A second matching prompt with no expansion of its own must not reuse the
  // old stamp — it only goes pending, and screening denies the tool call.
  gate.recordPromptSubmit('/deploy staging');
  assert.strictEqual(readState(dir).deploy.status, 'pending');
  const verdict = gate.screenToolUse('Bash', { command: 'gcloud run deploy staging' }, null);
  assert.strictEqual(verdict.decision, 'deny');
});

test('a non-matching submit also consumes the stamp', () => {
  const { dir, gate } = setup();
  gate.confirmExpansion({});
  gate.recordPromptSubmit('just a normal prompt');
  assert.strictEqual(readState(dir).__lastExpansionAt, undefined);

  gate.recordPromptSubmit('/deploy prod');
  assert.strictEqual(readState(dir).deploy.status, 'pending');
});

test('legacy Submit-then-Expansion ordering still promotes pending to open', () => {
  const { dir, gate } = setup();
  gate.recordPromptSubmit('/deploy prod');
  assert.strictEqual(readState(dir).deploy.status, 'pending');
  gate.confirmExpansion({});
  assert.strictEqual(readState(dir).deploy.status, 'open');
});
