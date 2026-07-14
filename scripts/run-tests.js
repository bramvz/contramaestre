#!/usr/bin/env node
'use strict';
/**
 * Test runner for contramaestre's own hook tests (invoked via `npm test`).
 *
 * The tests are plain scripts that print `PASS`/`FAIL` lines. They are not
 * uniform about exit codes: the mapping test exits non-zero on failure, but
 * the older trigger-matcher scripts always exit 0 and only signal via a
 * `FAIL` line. This runner therefore fails the overall run if ANY child
 * process exits non-zero OR prints a line beginning with `FAIL`.
 *
 * Discovers every `*.test.js` under `.contramaestre/` so new tests are picked
 * up automatically. Lives outside `.contramaestre/` because that tree is the
 * runtime copied into consumers (and overwritten on upgrade); this runner is
 * for developing contramaestre itself and is not shipped.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIR = path.join(ROOT, '.contramaestre');

function findTests(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTests(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) found.push(full);
  }
  return found;
}

const tests = findTests(SEARCH_DIR).sort();
if (tests.length === 0) {
  process.stderr.write('No *.test.js files found under .contramaestre/\n');
  process.exit(1);
}

let failed = 0;
for (const testFile of tests) {
  const rel = path.relative(ROOT, testFile);
  const result = spawnSync(process.execPath, [testFile], { encoding: 'utf8' });
  const stdout = result.stdout || '';
  process.stdout.write(stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  // A line beginning with FAIL, or a non-zero exit, means this file failed.
  const badExit = result.status !== 0;
  const sawFailLine = /^FAIL\b/m.test(stdout);
  const ok = !badExit && !sawFailLine;
  process.stdout.write(`--- ${rel}: ${ok ? 'ok' : 'FAILED'} (exit ${result.status})\n\n`);
  if (!ok) failed++;
}

process.stdout.write(`${tests.length - failed}/${tests.length} test file(s) passed.\n`);
process.exit(failed === 0 ? 0 : 1);
