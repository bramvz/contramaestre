'use strict';

/**
 * CheckinReminder.hasPassed() + Stop-dispatcher gating tests.
 *
 * hasPassed() is the side-effect-free predicate other hooks use to skip work
 * in sessions that are still behind the check-in gate. The Stop dispatcher
 * must skip ALL checks (adr/docs/format) when it returns false.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CheckinReminder = require('../CheckinReminder');
const stopHandler = require('../../handlers/stop');

const SESSION = 'test-session';

function setup({ checkinEnabled }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-'));
  const cfgDir = path.join(dir, '.contramaestre', 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'router.json'),
    JSON.stringify({ masterSwitch: true, checkinEnabled }),
  );
  return dir;
}

function writeCheckin(dir, timestamp) {
  const stateDir = path.join(dir, '.contramaestre', '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, `${SESSION}.json`),
    JSON.stringify({ jira: false, desc: 'test', type: 'feature', timestamp }),
  );
}

test('hasPassed: true when the feature is disabled', () => {
  const dir = setup({ checkinEnabled: false });
  assert.strictEqual(CheckinReminder.hasPassed(dir, SESSION), true);
});

test('hasPassed: false when enabled and never checked in', () => {
  const dir = setup({ checkinEnabled: true });
  assert.strictEqual(CheckinReminder.hasPassed(dir, SESSION), false);
});

test('hasPassed: true for a fresh check-in, false for a stale one', () => {
  const dir = setup({ checkinEnabled: true });
  writeCheckin(dir, new Date().toISOString());
  assert.strictEqual(CheckinReminder.hasPassed(dir, SESSION), true);

  const stale = new Date(Date.now() - CheckinReminder.STALE_MS - 60_000);
  writeCheckin(dir, stale.toISOString());
  assert.strictEqual(CheckinReminder.hasPassed(dir, SESSION), false);
});

test('hasPassed never writes (no timestamp refresh)', () => {
  const dir = setup({ checkinEnabled: true });
  const old = new Date(Date.now() - 60_000).toISOString(); // fresh but not "now"
  writeCheckin(dir, old);
  CheckinReminder.hasPassed(dir, SESSION);
  const state = JSON.parse(
    fs.readFileSync(CheckinReminder.stateFile(dir, SESSION), 'utf8'),
  );
  assert.strictEqual(state.timestamp, old);
});

test('Stop dispatcher skips all checks when the session is gated', async () => {
  const dir = setup({ checkinEnabled: true });
  const logged = [];
  await stopHandler(
    { session_id: SESSION, cwd: dir },
    { projectDir: dir, masterLog: (c, o) => logged.push(`${c}: ${o}`) },
  );
  assert.deepStrictEqual(logged, [
    'Stop:dispatcher: skipped all checks: no active check-in',
  ]);
});
