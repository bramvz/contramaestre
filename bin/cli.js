#!/usr/bin/env node
/**
 * contramaestre installer CLI.
 *
 * Invoked automatically as `postinstall` when a consumer adds contramaestre as
 * a dev dependency, or manually via `npx contramaestre init [--force] [--verbose]`.
 *
 * Copies `.claude/` from the package into the consumer's project root
 * with a per-path overwrite policy:
 *
 *   - overwrite (always copy from package — consumer must NOT edit these):
 *       hooks/router.js
 *       hooks/handlers/**
 *       hooks/checks/**
 *       hooks/lib/**
 *       hooks/README.md
 *       hooks/config/conditionalTools.md   (schema reference doc)
 *       hooks/logs/.gitignore
 *
 *   - preserve (copy only if not present — consumer customizes):
 *       settings.json
 *       hooks/config/*.json
 *       skills/**
 *
 *   - skip entirely (per-consumer runtime state, never copy):
 *       .state/
 *       hooks/logs/*.log
 *
 * Self-install guard: when this script is invoked during `npm install`
 * inside the contramaestre repo itself (developing the scaffold), the CLI
 * detects PKG_ROOT === CONSUMER_ROOT and exits silently.
 *
 * Never throws past the top level — postinstall errors must not block
 * the consumer's install. Errors are written to stderr; exit is always 0.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_CLAUDE = path.join(PKG_ROOT, '.claude');
const CONSUMER_ROOT = process.env.INIT_CWD || process.cwd();
const DEST_CLAUDE = path.join(CONSUMER_ROOT, '.claude');

const args = process.argv.slice(2);
const cmd = args[0] || 'init';
const FORCE = args.includes('--force');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function help() {
  process.stdout.write(`\ncontramaestre — Claude Code scaffolding installer\n\nUsage:\n  contramaestre init [--force] [--verbose]\n  contramaestre help\n\nBy default the installer:\n  - OVERWRITES application code (router.js, handlers/*, checks/*, lib/*).\n  - PRESERVES configs (.claude/hooks/config/*.json), settings.json, and\n    skills (.claude/skills/**) if they already exist.\n  - SKIPS .claude/.state/ and .claude/hooks/logs/*.log (per-consumer\n    runtime state).\n\nFlags:\n  --force      Also overwrite preserved files (configs, skills,\n               settings.json). Use after a major upgrade.\n  --verbose    Print every action.\n\nThis CLI also runs automatically as postinstall when contramaestre is added\nas a dev dependency. Set CLAUDE_CONTRAMAESTRE_SKIP_POSTINSTALL=1 to opt out\nof that without uninstalling.\n`);
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  help();
  process.exit(0);
}

if (cmd !== 'init') {
  process.stderr.write(`[contramaestre] unknown command: ${cmd}\n`);
  help();
  process.exit(0);
}

// Opt-out hatch for consumers who want the package but not the auto-init.
if (process.env.CLAUDE_CONTRAMAESTRE_SKIP_POSTINSTALL === '1') {
  if (VERBOSE) process.stderr.write('[contramaestre] postinstall skipped via CLAUDE_CONTRAMAESTRE_SKIP_POSTINSTALL=1\n');
  process.exit(0);
}

// Self-install guard: don't run when developing the scaffolding repo itself.
if (path.resolve(PKG_ROOT) === path.resolve(CONSUMER_ROOT)) {
  if (VERBOSE) process.stderr.write('[contramaestre] in-package install detected; skipping init\n');
  process.exit(0);
}

if (!fs.existsSync(SRC_CLAUDE)) {
  process.stderr.write('[contramaestre] missing .claude/ in package; nothing to install\n');
  process.exit(0);
}

const counts = { created: 0, overwritten: 0, preserved: 0, skipped: 0 };
const issues = [];

/**
 * Decide what to do with a path relative to `.claude/`.
 * Returns 'overwrite' | 'preserve' | 'skip'.
 */
function classify(relPath) {
  // Per-consumer runtime state — never copy.
  if (relPath === '.state' || relPath.startsWith('.state/')) return 'skip';
  if (
    (relPath === 'hooks/logs' || relPath.startsWith('hooks/logs/')) &&
    path.basename(relPath) !== '.gitignore'
  ) {
    return 'skip';
  }
  // Consumer-owned config — keep their customizations.
  if (relPath.startsWith('hooks/config/') && relPath.endsWith('.json')) return 'preserve';
  // Consumer-owned settings — they may add other hooks.
  if (relPath === 'settings.json') return 'preserve';
  // Skills contain prose the consumer may customize.
  if (relPath.startsWith('skills/')) return 'preserve';
  // Everything else is application code or shared docs: always overwrite.
  return 'overwrite';
}

function walk(srcDir, destDir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    issues.push(`readdir ${srcDir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    const decision = classify(childRel);

    if (decision === 'skip') {
      counts.skipped++;
      if (VERBOSE) process.stdout.write(`  skip   .claude/${childRel}${entry.isDirectory() ? '/' : ''}\n`);
      continue;
    }

    if (entry.isDirectory()) {
      try { fs.mkdirSync(dest, { recursive: true }); }
      catch (err) { issues.push(`mkdir ${dest}: ${err.message}`); continue; }
      walk(src, dest, childRel);
    } else if (entry.isFile()) {
      const exists = fs.existsSync(dest);
      const shouldWrite =
        decision === 'overwrite' ||
        (decision === 'preserve' && (!exists || FORCE));

      if (!shouldWrite) {
        counts.preserved++;
        if (VERBOSE) process.stdout.write(`  keep   .claude/${childRel}  (existing preserved)\n`);
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch (err) {
        issues.push(`copy ${src} -> ${dest}: ${err.message}`);
        continue;
      }
      if (exists) {
        counts.overwritten++;
        if (VERBOSE) process.stdout.write(`  write  .claude/${childRel}  (overwrite)\n`);
      } else {
        counts.created++;
        if (VERBOSE) process.stdout.write(`  write  .claude/${childRel}  (created)\n`);
      }
    }
  }
}

try {
  walk(SRC_CLAUDE, DEST_CLAUDE);
} catch (err) {
  issues.push(`walk: ${err && err.stack ? err.stack : err}`);
}

const summary =
  `created=${counts.created} overwritten=${counts.overwritten} ` +
  `preserved=${counts.preserved} skipped=${counts.skipped}`;
process.stdout.write(`[contramaestre] init -> ${DEST_CLAUDE}  (${summary})\n`);

if (issues.length > 0) {
  process.stderr.write(`[contramaestre] ${issues.length} issue(s) during install:\n`);
  for (const m of issues) process.stderr.write(`  - ${m}\n`);
}

// Never block npm install — exit 0 even on errors.
process.exit(0);
