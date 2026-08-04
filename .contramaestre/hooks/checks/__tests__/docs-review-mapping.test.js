'use strict';

/**
 * Unit tests for the docs-review source->doc path mapping.
 *
 * Covers the config-driven `mappings` path (docPathFromMappings), the
 * config parsing/precedence (readConfig), and guards the default
 * single-root behavior (sourceToDocPath) against regression.
 *
 * Plain console.log PASS/FAIL like the sibling lib/__tests__ scripts;
 * run directly with `node <this file>`. Exits non-zero if any assertion
 * fails so it can gate a verification run.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { docPathFromMappings, sourceToDocPath, readConfig } = require('../docs-review');

let failures = 0;
function check(name, got, expected) {
  let ok = true;
  try {
    assert.deepStrictEqual(got, expected);
  } catch (_e) {
    ok = false;
  }
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(expected)}`,
  );
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// config-driven mappings (portal: a frontend/ + backend/ monorepo)
// ---------------------------------------------------------------------------
const portal = [
  { sourceRoot: 'frontend/src/', docRoot: 'docs/frontend/' },
  { sourceRoot: 'backend/src/', docRoot: 'docs/backend/' },
];

check(
  'frontend .vue',
  docPathFromMappings('frontend/src/components/Foo.vue', portal),
  'docs/frontend/components/Foo.md',
);
check(
  'frontend .ts entry',
  docPathFromMappings('frontend/src/main.ts', portal),
  'docs/frontend/main.md',
);
check(
  'backend .js route',
  docPathFromMappings('backend/src/routes/user.js', portal),
  'docs/backend/routes/user.md',
);

// non-code extension under a watched root -> null (.html not in CODE_EXTS)
check(
  'frontend .html ignored',
  docPathFromMappings('frontend/src/static/index.html', portal),
  null,
);
// files outside every sourceRoot -> null
check('unmatched file', docPathFromMappings('README.md', portal), null);
check(
  'root-level src ignored under portal mappings',
  docPathFromMappings('src/x.ts', portal),
  null,
);

// sourceRoot given WITHOUT a trailing slash still matches
const noSlash = [{ sourceRoot: 'backend/src', docRoot: 'docs/backend' }];
check(
  'sourceRoot without trailing slash',
  docPathFromMappings('backend/src/lib/db.js', noSlash),
  'docs/backend/lib/db.md',
);

// first matching mapping wins (more specific root listed first)
const nested = [
  { sourceRoot: 'src/generated/', docRoot: 'docs/generated/' },
  { sourceRoot: 'src/', docRoot: 'docs/' },
];
check(
  'first match wins (specific root first)',
  docPathFromMappings('src/generated/api.ts', nested),
  'docs/generated/api.md',
);
check('falls through to general root', docPathFromMappings('src/app.ts', nested), 'docs/app.md');

// ---------------------------------------------------------------------------
// default single-root path (regression guard — must stay byte-for-byte)
// ---------------------------------------------------------------------------
check('default src->docs', sourceToDocPath('src/a/b.ts'), 'docs/a/b.md');
check('default non-src -> null', sourceToDocPath('lib/x.ts'), null);
check('default non-code ext -> null', sourceToDocPath('src/x.json'), null);

// ---------------------------------------------------------------------------
// readConfig shape handling (backward compatibility + new mappings key)
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-review-cfg-'));
function writeCfg(obj) {
  const p = path.join(tmpDir, 'cfg.json');
  fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

check('readConfig bare array (default mode)', readConfig(writeCfg(['src/'])), {
  patterns: ['src/'],
  mappings: null,
  stopBehavior: 'background',
});
check(
  'readConfig patterns object',
  readConfig(writeCfg({ stopBehavior: 'interactive', patterns: ['src/'] })),
  { patterns: ['src/'], mappings: null, stopBehavior: 'interactive' },
);
check(
  'readConfig mappings object',
  readConfig(writeCfg({ stopBehavior: 'background', mappings: portal })),
  { patterns: [], mappings: portal, stopBehavior: 'background' },
);
check(
  'readConfig malformed mappings -> null (degrade to default)',
  readConfig(writeCfg({ mappings: [{ sourceRoot: 'x' }, 'nope', {}] })).mappings,
  null,
);
check('readConfig missing file -> fallback', readConfig(path.join(tmpDir, 'nope.json')), {
  patterns: [],
  mappings: null,
  stopBehavior: 'background',
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nAll docs-review mapping tests passed.' : `\n${failures} test(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
