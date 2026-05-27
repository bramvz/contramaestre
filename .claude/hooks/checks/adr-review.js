/**
 * Stop check: adr-review.
 *
 * When the session's changes look substantial — either many files
 * changed, many lines changed, or any file in an architecturally
 * sensitive area touched — and no ADR was added or updated, return a
 * block prompting the LLM to invoke the `adr-log` skill.
 *
 * Config lives at .claude/hooks/config/adrTriggers.json. See the file
 * for the full shape; key knobs:
 *   adrLocations.logFile     - single-file ADR ledger (or null)
 *   adrLocations.perFileGlob - per-file ADR glob     (or null)
 *   substantiality.minFilesChanged
 *   substantiality.minLinesChanged
 *   substantiality.triggerPaths
 *   substantiality.excludeFromLineCount
 *   substantiality.mode      - "either" (volume OR trigger) | "both"
 *
 * The dispatcher in handlers/stop.js owns stdout, owns `stop_hook_active`,
 * and aggregates this reason with any others. We just return
 * {block, reason} | null.
 *
 * Bails silently when:
 *   - cwd is not inside a git working tree;
 *   - the config file is missing or malformed;
 *   - no files changed;
 *   - the substantiality predicate is not met;
 *   - an ADR was already touched this session;
 *   - this gap was already nagged this session.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const BackgroundDispatcher = require('../lib/BackgroundDispatcher');

// Tools the adr-log skill needs in background mode. Mirrors the skill's
// allowed-tools frontmatter — the skill's list is a safety cap; this
// list is the per-spawn permission grant so the headless agent can
// actually run these commands without permission prompts (which would
// hang in a detached process).
const ADR_LOG_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(date +%F)',
  'Bash(mkdir -p docs/adr docs/project_notes)',
  'Bash(git add docs/adr/*)',
  'Bash(git add docs/project_notes/decisions.md)',
];

module.exports = function adrReview(payload, ctx) {
  const projectDir = ctx.projectDir || (payload && payload.cwd) || process.cwd();
  if (!isInsideGitRepo(projectDir)) return null;

  const config = readJson(
    path.join(projectDir, '.claude', 'hooks', 'config', 'adrTriggers.json'),
    null
  );
  if (!config) return null;

  const stopBehavior = config.stopBehavior === 'interactive' ? 'interactive' : 'background';

  const changed = getModifiedFiles(projectDir);
  if (changed.length === 0) return null;

  const sub = config.substantiality || {};
  const exclude = sub.excludeFromLineCount || [];
  const triggers = sub.triggerPaths || [];

  const hitTriggers = changed.filter((f) => fileMatchesAny(f, triggers));
  const hasTrigger = hitTriggers.length > 0;

  const lineDelta = getLineDelta(projectDir, changed, exclude);
  const hasVolume =
    changed.length >= (sub.minFilesChanged || Infinity) ||
    lineDelta >= (sub.minLinesChanged || Infinity);

  const substantial = sub.mode === 'both'
    ? (hasTrigger && hasVolume)
    : (hasTrigger || hasVolume);
  if (!substantial) return null;

  if (isAdrTouched(changed, config.adrLocations || {})) return null;

  // Multi-turn dedup: stored.triggerFiles is the union of trigger paths
  // nagged about so far this session. Re-nag only when a NEW trigger path
  // appears (architectural surface expanded). If the first nag fired
  // purely on volume (no triggers) and turn N has no new triggers either,
  // stay silent. Loop safety inside a single stop chain is provided by
  // the dispatcher's stop_hook_active guard.
  const sessionId = (payload && payload.session_id) || 'no-session';
  const stateFile = path.join(
    projectDir, '.claude', '.state', `adr-nagged-${sanitize(sessionId)}.json`
  );
  const stored = readJson(stateFile, null);
  const alreadyNaggedTriggers = new Set(
    stored && Array.isArray(stored.triggerFiles) ? stored.triggerFiles : []
  );
  const everNagged = !!(stored && stored.at);
  const hasNewTrigger = hitTriggers.some((f) => !alreadyNaggedTriggers.has(f));
  if (everNagged && !hasNewTrigger) return null;

  const triggerSummary = hitTriggers.length
    ? `  - trigger paths touched: ${hitTriggers.slice(0, 8).join(', ')}` +
      (hitTriggers.length > 8 ? ` (+${hitTriggers.length - 8} more)` : '')
    : '  - no trigger paths matched';

  // -------------------------------------------------------------------------
  // Background path (default). Spawn detached headless claude; main session
  // ends cleanly. Fall back to interactive on dispatch failure.
  // -------------------------------------------------------------------------
  if (stopBehavior === 'background') {
    const dispatcher = new BackgroundDispatcher(projectDir, sessionId);
    const name =
      `adr-log-${BackgroundDispatcher.sanitizeId(sessionId.slice(0, 8))}-` +
      Date.now().toString(36);
    const summary = {
      filesChanged: changed.length,
      lineDelta,
      hitTriggers,
    };
    const transcriptPath = (payload && payload.transcript_path) || null;
    const prompt = buildBackgroundPrompt(
      summary,
      dispatcher.getRepoContext(),
      sessionId,
      transcriptPath,
    );
    const result = dispatcher.dispatch(name, prompt, ADR_LOG_TOOLS);
    if (result.ok) {
      // Surface the dispatch in the master log so the user can see
      // "I just spawned a bg agent" in their session's timeline (the
      // matching `end` line is written by the sentinel on child exit).
      if (typeof ctx.masterLog === 'function') {
        ctx.masterLog(
          `BgDispatch:${name}`,
          `start pid=${result.pid != null ? result.pid : '?'} files=${changed.length} delta=${lineDelta}`,
        );
      }
      writeJson(stateFile, {
        at: new Date().toISOString(),
        mode: 'background',
        triggerFiles: Array.from(new Set([...alreadyNaggedTriggers, ...hitTriggers])),
      });
      return null;
    }
    process.stderr.write(
      `[adr-review] background dispatch failed (${result.error}); falling back to interactive\n`
    );
    // fall through to interactive
  }

  // -------------------------------------------------------------------------
  // Interactive path.
  // -------------------------------------------------------------------------
  writeJson(stateFile, {
    at: new Date().toISOString(),
    mode: 'interactive',
    triggerFiles: Array.from(new Set([...alreadyNaggedTriggers, ...hitTriggers])),
  });

  const reason =
    `This session looks architecturally substantial:\n` +
    `  - ${changed.length} file(s) changed\n` +
    `  - ${lineDelta} line(s) added/deleted (excluding lockfiles/generated)\n` +
    `${triggerSummary}\n\n` +
    `No ADR was added or updated this session. Invoke the \`adr-log\` ` +
    `skill to record the decision in the 4-field format (Context / ` +
    `Decision / Alternatives Considered / Consequences).\n\n` +
    `If the change does NOT warrant an ADR (e.g., dev-tooling dependency ` +
    `bump, internal refactor with no future-binding implications, pure ` +
    `bug fix), say so explicitly in your response and skip the skill. The ` +
    `user sees your reasoning either way.`;

  return { block: true, reason };
};

// ---------------------------------------------------------------------------
// background prompt
// ---------------------------------------------------------------------------

function buildBackgroundPrompt(summary, repoContext, sessionId, transcriptPath) {
  const triggerLine = summary.hitTriggers.length
    ? `  - trigger paths touched: ${summary.hitTriggers.slice(0, 8).join(', ')}` +
      (summary.hitTriggers.length > 8 ? ` (+${summary.hitTriggers.length - 8} more)` : '')
    : `  - no trigger paths matched`;

  const transcriptSection = transcriptPath
    ? (
        `\n\nSession transcript — REQUIRED reading (background mode only):\n\n` +
        `  ${transcriptPath}\n\n` +
        `Because this dispatch runs in a fresh Claude session, you do NOT ` +
        `share context with the agent that produced these changes. The ` +
        `transcript file is JSONL — one JSON object per line — containing ` +
        `the user's prompts and the previous agent's responses for this ` +
        `session. Read it to recover the *why*, *alternatives considered*, ` +
        `and *trade-offs* — the information the ADR template requires that ` +
        `the code diff alone cannot reveal.\n\n` +
        `When consulting the transcript:\n` +
        `- Distill into third-person prose for the ADR. Do NOT paste user ` +
        `prompts verbatim.\n` +
        `- Skip anything sensitive (API keys, internal hostnames, customer ` +
        `names, credential paths). ADRs are version-controlled.\n` +
        `- Use the transcript as your PRIMARY source for the "why" / ` +
        `"Alternatives" / "Consequences" sections; fall back to "**Needs ` +
        `review:**" markers ONLY if the transcript also lacks the answer.`
      )
    : '';

  // Without a transcript we have nothing better than the diff; tell the agent
  // to use the "Needs review:" escape hatch instead of inventing intent.
  const noTranscriptCaveat = transcriptPath
    ? ''
    : (
        `\n- You cannot ask the user clarifying questions and have no ` +
        `transcript to consult. If essential rationale, alternatives, or ` +
        `trade-offs cannot be inferred from the diff alone, write the ADR ` +
        `with explicit "**Needs review:** …" markers in those fields rather ` +
        `than inventing intent.`
      );

  return (
    `You are running as a background headless agent to consider an ` +
    `Architectural Decision Record after a Claude Code session whose ` +
    `changes look substantial.\n\n` +
    `Triggered by session ${sessionId} at ${new Date().toISOString()}.${transcriptSection}\n\n` +
    `Substantiality summary:\n` +
    `  - ${summary.filesChanged} file(s) changed\n` +
    `  - ${summary.lineDelta} line(s) added/deleted (excluding lockfiles/generated)\n` +
    `${triggerLine}\n\n` +
    `Working-tree context:\n\n${repoContext}\n\n` +
    `Your task: invoke the \`adr-log\` skill ` +
    `(.claude/skills/adr-log/SKILL.md), decide whether an ADR is ` +
    `warranted, and if so, write it.\n\n` +
    `Background-mode constraints:` + noTranscriptCaveat + `\n` +
    `- Set Status to "Proposed" (NOT "Accepted") — the user reviews and ` +
    `finalizes.\n` +
    `- Add a one-line note to the ADR Context: "Generated by background ` +
    `agent based on diff inspection${transcriptPath ? ' + transcript' : ''}."\n` +
    `- If the changes do NOT warrant an ADR per the skill's decision ` +
    `rules, skip writing the ADR and instead record your reasoning to ` +
    `.claude/.state/adr-skipped-${sanitize(sessionId)}.md.\n` +
    `- Do NOT commit your changes. Leave them as uncommitted ` +
    `modifications in the working directory.`
  );
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

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

function getLineDelta(cwd, changed, exclude) {
  let total = 0;

  // Tracked changes: per-file insertions + deletions via --numstat.
  const numstat = runGit(['diff', 'HEAD', '--numstat'], cwd) || '';
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    if (add === '-' || del === '-') continue; // binary
    const file = rest.join('\t').replace(/\\/g, '/');
    if (fileMatchesAny(file, exclude)) continue;
    total += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
  }

  // Untracked files: count lines directly.
  const trackedSet = new Set(
    (runGit(['diff', '--name-only', 'HEAD'], cwd) || '')
      .split('\n').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
  );
  for (const f of changed) {
    if (trackedSet.has(f)) continue;
    if (fileMatchesAny(f, exclude)) continue;
    try {
      const content = fs.readFileSync(path.join(cwd, f), 'utf8');
      total += content.length === 0 ? 0 : content.split('\n').length;
    } catch (_e) {
      // unreadable / binary / missing — skip
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// path / glob matching
// ---------------------------------------------------------------------------

function fileMatchesAny(file, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const raw of patterns) {
    const trimmed = String(raw).replace(/[/\\]+$/, '');
    if (file === trimmed) return true;
    if (file.startsWith(trimmed + '/')) return true;
    if (/[*?[\]{}]/.test(trimmed) && globToRegExp(trimmed).test(file)) return true;
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
      // Character class: glob [abc] / [0-9] / [!a-z] is valid regex
      // (with ! -> ^ for negation). Copy through to the matching ].
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        let body = glob.slice(i + 1, end);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += '[' + body + ']';
        i = end;
      }
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        const opts = glob.slice(i + 1, end).split(',')
          .map((o) => o.replace(/[.+^$(){}|[\]\\]/g, '\\$&'));
        re += '(?:' + opts.join('|') + ')';
        i = end;
      }
    } else if ('.+^$()|\\'.indexOf(c) !== -1) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

/**
 * The ADR workflow writes BOTH a per-file ADR and a ledger entry. Gap is
 * only suppressed when every configured location was touched this
 * session — touching only one means the LLM did half the job and we
 * still want to nag. Locations that aren't configured count as already
 * satisfied so the predicate degrades sensibly if a team only uses one
 * convention.
 */
function isAdrTouched(changed, adrLocations) {
  const changedSet = new Set(changed);

  let ledgerSatisfied = !adrLocations.logFile;
  if (adrLocations.logFile && changedSet.has(adrLocations.logFile)) {
    ledgerSatisfied = true;
  }

  let perFileSatisfied = !adrLocations.perFileGlob;
  if (adrLocations.perFileGlob) {
    const re = globToRegExp(adrLocations.perFileGlob);
    if (changed.some((f) => re.test(f))) perFileSatisfied = true;
  }

  return ledgerSatisfied && perFileSatisfied;
}

// ---------------------------------------------------------------------------
// state / io
// ---------------------------------------------------------------------------

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
