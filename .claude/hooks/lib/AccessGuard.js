'use strict';

/**
 * AccessGuard — match a PreToolUse payload against a blocklist of paths/dirs/globs.
 *
 * Uniformly intercepts read, write, and delete operations for the configured
 * paths. The hook handler treats every positive match as a deny regardless of
 * whether the underlying tool call is a Read, Edit, Write, Glob, Grep, or a
 * Bash/PowerShell command that touches the path.
 *
 * Blocklist file format: JSON array of strings. Each entry is one of:
 *   - absolute path:       "C:/Windows/System32/config/SAM"  "/etc/shadow"
 *   - project-relative:    ".env"  "secrets/api.json"
 *   - directory (slash):   "secrets/"  ".claude/hooks/"
 *   - global glob:         "**\/id_rsa"  "**\/.npmrc"  "**\/*.pem"
 *   - home/var expansion:  "~/.aws/"  "$HOME/.config/gh/"  "%APPDATA%/gcloud/"
 *
 * Comparisons are case-insensitive (Windows) and slash-normalized. Directory
 * rules block the directory itself and everything beneath it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Bash/PowerShell commands whose argument list refers to files. Reads,
 * writes, deletes, renames, and copies are all included so the hook can
 * deny shell-level circumvention of Read/Edit/Write.
 */
const FS_BASH_CMDS = [
  // read / inspect
  'cat', 'bat', 'less', 'more', 'head', 'tail', 'nl', 'tac',
  'sed', 'awk', 'cut', 'paste', 'sort', 'uniq', 'column', 'wc',
  'od', 'xxd', 'hexdump', 'strings', 'file', 'stat',
  'ls', 'dir', 'tree', 'find', 'fd',
  'type', 'gc', 'Get-Content',
  'readlink', 'realpath',
  // write / create
  'touch', 'tee', 'truncate', 'dd', 'mkfifo', 'mknod',
  // copy
  'cp', 'copy', 'Copy-Item', 'cpi',
  // delete
  'rm', 'rmdir', 'unlink', 'del', 'erase', 'rd',
  'Remove-Item', 'ri',
  // rename / move
  'mv', 'move', 'Move-Item', 'mi',
  'ren', 'rename', 'Rename-Item', 'rni',
  // permission / ownership
  'chmod', 'chown', 'chgrp', 'icacls', 'attrib',
];

class AccessGuard {
  /**
   * @param {string} blocklistPath - absolute path to blockedPaths.json
   * @param {string} projectDir    - project root used to resolve relative entries
   */
  constructor(blocklistPath, projectDir) {
    this.blocklistPath = blocklistPath;
    this.projectDir = this._normalize(projectDir || process.cwd());
    this.rules = this._loadRules();
  }

  _normalize(p) {
    if (!p) return '';
    return path.resolve(p).replace(/\\/g, '/');
  }

  _isAbsolute(p) {
    return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
  }

  /**
   * Expand shell-style variables and tildes in a path string. Supports:
   *   ~              -> os.homedir()                (leading only)
   *   $VAR / ${VAR}  -> process.env.VAR             (Unix-style)
   *   %VAR%          -> process.env.VAR             (Windows-style)
   * Unknown variables are left as-is so they don't silently collapse paths.
   */
  _expand(p) {
    if (!p) return p;
    let s = String(p);
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
      s = os.homedir() + s.slice(1);
    }
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) =>
      process.env[name] != null ? process.env[name] : m);
    s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) =>
      process.env[name] != null ? process.env[name] : m);
    s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) =>
      process.env[name] != null ? process.env[name] : m);
    return s;
  }

  _loadRules() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.blocklistPath, 'utf8'));
    } catch (_e) {
      return [];
    }
    const arr = Array.isArray(raw)
      ? raw
      : Array.isArray(raw && raw.patterns) ? raw.patterns : [];
    return arr
      .filter((p) => typeof p === 'string' && p.trim() && !p.startsWith('//'))
      .map((p) => this._compileRule(p));
  }

  _compileRule(pattern) {
    const trimmed = pattern.trim();
    const expanded = this._expand(trimmed);
    const isDirHint = /[/\\]$/.test(expanded);
    const cleaned = expanded.replace(/[/\\]+$/, '');
    const isGlob = /[*?[\]{}]/.test(cleaned);

    // Rules starting with "**/" mean "match anywhere on the filesystem".
    // Don't anchor them to projectDir; build an unanchored regex instead.
    if (/^\*\*[/\\]/.test(cleaned)) {
      const rest = cleaned.replace(/^\*\*[/\\]/, '');
      const restRe = this._globToRegExp(rest).source
        .replace(/^\^/, '').replace(/\$$/, '');
      return {
        raw: pattern,
        isGlob: true,
        isDirHint,
        absolute: cleaned,
        regex: new RegExp('^(?:.*/)?' + restRe + '$', 'i'),
      };
    }

    const abs = this._isAbsolute(cleaned)
      ? cleaned
      : path.join(this.projectDir, cleaned);
    const normalized = this._normalize(abs);
    return {
      raw: pattern,
      isGlob,
      isDirHint,
      absolute: normalized,
      regex: isGlob ? this._globToRegExp(normalized) : null,
    };
  }

  _globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          re += '.*';
          i++;
          if (glob[i + 1] === '/') i++;
        } else {
          re += '[^/]*';
        }
      } else if (c === '?') {
        re += '[^/]';
      } else if (c === '[') {
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
        if (end === -1) {
          re += '\\{';
        } else {
          const opts = glob.slice(i + 1, end).split(',')
            .map((o) => o.replace(/[.+^$(){}|[\]\\]/g, '\\$&'));
          re += '(?:' + opts.join('|') + ')';
          i = end;
        }
      } else if ('.+^$()|\\'.indexOf(c) !== -1) {
        re += '\\' + c;
      } else {
        re += c;
      }
    }
    return new RegExp('^' + re + '$', 'i');
  }

  _resolvePath(p, cwd) {
    if (!p) return null;
    const expanded = this._expand(p);
    const base = cwd ? this._normalize(cwd) : this.projectDir;
    const abs = this._isAbsolute(expanded) ? expanded : path.join(base, expanded);
    return this._normalize(abs);
  }

  _pathMatchesRule(absPath, rule) {
    if (rule.regex) return rule.regex.test(absPath);
    const a = absPath.toLowerCase();
    const r = rule.absolute.toLowerCase();
    if (a === r) return true;
    if (a.startsWith(r + '/')) return true;
    return false;
  }

  _globMatchesRule(userGlob, cwd, rule) {
    const base = cwd ? this._normalize(cwd) : this.projectDir;
    const expandedGlob = this._expand(userGlob);
    const absGlob = this._isAbsolute(expandedGlob)
      ? this._normalize(expandedGlob)
      : this._normalize(path.join(base, expandedGlob));

    const literalPrefix = absGlob.split(/[*?{[]/)[0].replace(/\/[^/]*$/, '');
    if (literalPrefix && this._pathMatchesRule(literalPrefix, rule)) return true;

    const userRe = this._globToRegExp(absGlob);
    if (userRe.test(rule.absolute)) return true;

    if (rule.regex && rule.regex.test(absGlob)) return true;

    return false;
  }

  _tokenizeBashArgs(s) {
    const out = [];
    let buf = '';
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === q) q = null;
        else buf += c;
      } else if (c === '"' || c === "'") {
        q = c;
      } else if (/\s/.test(c)) {
        if (buf) { out.push(buf); buf = ''; }
      } else {
        buf += c;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  _extractBashTargets(command) {
    if (!command) return [];
    const cmdAlt = FS_BASH_CMDS
      .map((c) => c.replace(/[.+^$(){}|[\]\\]/g, '\\$&'))
      .join('|');
    const re = new RegExp(`(?:^|[|;&\`]|\\$\\()\\s*(?:sudo\\s+)?(${cmdAlt})\\b([^|;&\`]*)`, 'gi');
    const targets = [];
    let m;
    while ((m = re.exec(command)) !== null) {
      const args = this._tokenizeBashArgs(m[2] || '');
      for (const t of args) {
        if (!t || t.startsWith('-')) continue;
        targets.push(t);
      }
    }
    return targets;
  }

  /**
   * Inspect a PreToolUse payload and decide whether to deny it.
   * @param {string} toolName
   * @param {object} toolInput
   * @param {string} cwd - working directory at the time of the tool call
   * @returns {{blocked:boolean, rule:string|null, target:string|null, kind:string|null}}
   */
  check(toolName, toolInput, cwd) {
    if (this.rules.length === 0) {
      return { blocked: false, rule: null, target: null, kind: null };
    }

    const input = toolInput || {};
    const candidates = [];

    switch (toolName) {
      case 'Read':
        if (input.file_path) candidates.push({ kind: 'path', value: input.file_path });
        break;
      case 'NotebookEdit':
        if (input.notebook_path) candidates.push({ kind: 'path', value: input.notebook_path });
        break;
      case 'Edit':
      case 'Write':
        if (input.file_path) candidates.push({ kind: 'path', value: input.file_path });
        break;
      case 'Glob':
        if (input.pattern) candidates.push({ kind: 'glob', value: input.pattern });
        if (input.path)    candidates.push({ kind: 'path', value: input.path });
        break;
      case 'Grep':
        if (input.path) candidates.push({ kind: 'path', value: input.path });
        if (input.glob) candidates.push({ kind: 'glob', value: input.glob });
        break;
      case 'Bash':
      case 'PowerShell':
        if (input.command) {
          for (const t of this._extractBashTargets(input.command)) {
            candidates.push({ kind: 'path', value: t });
          }
        }
        break;
      default:
        return { blocked: false, rule: null, target: null, kind: null };
    }

    for (const cand of candidates) {
      for (const rule of this.rules) {
        if (cand.kind === 'path') {
          const abs = this._resolvePath(cand.value, cwd);
          if (abs && this._pathMatchesRule(abs, rule)) {
            return { blocked: true, rule: rule.raw, target: cand.value, kind: cand.kind };
          }
        } else if (cand.kind === 'glob') {
          if (this._globMatchesRule(cand.value, cwd, rule)) {
            return { blocked: true, rule: rule.raw, target: cand.value, kind: cand.kind };
          }
        }
      }
    }
    return { blocked: false, rule: null, target: null, kind: null };
  }
}

module.exports = AccessGuard;
