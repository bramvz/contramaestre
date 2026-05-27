/**
 * Stop check: format.
 *
 * Runs prettier (--write) and eslint (--fix) on every file changed this
 * session whose content has changed since the last format. Batched into
 * one invocation per tool. Invoked via `npx --no-install <tool>` to
 * sidestep platform shim quirks (node_modules/.bin/<tool> requires
 * `.cmd` on Windows; `npx` handles the platform difference itself).
 *
 * Multi-turn dedup: state file stores a map of {filePath: sha256-hash}
 * recorded after each successful format. On every fresh Stop, files
 * whose current content matches their stored hash are skipped; files
 * with no stored hash or different content are formatted. New turns
 * with new edits re-run automatically. Loop safety inside a single
 * stop chain is provided by the dispatcher's `stop_hook_active` guard.
 *
 * Bails silently when:
 *   - cwd is not inside a git working tree;
 *   - neither prettier nor eslint is installed under node_modules/;
 *   - no formattable files changed since the last format.
 *
 * Returns a block only when `eslint --fix` exits non-zero — i.e., real
 * lint errors that auto-fix could not resolve. The aggregating
 * dispatcher surfaces the stderr so Claude can address them. Files
 * with un-auto-fixable errors are NOT marked as formatted, so they
 * are re-attempted on the next turn.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FORMATTABLE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.json', '.jsonc',
  '.css', '.scss', '.less',
  '.html', '.vue', '.svelte',
  '.md', '.mdx',
  '.yml', '.yaml',
]);

const ESLINT_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
]);

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

module.exports = function format(payload, ctx) {
  const projectDir = ctx.projectDir || (payload && payload.cwd) || process.cwd();

  if (!isInsideGitRepo(projectDir)) return null;

  const hasPrettier = fs.existsSync(
    path.join(projectDir, 'node_modules', 'prettier', 'package.json')
  );
  const hasEslint = fs.existsSync(
    path.join(projectDir, 'node_modules', 'eslint', 'package.json')
  );
  if (!hasPrettier && !hasEslint) return null;

  const sessionId = (payload && payload.session_id) || 'no-session';
  const stateFile = path.join(
    projectDir, '.claude', '.state', `format-ran-${sanitize(sessionId)}.json`
  );
  const formattedHashes = readJson(stateFile, {}) || {};

  const candidates = getModifiedFiles(projectDir)
    .filter((f) => FORMATTABLE_EXTS.has(path.posix.extname(f).toLowerCase()))
    .filter((f) => fs.existsSync(path.join(projectDir, f))); // skip deleted files
  if (candidates.length === 0) return null;

  // Per-file dedup: only format files whose CURRENT content differs from
  // the last-recorded post-format hash. Files unchanged since last run
  // are skipped. New edits (or new files) flow through. Loop safety
  // within a single stop chain is the dispatcher's job (stop_hook_active).
  const todo = candidates.filter((f) => {
    const h = hashFileContent(path.join(projectDir, f));
    return h !== null && h !== formattedHashes[f];
  });
  if (todo.length === 0) return null;

  if (hasPrettier) {
    runTool(NPX, ['--no-install', 'prettier', '--write', '--log-level=warn', ...todo], projectDir);
  }

  let eslintBlock = null;
  if (hasEslint) {
    const jsFiles = todo.filter((f) => ESLINT_EXTS.has(path.posix.extname(f).toLowerCase()));
    if (jsFiles.length > 0) {
      const r = runTool(NPX, ['--no-install', 'eslint', '--fix', ...jsFiles], projectDir);
      if (r && r.status !== 0 && r.status !== null) {
        const stderr = (r.stderr || '').toString().trim();
        const stdout = (r.stdout || '').toString().trim();
        const detail = [stdout, stderr].filter(Boolean).join('\n').slice(0, 4000);
        eslintBlock = {
          block: true,
          reason:
            `ESLint --fix could not auto-resolve all issues in ` +
            `${jsFiles.length} file(s) modified this session. ` +
            `Review the errors below and fix them before stopping:\n\n` +
            (detail || '(no diagnostic output captured)'),
        };
      }
    }
  }

  if (eslintBlock) {
    // Don't record post-format hashes — files with un-auto-fixable errors
    // must be re-attempted on the next turn. The dispatcher's
    // stop_hook_active guard prevents looping within a single stop chain.
    return eslintBlock;
  }

  // Success: record post-format hashes so unchanged files skip next turn.
  const newMap = { ...formattedHashes };
  for (const f of todo) {
    const h = hashFileContent(path.join(projectDir, f));
    if (h !== null) newMap[f] = h;
  }
  writeJson(stateFile, newMap);
  return null;
};

function hashFileContent(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch (_e) {
    return null;
  }
}

function isInsideGitRepo(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function getModifiedFiles(cwd) {
  const tracked = runGit(['diff', '--name-only', 'HEAD'], cwd);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  const all = [
    ...((tracked || '').split('\n')),
    ...((untracked || '').split('\n')),
  ].map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  return Array.from(new Set(all));
}

function runTool(cmd, args, cwd) {
  return spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 60000,
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_e) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}
