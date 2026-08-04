/**
 * Stop check: docs-review.
 *
 * When source files listed in
 *   .contramaestre/config/mustConsiderUpdatingDocs.json
 * were modified this session but their corresponding doc files under
 * docs/ were not touched, either:
 *
 *   - return a block requesting the LLM invoke the `reconcile-docs`
 *     skill in-session (stopBehavior = "interactive"), or
 *   - spawn a detached headless `claude -p` to do the reconciliation
 *     in the background and return null so the Stop completes cleanly
 *     (stopBehavior = "background", default).
 *
 * Contract (shared by all stop checks):
 *   module.exports = async function check(payload, ctx)
 *     -> { block: true, reason: string } | null | undefined
 *
 *   - Return `{block:true, reason}` to halt the stop and feed `reason`
 *     back to the model.
 *   - Return `null`/`undefined` to allow the stop.
 *   - Do NOT write to stdout — the dispatcher in handlers/stop.js owns
 *     stdout. Use stderr (via ctx.log) for diagnostics only.
 *
 * Bails silently when:
 *   - cwd is not inside a git working tree;
 *   - the watch list is empty;
 *   - no watched source files changed, or every gap was already nagged
 *     in this session (per-session dedup state).
 *
 * Source-to-doc convention:
 *   Default (no `mappings` configured): src/foo/bar.ts -> docs/foo/bar.md
 *   With `mappings` (opt-in, set in mustConsiderUpdatingDocs.json): each
 *   {sourceRoot, docRoot} pair maps sourceRoot-relative files into docRoot,
 *   e.g. {frontend/src/, docs/frontend/} sends
 *   frontend/src/components/Foo.vue -> docs/frontend/components/Foo.md. This
 *   lets one repo watch several source roots (e.g. a frontend/ + backend/
 *   monorepo) while single-root repos keep the default behavior untouched.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const BackgroundDispatcher = require('../lib/BackgroundDispatcher');

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.scala',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.cs', '.php', '.swift', '.m', '.mm',
  '.vue', '.svelte',
]);

// Tools the reconcile-docs skill needs in background mode. Mirrors the
// skill's allowed-tools frontmatter — the skill's list is a safety cap;
// this list is the per-spawn permission grant so the headless agent can
// actually run them without permission prompts (which would hang in a
// detached process).
const RECONCILE_DOCS_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(git diff *)',
  'Bash(git status *)',
  'Bash(git ls-files *)',
  'Bash(date +%F)',
];

module.exports = function docsReview(payload, ctx) {
  const projectDir = ctx.projectDir || (payload && payload.cwd) || process.cwd();

  if (!isInsideGitRepo(projectDir)) return null;

  const configPath = path.join(
    projectDir, '.contramaestre', 'config', 'mustConsiderUpdatingDocs.json'
  );
  const config = readConfig(configPath);
  if (!config.mappings && config.patterns.length === 0) return null;

  const changed = getModifiedFiles(projectDir);
  if (changed.length === 0) return null;

  const normChanged = changed.map((p) => p.replace(/\\/g, '/'));
  const changedSet = new Set(normChanged);

  const gaps = [];
  for (const file of normChanged) {
    // Multi-root repos configure explicit {sourceRoot, docRoot} mappings,
    // which fully determine both watched-ness and the doc path. Single-root
    // repos leave `mappings` unset and fall back to the default coarse
    // pattern filter + hardcoded src/ -> docs/ translation.
    let docPath;
    if (config.mappings) {
      docPath = docPathFromMappings(file, config.mappings);
    } else {
      if (!fileMatchesAny(file, config.patterns)) continue;
      docPath = sourceToDocPath(file);
    }
    if (!docPath) continue;
    if (changedSet.has(docPath)) continue;
    // Opt-in policy: only enforce existing doc mirrors. If the doc file
    // does not yet exist on disk, the source has not been documented
    // yet — staying silent here. Use the `generate-docs` skill to seed
    // an initial doc when the module warrants durable prose.
    if (!fs.existsSync(path.join(projectDir, docPath))) continue;
    gaps.push({ src: file, doc: docPath });
  }

  if (gaps.length === 0) return null;

  const sessionId = (payload && payload.session_id) || 'no-session';
  const stateFile = path.join(
    projectDir, '.contramaestre', '.state', `docs-nagged-${sanitize(sessionId)}.json`
  );
  const alreadyNagged = new Set(readJson(stateFile, []));
  const newGaps = gaps.filter((g) => !alreadyNagged.has(g.src));
  if (newGaps.length === 0) return null;

  // -------------------------------------------------------------------------
  // Background path (default). Spawn detached headless claude; main session
  // ends cleanly. On dispatch failure, fall back to interactive nag so we
  // don't silently swallow the gap.
  // -------------------------------------------------------------------------
  if (config.stopBehavior === 'background') {
    const dispatcher = new BackgroundDispatcher(projectDir, sessionId);
    const name =
      `docs-recon-${BackgroundDispatcher.sanitizeId(sessionId.slice(0, 8))}-` +
      Date.now().toString(36);
    const transcriptPath = (payload && payload.transcript_path) || null;
    const prompt = buildBackgroundPrompt(
      newGaps,
      dispatcher.getRepoContext(),
      sessionId,
      transcriptPath,
    );
    const result = dispatcher.dispatch(name, prompt, RECONCILE_DOCS_TOOLS);
    if (result.ok) {
      // Surface the dispatch in the master log so the user can see
      // "I just spawned a bg agent" in their session's timeline (the
      // matching `end` line is written by the sentinel on child exit).
      if (typeof ctx.masterLog === 'function') {
        ctx.masterLog(
          `BgDispatch:${name}`,
          `start pid=${result.pid != null ? result.pid : '?'} gaps=${newGaps.length}`,
        );
      }
      newGaps.forEach((g) => alreadyNagged.add(g.src));
      writeJson(stateFile, Array.from(alreadyNagged));
      return null;
    }
    process.stderr.write(
      `[docs-review] background dispatch failed (${result.error}); falling back to interactive\n`
    );
    // fall through to interactive
  }

  // -------------------------------------------------------------------------
  // Interactive path. Mark state and return the block message.
  // -------------------------------------------------------------------------
  newGaps.forEach((g) => alreadyNagged.add(g.src));
  writeJson(stateFile, Array.from(alreadyNagged));

  const list = newGaps
    .map((g) => `  - source: ${g.src}\n    doc:    ${g.doc}`)
    .join('\n');
  const reason =
    `The following source files were modified this session but their ` +
    `documentation counterparts were not touched:\n\n${list}\n\n` +
    `Invoke the \`reconcile-docs\` skill now to reconcile each pair. ` +
    `For trivial changes (renames, formatting, internal refactors), the ` +
    `skill instructs you to bump only the "Last updated:" line. For ` +
    `material changes, update the prose. Read the skill for the full ` +
    `decision table.`;

  return { block: true, reason };
};

// ---------------------------------------------------------------------------
// background prompt
// ---------------------------------------------------------------------------

function buildBackgroundPrompt(gaps, repoContext, sessionId, transcriptPath) {
  const pairList = gaps
    .map((g) => `  - ${g.src} → ${g.doc}`)
    .join('\n');

  const transcriptSection = transcriptPath
    ? (
        `\n\nSession transcript — REQUIRED reading (background mode only):\n\n` +
        `  ${transcriptPath}\n\n` +
        `Because this dispatch runs in a fresh Claude session, you do NOT ` +
        `share context with the agent that produced these changes. The ` +
        `transcript file is JSONL — one JSON object per line — containing ` +
        `the user's prompts and the previous agent's responses for this ` +
        `session. For each (source, doc) pair above, read the transcript ` +
        `entries that touched the source file to recover the *why* the ` +
        `code diff alone cannot show. Use that to inform the doc's "why", ` +
        `"constraints", and "gotchas" sections.\n\n` +
        `When consulting the transcript:\n` +
        `- Distill into third-person prose. Do NOT paste user prompts ` +
        `verbatim into the doc.\n` +
        `- Skip anything the user mentioned that's sensitive (API keys, ` +
        `internal hostnames, customer names, credential paths). The doc ` +
        `is version-controlled.\n` +
        `- If the transcript reveals rationale or alternatives the diff ` +
        `cannot show, use that — the doc will be meaningfully better ` +
        `than a code-only review.`
      )
    : '';

  return (
    `You are running as a background headless agent to reconcile ` +
    `documentation after a Claude Code session.\n\n` +
    `Triggered by session ${sessionId} at ${new Date().toISOString()}.${transcriptSection}\n\n` +
    `A previous session modified watched source files without updating ` +
    `their doc counterparts. Your task: invoke the \`reconcile-docs\` ` +
    `skill (.claude/skills/reconcile-docs/SKILL.md) and process exactly ` +
    `these (source, doc) pairs:\n\n${pairList}\n\n` +
    `Working-tree context:\n\n${repoContext}\n\n` +
    `Background-mode constraints:\n` +
    `- Do NOT commit your changes. Leave them as uncommitted modifications ` +
    `in the working directory; the user will review and commit separately.\n` +
    `- Follow the skill's decision table (material vs trivial vs ` +
    `deprecation). For uncertain cases, prefer the lighter action ` +
    `(typically a "Last updated:" bump).\n` +
    `- If a doc file does not yet exist, create it from the skill's ` +
    `template.\n` +
    `- Finish promptly. You cannot ask the user clarifying questions.`
  );
}

// ---------------------------------------------------------------------------
// config loading
// ---------------------------------------------------------------------------

function readConfig(file) {
  const fallback = { patterns: [], mappings: null, stopBehavior: 'background' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
  // Accept these shapes:
  //   [string, …]                                              bare array (patterns; default mode)
  //   { patterns: [string, …] }                                object form (patterns; default mode)
  //   { stopBehavior, patterns: […] }                          single-root (default)
  //   { stopBehavior, mappings: [{sourceRoot, docRoot}, …] }   multi-root (opt-in)
  // `patterns` and `mappings` may both appear; the check prefers `mappings`
  // when present. `mappings` is null unless at least one valid pair parses,
  // so a malformed or empty list degrades to the default pattern path.
  if (Array.isArray(raw)) {
    return {
      patterns: raw.filter((p) => typeof p === 'string' && p.trim()),
      mappings: null,
      stopBehavior: 'background',
    };
  }
  if (!raw || typeof raw !== 'object') return fallback;

  let stopBehavior = 'background';
  if (raw.stopBehavior === 'interactive' || raw.stopBehavior === 'background') {
    stopBehavior = raw.stopBehavior;
  }
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((p) => typeof p === 'string' && p.trim())
    : [];
  return { patterns, mappings: normalizeMappings(raw.mappings), stopBehavior };
}

// Validate and normalize the opt-in `mappings` list. Returns an array of
// {sourceRoot, docRoot} with both fields non-empty strings, or null when
// nothing usable is configured (which routes the check to the default path).
function normalizeMappings(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const sourceRoot = typeof m.sourceRoot === 'string' ? m.sourceRoot.trim() : '';
    const docRoot = typeof m.docRoot === 'string' ? m.docRoot.trim() : '';
    if (!sourceRoot || !docRoot) continue;
    out.push({ sourceRoot, docRoot });
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// git + path helpers (unchanged)
// ---------------------------------------------------------------------------

function isInsideGitRepo(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function getModifiedFiles(cwd) {
  const tracked = runGit(['diff', '--name-only', 'HEAD'], cwd);
  const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  const all = [
    ...((tracked || '').split('\n')),
    ...((untracked || '').split('\n')),
  ].map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(all));
}

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}

function fileMatchesAny(file, patterns) {
  for (const raw of patterns) {
    const trimmed = raw.replace(/[/\\]+$/, '');
    if (file === trimmed) return true;
    if (file.startsWith(trimmed + '/')) return true;
    if (/[*?[\]]/.test(trimmed) && globToRegExp(trimmed).test(file)) return true;
  }
  return false;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += '[' + body + ']';
        i = end;
      }
    } else if ('.+^$(){}|\\'.indexOf(c) !== -1) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

function sourceToDocPath(file) {
  if (!file.startsWith('src/')) return null;
  const ext = path.posix.extname(file);
  if (!CODE_EXTS.has(ext.toLowerCase())) return null;
  const tail = file.slice(4, -ext.length);
  return 'docs/' + tail + '.md';
}

// Config-driven variant of sourceToDocPath. Given the parsed `mappings`
// list, return the mirror doc path for the first mapping whose sourceRoot
// prefixes `file`, or null when no mapping matches or the file is not a
// recognized code file. Mappings are matched in order and the first match
// wins — list more specific roots first if any nest. Trailing slashes on
// both roots are normalized, so "frontend/src" and "frontend/src/" behave
// identically.
function docPathFromMappings(file, mappings) {
  for (const m of mappings) {
    const sourceRoot = m.sourceRoot.replace(/[/\\]+$/, '') + '/';
    if (!file.startsWith(sourceRoot)) continue;
    const ext = path.posix.extname(file);
    if (!CODE_EXTS.has(ext.toLowerCase())) return null;
    const tail = file.slice(sourceRoot.length, -ext.length);
    const docRoot = m.docRoot.replace(/[/\\]+$/, '');
    return (docRoot ? docRoot + '/' : '') + tail + '.md';
  }
  return null;
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

// Exposed for unit tests only; the router invokes the default export above.
module.exports.docPathFromMappings = docPathFromMappings;
module.exports.sourceToDocPath = sourceToDocPath;
module.exports.readConfig = readConfig;
