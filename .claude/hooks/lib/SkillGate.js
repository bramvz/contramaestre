'use strict';

/**
 * SkillGate — conditional tool-use gating driven by skill invocations.
 *
 * Each rule in .claude/hooks/config/conditionalTools.json describes:
 *   - a skillGateRegEx that, when matched against a user prompt, opens a
 *     "gate" with captured named-group variables;
 *   - a trigger regex that selects which tool calls the rule screens;
 *   - alwaysAllow / alwaysDeny / conditionalAllow patterns that decide;
 *   - unmatchedAction + timeout knobs.
 *
 * Lifecycle:
 *   recordPromptSubmit()  - UserPromptSubmit handler. Captures vars and
 *                           writes a "pending" gate entry per matching rule.
 *   confirmExpansion()    - UserPromptExpansion handler. Promotes any
 *                           pending entry younger than PROMOTION_WINDOW_MS to
 *                           "open". The expansion event firing is itself the
 *                           proof the skill was actually invoked (and not
 *                           deleted or intercepted).
 *   screenToolUse()       - PreToolUse handler. Returns {decision, reason}.
 *
 * State persists per session at .claude/.state/gates-<sessionId>.json.
 * Atomic writes via tmp+rename. No active cleanup; entries self-expire via
 * timeout checks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ClaudeCommandTriggerMatcher = require('./ClaudeCommandTriggerMatcher');

const PROMOTION_WINDOW_MS = 10_000; // UserPromptSubmit → Expansion grace period
const DEFAULT_TIMEOUT_MIN = 30;
const NOT_PERMITTED = 'Use of this tool is not permitted.';
const VAR_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

class SkillGate {
  /**
   * @param {string} configPath  Path to conditionalTools.json.
   * @param {string} projectDir  Project root; state lives under here.
   * @param {string} sessionId   Current Claude Code session id.
   */
  constructor(configPath, projectDir, sessionId) {
    this.configPath = configPath;
    this.projectDir = projectDir || process.cwd();
    this.sessionId = String(sessionId || 'no-session');
    this.rules = this._loadConfig();
    // Shell-aware trigger matcher. Tests regexes against extracted execution
    // surfaces instead of the flattened JSON payload — distinguishes
    // `echo '...gcloud...'` (data) from a real `gcloud` invocation.
    // See lib/ClaudeCommandTriggerMatcher.js for the parser and
    // lib/__tests__/ for regression coverage.
    this.matcher = new ClaudeCommandTriggerMatcher();
  }

  // -------------------------------------------------------------------------
  // Public — hook entry points
  // -------------------------------------------------------------------------

  /**
   * Match the literal prompt text against each rule's skillGateRegEx. For
   * every match, write a "pending" gate entry. Multiple rules can go pending
   * from one submit. Silently does nothing on parse failures.
   */
  recordPromptSubmit(promptText) {
    if (typeof promptText !== 'string' || promptText.length === 0) return;
    if (this.rules.length === 0) return;

    const state = this._readState();
    const now = new Date().toISOString();
    let mutated = false;

    for (const rule of this.rules) {
      const m = rule.skillGateRegex.exec(promptText);
      if (!m) continue;
      const vars = m.groups ? { ...m.groups } : {};
      state[rule.name] = {
        status: 'pending',
        vars,
        openedAt: now,
        promotedAt: null,
        sessionId: this.sessionId,
      };
      mutated = true;
    }

    if (mutated) this._writeState(state);
  }

  /**
   * Promote any pending gates younger than PROMOTION_WINDOW_MS to "open".
   * The fact that an expansion event fired at all is the confirmation we need
   * — if the skill had been deleted or intercepted, no expansion would have
   * occurred. We don't try to correlate the expansion's body to a specific
   * pending rule; any pending within the window promotes.
   */
  confirmExpansion(_payload) {
    if (this.rules.length === 0) return;

    const state = this._readState();
    const now = Date.now();
    let mutated = false;

    for (const rule of this.rules) {
      const entry = state[rule.name];
      if (!entry || entry.status !== 'pending') continue;
      const openedMs = Date.parse(entry.openedAt);
      if (Number.isNaN(openedMs)) continue;
      if (now - openedMs > PROMOTION_WINDOW_MS) continue;
      entry.status = 'open';
      entry.promotedAt = new Date().toISOString();
      mutated = true;
    }

    if (mutated) this._writeState(state);
  }

  /**
   * Screen a tool call. Returns one of:
   *   { decision: 'allow' }
   *   { decision: 'deny',  reason: <string> }
   *
   * Rules are tested in declaration order; the first rule whose trigger
   * matches is the only one consulted (subsequent rules are not considered).
   */
  screenToolUse(toolName, toolInput, parentToolUseId) {
    if (this.rules.length === 0) return { decision: 'allow' };
    const isSubAgent = !!parentToolUseId;
    const state = this._readState();

    for (const rule of this.rules) {
      if (!this.matcher.matches(toolName, toolInput, rule.triggerRegex)) continue;
      return this._evaluateRule(rule, toolName, toolInput, state[rule.name], isSubAgent);
    }

    return { decision: 'allow' };
  }

  // -------------------------------------------------------------------------
  // Private — rule evaluation
  // -------------------------------------------------------------------------

  _evaluateRule(rule, toolName, toolInput, entry, isSubAgent) {
    const m = this.matcher;

    if (rule.alwaysDenyRegexes.some((re) => m.matches(toolName, toolInput, re))) {
      return { decision: 'deny', reason: NOT_PERMITTED };
    }
    if (rule.alwaysAllowRegexes.some((re) => m.matches(toolName, toolInput, re))) {
      return { decision: 'allow' };
    }

    const gateOpen =
      entry &&
      entry.status === 'open' &&
      entry.sessionId === this.sessionId &&
      !isSubAgent &&
      this._withinTimeout(entry, rule.timeoutMin);

    if (gateOpen && rule.conditionalAllow.length > 0) {
      const resolved = rule.conditionalAllow.map((tpl) =>
        new RegExp(substitute(tpl, entry.vars, true)),
      );
      if (resolved.some((re) => m.matches(toolName, toolInput, re))) {
        return { decision: 'allow' };
      }
    }

    // Gate-closed deny detection: would the conditionalAllow SHAPE have matched?
    // We use captured vars when available, else regex-wildcards from the
    // skillGateRegEx group names. If shape matches, surface the skill-gate
    // message rather than the generic deny.
    if (rule.conditionalAllow.length > 0) {
      const varsForShape =
        entry && entry.vars && Object.keys(entry.vars).length > 0
          ? entry.vars
          : this._wildcardVars(rule);
      const escape = entry && entry.vars && Object.keys(entry.vars).length > 0;
      const shape = rule.conditionalAllow.map((tpl) =>
        new RegExp(substitute(tpl, varsForShape, escape)),
      );
      if (shape.some((re) => m.matches(toolName, toolInput, re))) {
        return {
          decision: 'deny',
          reason: this._skillGateMessage(rule),
        };
      }
    }

    // Unmatched fall-through.
    if (rule.unmatchedAction === 'allow') return { decision: 'allow' };
    return { decision: 'deny', reason: NOT_PERMITTED };
  }

  _withinTimeout(entry, timeoutMin) {
    const promotedMs = entry.promotedAt
      ? Date.parse(entry.promotedAt)
      : Date.parse(entry.openedAt);
    if (Number.isNaN(promotedMs)) return false;
    return Date.now() - promotedMs <= timeoutMin * 60_000;
  }

  _skillGateMessage(rule) {
    const names = rule.varNames.join(', ');
    return (
      `Use of this tool is only permitted if the user invokes skill: ` +
      `${rule.skillName} with variables: ${names || '(none)'}`
    );
  }

  _wildcardVars(rule) {
    const out = {};
    for (const name of rule.varNames) out[name] = '[^\\s"]+';
    return out;
  }

  // -------------------------------------------------------------------------
  // Private — config load + compile
  // -------------------------------------------------------------------------

  _loadConfig() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (_e) {
      return [];
    }
    const rules = Array.isArray(raw && raw.rules) ? raw.rules : [];
    const out = [];
    for (const r of rules) {
      try {
        out.push(this._compileRule(r));
      } catch (err) {
        process.stderr.write(
          `[SkillGate] failed to compile rule ${r && r.name}: ${err && err.message}\n`,
        );
      }
    }
    return out;
  }

  _compileRule(r) {
    if (!r || typeof r.name !== 'string') {
      throw new Error('rule missing `name`');
    }
    if (typeof r.skillGateRegEx !== 'string') {
      throw new Error('rule missing `skillGateRegEx`');
    }
    if (typeof r.skillName !== 'string') {
      throw new Error('rule missing `skillName`');
    }
    if (typeof r.trigger !== 'string') {
      throw new Error('rule missing `trigger`');
    }

    const skillGateRegex = new RegExp(r.skillGateRegEx);
    const triggerRegex = new RegExp(r.trigger);
    const alwaysAllowRegexes = toArray(r.alwaysAllow).map((s) => new RegExp(s));
    const alwaysDenyRegexes = toArray(r.alwaysDeny).map((s) => new RegExp(s));
    const conditionalAllow = toArray(r.conditionalAllow);

    // Extract named-group names from skillGateRegEx for the skill-gate message
    // and wildcard fallback. Static regex parse, not execution.
    const varNames = [];
    const nameMatcher = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g;
    let m;
    while ((m = nameMatcher.exec(r.skillGateRegEx)) !== null) {
      varNames.push(m[1]);
    }

    const unmatchedAction = r.unmatchedAction === 'allow' ? 'allow' : 'deny';
    const timeoutMin =
      typeof r.timeout === 'number' && r.timeout > 0
        ? r.timeout
        : DEFAULT_TIMEOUT_MIN;

    return {
      name: r.name,
      skillName: r.skillName,
      skillGateRegex,
      triggerRegex,
      alwaysAllowRegexes,
      alwaysDenyRegexes,
      conditionalAllow,
      varNames,
      unmatchedAction,
      timeoutMin,
    };
  }

  // -------------------------------------------------------------------------
  // Private — state I/O
  // -------------------------------------------------------------------------

  _stateFile() {
    return path.join(
      this.projectDir,
      '.claude',
      '.state',
      `gates-${sanitize(this.sessionId)}.json`,
    );
  }

  _readState() {
    try {
      return JSON.parse(fs.readFileSync(this._stateFile(), 'utf8')) || {};
    } catch (_e) {
      return {};
    }
  }

  _writeState(state) {
    const file = this._stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_e) { /* ignore */ }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function substitute(template, vars, escapeValues) {
  return template.replace(VAR_PLACEHOLDER, (m, name) => {
    if (!(name in vars)) return m;
    return escapeValues ? escapeRegex(vars[name]) : vars[name];
  });
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

// also export internals for testing
SkillGate._internals = { substitute, escapeRegex, sanitize };
module.exports = SkillGate;
