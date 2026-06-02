'use strict';

/**
 * BgBusyGuard — detect whether any background `claude -p` dispatch is still
 * in flight, so PreToolUse can defer a `git commit` / `git push` / `gh pr
 * create|merge` until they finish.
 *
 * Why this exists:
 *   - BackgroundDispatcher fires detached `claude -p` agents from Stop checks
 *     (docs-review, adr-review). Those agents write to the working tree but
 *     are told NOT to commit. If the main session pushes mid-write, the
 *     pushed commit excludes the bg writes (best case) or includes
 *     half-written files (if `git add .` was used). Either way the user is
 *     surprised.
 *   - This guard adds a coarse "wait for bg to finish" gate in front of
 *     commit/push tool calls.
 *
 * In-flight detection:
 *   The dispatch-log JSONL records every dispatch with pid + start time. We
 *   consider an entry in-flight when:
 *     (a) the pid is still alive (process.kill(pid, 0) does not throw
 *         ESRCH), AND
 *     (b) the start time is within MAX_STALE_MS (30 minutes default).
 *   The staleness cap defends against pid reuse on long-lived sessions —
 *   if a dispatch took >30 min something is wrong and we let the user
 *   commit anyway.
 *
 * Escape hatch:
 *   CLAUDE_HOOK_SKIP_BG_GUARD=1 disables the guard. Use when you know
 *   bg writes are intentionally pending and you want to push without them.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_STALE_MS = 30 * 60 * 1000; // 30 minutes

// Heuristic command matchers. Tuned to also catch `git -C dir <verb>`,
// `git -c user.email=... <verb>`, and similar prefixes. We deliberately
// don't try to parse shell quoting — false positives are cheap (one wait
// cycle) and false negatives are the dangerous failure.
//
// Covered verbs:
//   commit / push           — publish operations
//   merge / rebase / pull   — branch-closeout operations that mutate the
//                             working tree and would conflict messily with
//                             concurrent bg writes
//   gh pr create / merge    — GitHub PR flow equivalents
const GIT_PREFIX = '(?:\\s+-[Cc]\\s+\\S+|\\s+-c\\s+\\S+)*';
const COMMIT_RE = new RegExp(`\\bgit${GIT_PREFIX}\\s+commit\\b`, 'i');
const PUSH_RE   = new RegExp(`\\bgit${GIT_PREFIX}\\s+push\\b`, 'i');
const MERGE_RE  = new RegExp(`\\bgit${GIT_PREFIX}\\s+merge\\b`, 'i');
const REBASE_RE = new RegExp(`\\bgit${GIT_PREFIX}\\s+rebase\\b`, 'i');
const PULL_RE   = new RegExp(`\\bgit${GIT_PREFIX}\\s+pull\\b`, 'i');
const GH_CREATE_RE = /\bgh\s+pr\s+create\b/i;
const GH_MERGE_RE  = /\bgh\s+pr\s+merge\b/i;

class BgBusyGuard {
  /**
   * @param {string} projectDir
   * @param {object} [opts]
   * @param {number} [opts.maxStaleMs]  override staleness cap (ms)
   */
  constructor(projectDir, opts) {
    this.projectDir = projectDir || process.cwd();
    this.logPath = path.join(this.projectDir, '.contramaestre', '.state', 'dispatch-log.jsonl');
    this.maxStaleMs = (opts && opts.maxStaleMs) || DEFAULT_MAX_STALE_MS;
  }

  /**
   * Should this tool call be guarded?
   *
   * @param {string} toolName
   * @param {object} toolInput
   * @returns {{kind: string, command: string} | null}
   */
  static classify(toolName, toolInput) {
    if (toolName !== 'Bash') return null;
    const cmd = String((toolInput && toolInput.command) || '');
    if (!cmd) return null;
    if (COMMIT_RE.test(cmd)) return { kind: 'git commit', command: cmd };
    if (PUSH_RE.test(cmd)) return { kind: 'git push', command: cmd };
    if (MERGE_RE.test(cmd)) return { kind: 'git merge', command: cmd };
    if (REBASE_RE.test(cmd)) return { kind: 'git rebase', command: cmd };
    if (PULL_RE.test(cmd)) return { kind: 'git pull', command: cmd };
    if (GH_CREATE_RE.test(cmd)) return { kind: 'gh pr create', command: cmd };
    if (GH_MERGE_RE.test(cmd)) return { kind: 'gh pr merge', command: cmd };
    return null;
  }

  /** Is the escape hatch set? */
  static isDisabled(env) {
    const v = (env || process.env).CLAUDE_HOOK_SKIP_BG_GUARD;
    return v === '1' || /^(true|yes|on)$/i.test(String(v || ''));
  }

  /**
   * In-flight detection: dispatch-log contains both `event:'dispatch'`
   * (start) and `event:'dispatch-end'` (sentinel-written) records. A pid is
   * in flight if it has a start with no matching end. For older entries
   * with no `event` field (legacy), we treat them as starts.
   *
   * For entries with no end record we still check pid-liveness + a
   * staleness cap — this catches the rare case where the sentinel was
   * SIGKILLed or crashed before it could write its end record.
   *
   * @returns {Array<{pid:number, name:string, at:string, ageMs:number}>}
   */
  listInFlight() {
    let raw;
    try {
      raw = fs.readFileSync(this.logPath, 'utf8');
    } catch (_e) {
      return []; // no log file = nothing has been dispatched
    }

    // First pass: collect the latest start per pid, and the set of pids
    // that have a dispatch-end record. We treat any non-end record as a
    // start so legacy logs without an `event` field still work.
    const starts = new Map();   // pid -> latest start entry
    const endedPids = new Set();
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let entry;
      try { entry = JSON.parse(s); } catch (_e) { continue; }
      if (!entry || typeof entry.pid !== 'number' || !entry.at) continue;
      if (entry.event === 'dispatch-end') {
        endedPids.add(entry.pid);
        continue;
      }
      const prev = starts.get(entry.pid);
      if (!prev || Date.parse(entry.at) > Date.parse(prev.at)) {
        starts.set(entry.pid, entry);
      }
    }

    const now = Date.now();
    const inFlight = [];
    for (const entry of starts.values()) {
      if (endedPids.has(entry.pid)) continue; // sentinel wrote end record
      const startMs = Date.parse(entry.at);
      if (!Number.isFinite(startMs)) continue;
      const ageMs = now - startMs;
      if (ageMs > this.maxStaleMs) continue; // sentinel must have died
      if (!isPidAlive(entry.pid)) continue;  // SIGKILL / crash before end
      inFlight.push({
        pid: entry.pid,
        name: entry.name || '(unnamed)',
        at: entry.at,
        ageMs,
      });
    }
    return inFlight;
  }

  /**
   * Poll listInFlight() until empty or `maxMs` elapses.
   *
   * @param {number} maxMs   total wait budget
   * @param {number} pollMs  poll interval (default 1000ms)
   * @param {(remaining:object[])=>void} [onTick]  observe each poll cycle
   * @returns {Promise<Array>}  final in-flight list (empty = idle)
   */
  async awaitIdle(maxMs, pollMs, onTick) {
    const interval = Math.max(50, pollMs || 1000);
    const deadline = Date.now() + Math.max(0, maxMs);
    let inFlight = this.listInFlight();
    if (typeof onTick === 'function') onTick(inFlight);
    while (inFlight.length > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      await sleep(Math.min(interval, remaining));
      inFlight = this.listInFlight();
      if (typeof onTick === 'function') onTick(inFlight);
    }
    return inFlight;
  }
}

/**
 * Cross-platform "is pid alive" check. process.kill(pid, 0) sends no
 * signal — it just probes existence. Throws ESRCH if dead, EPERM if alive
 * but unowned (treat as alive). Anything else: assume dead so the guard
 * fails open, not closed.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

BgBusyGuard.isPidAlive = isPidAlive;
module.exports = BgBusyGuard;
