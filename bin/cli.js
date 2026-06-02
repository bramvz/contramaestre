#!/usr/bin/env node
/**
 * contramaestre installer CLI.
 *
 * Invoked automatically as `postinstall` when a consumer adds contramaestre as
 * a dev dependency, or manually via `npx contramaestre init [--force] [--verbose]`.
 *
 * Lays down two trees in the consumer's project root:
 *
 *   - .claude/
 *       settings.json   — Claude Code's hook registration. Preserved if the
 *                         consumer already has one (use --force to overwrite).
 *       skills/         — Claude Code's skill discovery path. Always preserve;
 *                         skills are entirely consumer-customizable prose.
 *
 *   - .contramaestre/
 *       Hook runtime: router, handlers, checks, lib, configs.
 *       Per-path overwrite policy:
 *         overwrite (consumer must NOT edit):
 *           hooks/router.js, hooks/handlers/**, hooks/checks/**,
 *           hooks/lib/**, hooks/README.md, config/conditionalTools.md,
 *           hooks/logs/.gitignore
 *         preserve (copy only if not present — consumer customizes):
 *           config/*.json
 *         skip entirely (per-consumer runtime state):
 *           .state/, hooks/logs/*.log
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
const SRC_CONTRA = path.join(PKG_ROOT, '.contramaestre');
const SRC_SETTINGS = path.join(PKG_ROOT, '.claude', 'settings.json');
const SRC_SKILLS = path.join(PKG_ROOT, '.claude', 'skills');
const CONSUMER_ROOT = process.env.INIT_CWD || process.cwd();
const DEST_CONTRA = path.join(CONSUMER_ROOT, '.contramaestre');
const DEST_SETTINGS = path.join(CONSUMER_ROOT, '.claude', 'settings.json');
const DEST_SKILLS = path.join(CONSUMER_ROOT, '.claude', 'skills');

const args = process.argv.slice(2);
const cmd = args[0] || 'init';
const FORCE = args.includes('--force');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function help() {
  process.stdout.write(`\ncontramaestre — Claude Code scaffolding installer\n\nUsage:\n  contramaestre init [--force] [--verbose]\n  contramaestre help\n\nBy default the installer:\n  - OVERWRITES application code (router.js, handlers/*, checks/*, lib/*) in\n    .contramaestre/.\n  - PRESERVES configs (.contramaestre/config/*.json), .claude/settings.json,\n    and skills (.claude/skills/**) if they already exist.\n  - SKIPS .contramaestre/.state/ and .contramaestre/hooks/logs/*.log (per-consumer\n    runtime state).\n\nFlags:\n  --force      Also overwrite preserved files (configs, skills,\n               settings.json). Use after a major upgrade.\n  --verbose    Print every action.\n\nThis CLI also runs automatically as postinstall when contramaestre is added\nas a dev dependency. Set CLAUDE_CONTRAMAESTRE_SKIP_POSTINSTALL=1 to opt out\nof that without uninstalling.\n`);
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

if (!fs.existsSync(SRC_CONTRA)) {
  process.stderr.write('[contramaestre] missing .contramaestre/ in package; nothing to install\n');
  process.exit(0);
}

const counts = { created: 0, overwritten: 0, preserved: 0, skipped: 0 };
const issues = [];

/**
 * Decide what to do with a path relative to `.contramaestre/`.
 * Returns 'overwrite' | 'preserve' | 'skip'.
 */
function classifyContra(relPath) {
  // Per-consumer runtime state — never copy.
  if (relPath === '.state' || relPath.startsWith('.state/')) return 'skip';
  if (
    (relPath === 'hooks/logs' || relPath.startsWith('hooks/logs/')) &&
    path.basename(relPath) !== '.gitignore'
  ) {
    return 'skip';
  }
  // Consumer-owned config — keep their customizations.
  if (relPath.startsWith('config/') && relPath.endsWith('.json')) return 'preserve';
  // Everything else is application code or shared docs: always overwrite.
  return 'overwrite';
}

// Skills are entirely consumer-customizable prose; always preserve.
const classifySkills = () => 'preserve';

function walk(srcDir, destDir, label, classify, rel = '') {
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
      if (VERBOSE) process.stdout.write(`  skip   ${label}/${childRel}${entry.isDirectory() ? '/' : ''}\n`);
      continue;
    }

    if (entry.isDirectory()) {
      try { fs.mkdirSync(dest, { recursive: true }); }
      catch (err) { issues.push(`mkdir ${dest}: ${err.message}`); continue; }
      walk(src, dest, label, classify, childRel);
    } else if (entry.isFile()) {
      const exists = fs.existsSync(dest);
      const shouldWrite =
        decision === 'overwrite' ||
        (decision === 'preserve' && (!exists || FORCE));

      if (!shouldWrite) {
        counts.preserved++;
        if (VERBOSE) process.stdout.write(`  keep   ${label}/${childRel}  (existing preserved)\n`);
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
        if (VERBOSE) process.stdout.write(`  write  ${label}/${childRel}  (overwrite)\n`);
      } else {
        counts.created++;
        if (VERBOSE) process.stdout.write(`  write  ${label}/${childRel}  (created)\n`);
      }
    }
  }
}

try {
  walk(SRC_CONTRA, DEST_CONTRA, '.contramaestre', classifyContra);
} catch (err) {
  issues.push(`walk .contramaestre: ${err && err.stack ? err.stack : err}`);
}

// Skills live under .claude/skills/ because Claude Code only discovers
// skills at .claude/skills/<name>/SKILL.md (project) or ~/.claude/skills/
// (user). They are entirely consumer-customizable; preserve on re-install.
try {
  if (fs.existsSync(SRC_SKILLS)) {
    walk(SRC_SKILLS, DEST_SKILLS, '.claude/skills', classifySkills);
  }
} catch (err) {
  issues.push(`walk .claude/skills: ${err && err.stack ? err.stack : err}`);
}

// Lay down .claude/settings.json — single file, preserved if the consumer
// already has one (use --force to overwrite). This is the only file Claude
// Code itself reads to discover the hook registration.
try {
  if (fs.existsSync(SRC_SETTINGS)) {
    const exists = fs.existsSync(DEST_SETTINGS);
    if (!exists || FORCE) {
      fs.mkdirSync(path.dirname(DEST_SETTINGS), { recursive: true });
      fs.copyFileSync(SRC_SETTINGS, DEST_SETTINGS);
      if (exists) {
        counts.overwritten++;
        if (VERBOSE) process.stdout.write('  write  .claude/settings.json  (overwrite)\n');
      } else {
        counts.created++;
        if (VERBOSE) process.stdout.write('  write  .claude/settings.json  (created)\n');
      }
    } else {
      counts.preserved++;
      if (VERBOSE) process.stdout.write('  keep   .claude/settings.json  (existing preserved)\n');
    }
  }
} catch (err) {
  issues.push(`copy settings.json: ${err.message}`);
}

// Append a managed block to the consumer's .gitignore that ignores all of
// .contramaestre/ except its config/ subdirectory. Idempotent: the block is
// bracketed with sentinel comments, so re-installs see the marker and skip.
// If the consumer wants to drop the block they can delete it manually; we
// never replace or rewrite an existing block.
try {
  const gitignorePath = path.join(CONSUMER_ROOT, '.gitignore');
  const GI_HEADER = '# >>> contramaestre (managed block — delete to opt out) >>>';
  const GI_FOOTER = '# <<< contramaestre <<<';
  const GI_BODY = [
    GI_HEADER,
    '/.contramaestre/**',
    '!/.contramaestre/config/',
    '!/.contramaestre/config/**',
    GI_FOOTER,
    '',
  ].join('\n');

  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, 'utf8')
    : '';
  if (existing.includes(GI_HEADER)) {
    if (VERBOSE) process.stdout.write('  keep   .gitignore  (managed block already present)\n');
  } else {
    const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignorePath, `${existing}${sep}${existing.length ? '\n' : ''}${GI_BODY}`);
    if (VERBOSE) process.stdout.write('  append .gitignore  (contramaestre block)\n');
  }
} catch (err) {
  issues.push(`update .gitignore: ${err.message}`);
}

// Always enable the hook router on the consumer side. The shipped
// router.json defaults masterSwitch to false so the router stays inert
// inside this repo; consumers explicitly opt in by installing the package.
try {
  const routerCfgPath = path.join(DEST_CONTRA, 'config', 'router.json');
  let cfg = {};
  if (fs.existsSync(routerCfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(routerCfgPath, 'utf8')); }
    catch (_e) { cfg = {}; }
  }
  cfg.masterSwitch = true;
  fs.mkdirSync(path.dirname(routerCfgPath), { recursive: true });
  fs.writeFileSync(routerCfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  if (VERBOSE) process.stdout.write('  write  .contramaestre/config/router.json  (masterSwitch=true)\n');
} catch (err) {
  issues.push(`enable router: ${err.message}`);
}

const summary =
  `created=${counts.created} overwritten=${counts.overwritten} ` +
  `preserved=${counts.preserved} skipped=${counts.skipped}`;
process.stdout.write(
  `[contramaestre] init -> ${DEST_CONTRA} + ${DEST_SETTINGS} + ${DEST_SKILLS}  (${summary})\n`,
);

if (issues.length > 0) {
  process.stderr.write(`[contramaestre] ${issues.length} issue(s) during install:\n`);
  for (const m of issues) process.stderr.write(`  - ${m}\n`);
}

// Never block npm install — exit 0 even on errors.
process.exit(0);
