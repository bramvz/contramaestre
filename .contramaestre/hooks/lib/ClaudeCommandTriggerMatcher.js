'use strict';

/**
 * ClaudeCommandTriggerMatcher
 *
 * Extracts execution surfaces from Claude hook tool calls and tests trigger
 * regexes against those surfaces instead of against flattened JSON payloads.
 *
 * This remains a dependency-free, practical parser. It is not a complete Bash,
 * cmd.exe, or PowerShell grammar. The important security property is that data
 * arguments such as `echo '{"command":"gcloud ..."}'` are not treated as direct
 * executions of `gcloud`, while common wrappers and nested execution forms are
 * expanded far enough for hook triggers to remain useful.
 */
class ClaudeCommandTriggerMatcher {
  constructor(options = {}) {
    this.options = {
      includeArgsOnlyWhenRegexMentionsCommand: true,
      includeOpaqueScriptExecutions: true,
      maxDepth: 16,
      maxInputLength: 200000,
      maxSurfaceCount: 2000,
      ...options,
    };

    // Backwards-compatible debugging snapshot. Prefer matchesWithSurfaces() or
    // extractExecutionSurfaces() for request-local access.
    this.lastSurfaces = Object.freeze([]);
  }

  matches(toolName, toolInput, triggerRegex) {
    return this.matchesWithSurfaces(toolName, toolInput, triggerRegex).matched;
  }

  matchesWithSurfaces(toolName, toolInput, triggerRegex) {
    const regex = this._toRegExp(triggerRegex);
    const surfaces = this.extractExecutionSurfaces(toolName, toolInput || {});
    const matched = surfaces.some(surface => this._surfaceMatchesRegex(surface, regex));
    this.lastSurfaces = Object.freeze(surfaces.slice());
    return { matched, surfaces };
  }

  extractExecutionSurfaces(toolName, toolInput = {}) {
    const command = this._readCommandField(toolInput);
    const ctx = this._newContext();

    if (toolName === 'Bash' || toolName === 'Monitor') {
      return this._dedupeSurfaces(this._parsePosix(toolName, command, ctx));
    }

    if (toolName === 'PowerShell') {
      return this._dedupeSurfaces(this._parsePowerShell(toolName, command, ctx));
    }

    if (typeof toolName === 'string' && toolName.startsWith('mcp__')) {
      return this._dedupeSurfaces(this._extractMcpSurfaces(toolName, toolInput, ctx));
    }

    if (['Agent', 'Skill', 'CronCreate', 'RemoteTrigger'].includes(toolName)) {
      return [this._makeSurface(toolName, toolName, [toolName], 'indirect-tool-name', '', { opaque: true })];
    }

    return [];
  }

  // ========================================================================
  // Regex matching model
  // ========================================================================

  _surfaceMatchesRegex(surface, regex) {
    const candidates = this._uniqueStrings([
      `${surface.toolName} ${surface.command}`,
      `${surface.toolName} ${surface.normalizedCommand}`,
      `${surface.toolName}{"command":"${this._escapeJsonString(surface.command)}"}`,
      `${surface.toolName}{"command":"${this._escapeJsonString(surface.normalizedCommand)}"}`,
    ]);

    for (const candidate of candidates) {
      if (candidate.trim() && this._testRegex(regex, candidate)) return true;
    }

    if (this._shouldTestFullCommandLine(surface, regex)) {
      const fullCandidates = this._uniqueStrings([
        `${surface.toolName} ${surface.rawCommandLine}`.trim(),
        `${surface.toolName} ${surface.commandLine}`.trim(),
        `${surface.toolName} ${surface.segment}`.trim(),
        `${surface.toolName}{"command":"${this._escapeJsonString(surface.rawCommandLine)}"}`,
        `${surface.toolName}{"command":"${this._escapeJsonString(surface.commandLine)}"}`,
      ]);

      for (const candidate of fullCandidates) {
        if (candidate.trim() && this._testRegex(regex, candidate)) return true;
      }
    }

    return false;
  }

  _shouldTestFullCommandLine(surface, regex) {
    const hasArgs = surface.commandLine && surface.commandLine !== surface.normalizedCommand;
    const hasRawArgs = surface.rawCommandLine && surface.rawCommandLine !== surface.command;
    if (!hasArgs && !hasRawArgs) return false;
    if (!this.options.includeArgsOnlyWhenRegexMentionsCommand) return true;
    return this._regexMentionsExecutable(surface, regex);
  }

  _regexMentionsExecutable(surface, regex) {
    const terms = this._regexTerms(regex);
    const names = this._uniqueStrings([
      surface.normalizedCommand,
      this._normalizeCommand(surface.command),
      this._normalizeCommand(surface.rawCommand),
      this._basename(surface.command).toLowerCase(),
      this._basename(surface.rawCommand).toLowerCase(),
    ]).filter(Boolean);

    for (const name of names) {
      if (terms.has(name)) return true;
      if (this._regexWordFragmentsContain(regex, name)) return true;
    }
    return false;
  }

  _regexWordFragmentsContain(regex, name) {
    if (!name) return false;
    const source = regex.source.toLowerCase();
    const literalBoundary = new RegExp(`(^|[^a-z0-9_.-])${this._escapeRegExp(name.toLowerCase())}([^a-z0-9_.-]|$)`);
    if (literalBoundary.test(source)) return true;

    const fragments = source.match(/[a-z0-9_.-]+/g) || [];
    for (let i = 0; i < fragments.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(fragments.length, i + 4); j++) {
        joined += this._normalizeCommand(fragments[j].replace(/[.]+$/g, ''));
        if (joined === name) return true;
        if (joined.length > name.length + 8) break;
      }
    }
    return false;
  }

  _toRegExp(triggerRegex) {
    if (triggerRegex instanceof RegExp) return triggerRegex;
    if (typeof triggerRegex !== 'string') {
      throw new TypeError('triggerRegex must be a RegExp or string');
    }

    const slash = triggerRegex.match(/^\/(.*)\/([dgimsuvy]*)$/);
    if (slash) return new RegExp(slash[1], slash[2]);
    return new RegExp(triggerRegex);
  }

  _testRegex(regex, candidate) {
    const clone = new RegExp(regex.source, regex.flags);
    clone.lastIndex = 0;
    return clone.test(candidate);
  }

  _regexTerms(regex) {
    const source = regex.source
      .replace(/\\b/g, ' ')
      .replace(/\\s[+*?]?/g, ' ')
      .replace(/\\[dwWDS]/g, ' ')
      .replace(/\\\//g, '/')
      .replace(/\\\./g, '.');

    const words = source.match(/[A-Za-z_][A-Za-z0-9_.\/-]*/g) || [];
    return new Set(words.map(w => this._normalizeCommand(w.replace(/[.]+$/g, ''))).filter(Boolean));
  }

  // ========================================================================
  // POSIX/Bash parser
  // ========================================================================

  _parsePosix(toolName, command, ctx = {}) {
    ctx = this._normalizeContext(ctx);
    const input = this._boundedInput(command);
    if (!input.trim()) return [];
    if (ctx.depth > this.options.maxDepth) {
      return [this._makeSurface(toolName, '<parse-depth-limit>', ['<parse-depth-limit>'], 'posix-parse-depth-limit', input, { opaque: true })];
    }

    const surfaces = [];

    const functionExtraction = this._extractPosixFunctionDefinitions(input);
    for (const [name, body] of functionExtraction.functions.entries()) ctx.functions.set(name, body);

    const hd = this._collectHereDocs(functionExtraction.strippedCommand);
    for (const [file, body] of hd.scriptBodies.entries()) this._rememberScriptBody(ctx.scriptBodies, file, body);

    for (const inline of hd.inlineShellBodies) {
      for (const body of inline.bodies) {
        surfaces.push(...this._markNested(
          this._parsePosix(toolName, body, this._childContext(ctx)),
          `${inline.via}-heredoc-stdin`,
          inline.remote
        ));
      }
    }

    for (const nested of this._extractCommandSubstitutions(hd.strippedCommand)) {
      surfaces.push(...this._markNested(
        this._parsePosix(toolName, nested, this._childContext(ctx)),
        'command-substitution',
        false
      ));
    }

    for (const segment of this._splitShellCommands(hd.strippedCommand)) {
      const tokens = this._tokenizeShell(segment);
      if (!tokens.length) continue;

      this._captureAlias(tokens, ctx.aliases);
      this._captureInlineScriptWrite(tokens, ctx.scriptBodies);

      const firstIndex = this._firstCommandIndex(tokens);
      if (firstIndex === null) continue;

      const stripped = this._stripPosixPrefixWrappers(tokens, firstIndex);
      for (const wrapper of stripped.wrappers) {
        surfaces.push(this._makeSurface(toolName, wrapper.command, [wrapper.command], 'posix-prefix-wrapper', segment));
      }

      const i = stripped.index;
      if (i >= tokens.length) continue;

      const cmdRaw = tokens[i];
      const cmd = this._normalizeCommand(cmdRaw);
      const argv = tokens.slice(i).filter(t => !this._isControlTerminator(t));

      surfaces.push(this._makeSurface(toolName, cmdRaw, argv, 'posix-direct', segment));

      if (/^\$|^\$\{|^\$\(/.test(cmdRaw)) {
        surfaces.push(this._makeSurface(toolName, cmdRaw, argv, 'posix-dynamic-first-token', segment, { opaque: true }));
        continue;
      }

      if (ctx.aliases.has(cmd) && !ctx.expandingAliases.has(cmd)) {
        const aliasCtx = this._childContext(ctx);
        aliasCtx.expandingAliases.add(cmd);
        const expansion = `${ctx.aliases.get(cmd)} ${tokens.slice(i + 1).join(' ')}`.trim();
        surfaces.push(...this._markNested(
          this._parsePosix(toolName, expansion, aliasCtx),
          `alias:${cmd}`,
          false
        ));
      }

      if (ctx.functions.has(cmd) && !ctx.executingFunctions.has(cmd)) {
        const fnCtx = this._childContext(ctx);
        fnCtx.executingFunctions.add(cmd);
        surfaces.push(...this._markNested(
          this._parsePosix(toolName, ctx.functions.get(cmd), fnCtx),
          `function:${cmd}`,
          false
        ));
      }

      if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(cmd)) {
        const cIndex = this._findShellCIndex(tokens, i + 1);
        if (cIndex >= 0 && tokens[cIndex + 1]) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, tokens[cIndex + 1], this._childContext(ctx)),
            `${cmd}-c`,
            false
          ));
        } else {
          const scriptPath = this._nextShellScriptArg(tokens, i + 1);
          if (scriptPath) {
            surfaces.push(...this._parseKnownPosixScript(toolName, scriptPath, ctx, segment));
          }
        }
      }

      if (cmd === 'source' || cmd === '.') {
        const scriptPath = this._nextNonOption(tokens, i + 1);
        if (scriptPath) surfaces.push(...this._parseKnownPosixScript(toolName, scriptPath, ctx, segment));
      }

      if (cmd === 'eval') {
        const nested = tokens.slice(i + 1).join(' ');
        if (nested.trim()) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'eval',
            false
          ));
        }
      }

      if (cmd === 'xargs') {
        const nested = this._xargsNestedCommand(tokens.slice(i + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'xargs-inner',
            false
          ));
        }
      }

      if (cmd === 'find') {
        for (const nested of this._findExecNestedCommands(tokens.slice(i + 1))) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'find-exec-inner',
            false
          ));
        }
      }

      if (/^(?:\.\/|\/|~\/).+\.(?:sh|bash|zsh|ksh)$/i.test(this._cleanPathToken(cmdRaw))) {
        surfaces.push(...this._parseKnownPosixScript(toolName, cmdRaw, ctx, segment));
      }

      if (cmd === 'ssh') {
        const nested = this._sshNestedCommand(tokens.slice(i + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'ssh-inner',
            true
          ));
        }
      }

      if (cmd === 'docker' || cmd === 'podman') {
        const nested = this._dockerNestedCommand(tokens.slice(i + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            `${cmd}-inner`,
            true
          ));
        }
      }

      if (cmd === 'kubectl') {
        const nested = this._kubectlExecNestedCommand(tokens.slice(i + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'kubectl-exec-inner',
            true
          ));
        }
      }

      if (cmd === 'gcloud') {
        const nested = this._gcloudNestedCommand(tokens.slice(i + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'gcloud-remote-command-inner',
            true
          ));
        }
      }

      if (cmd === 'aws') {
        for (const nested of this._awsNestedCommands(tokens.slice(i + 1))) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'aws-remote-command-inner',
            true
          ));
        }
      }

      if (cmd === 'az') {
        for (const nested of this._azNestedCommands(tokens.slice(i + 1))) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'az-remote-command-inner',
            true
          ));
        }
      }

      if (cmd === 'cmd' && tokens[i + 1] && /^\/c$/i.test(tokens[i + 1])) {
        const nested = tokens.slice(i + 2).join(' ');
        if (nested) {
          surfaces.push(...this._markNested(
            this._parseCmd(toolName, nested, this._childContext(ctx)),
            'cmd-c-inner',
            false
          ));
        }
      }

      if (['node', 'python', 'python3', 'ruby', 'perl', 'php', 'npm', 'yarn', 'pnpm', 'npx', 'make', 'just', 'task'].includes(cmd)) {
        surfaces.push(this._makeSurface(toolName, cmdRaw, argv, 'opaque-language-or-build-executor', segment, { opaque: true }));
      }
    }

    return this._dedupeSurfaces(surfaces);
  }

  // ========================================================================
  // PowerShell parser
  // ========================================================================

  _parsePowerShell(toolName, command, ctx = {}) {
    ctx = this._normalizeContext(ctx);
    const input = this._boundedInput(command);
    if (!input.trim()) return [];
    if (ctx.depth > this.options.maxDepth) {
      return [this._makeSurface(toolName, '<parse-depth-limit>', ['<parse-depth-limit>'], 'powershell-parse-depth-limit', input, { opaque: true })];
    }

    const surfaces = [];

    for (const segment of this._splitPowerShellCommands(input)) {
      const tokens = this._tokenizePowerShell(segment);
      if (!tokens.length) continue;

      this._capturePowerShellScriptWrite(tokens, ctx.scriptBodies);

      let offset = 0;
      if (tokens[0] === '&' || tokens[0] === '.') offset = 1;
      if (!tokens[offset]) continue;

      if (tokens[offset] === '{') {
        for (const block of this._extractPowerShellScriptBlocks(segment)) {
          surfaces.push(...this._markNested(
            this._parsePowerShell(toolName, block, this._childContext(ctx)),
            'powershell-call-scriptblock',
            false
          ));
        }
        continue;
      }

      const cmdRaw = tokens[offset];
      const canonicalCmd = this._powerShellAlias(this._normalizeCommand(cmdRaw));
      const argv = [cmdRaw, ...tokens.slice(offset + 1)];
      surfaces.push(this._makeSurface(toolName, cmdRaw, argv, 'powershell-direct', segment, { canonicalCommand: canonicalCmd }));

      if (this._powerShellCommandRunsScriptBlock(canonicalCmd)) {
        for (const block of this._extractPowerShellScriptBlocks(segment)) {
          surfaces.push(...this._markNested(
            this._parsePowerShell(toolName, block, this._childContext(ctx)),
            `${canonicalCmd}-scriptblock`,
            canonicalCmd === 'invoke-command'
          ));
        }
      }

      if (canonicalCmd === 'invoke-expression' && tokens[offset + 1]) {
        surfaces.push(...this._markNested(
          this._parsePowerShell(toolName, tokens.slice(offset + 1).join(' '), this._childContext(ctx)),
          'powershell-invoke-expression',
          false
        ));
      }

      if (canonicalCmd === 'start-process') {
        const child = this._powerShellStartProcessChild(tokens, offset);
        if (child && child.command) {
          surfaces.push(this._makeSurface(
            toolName,
            child.command,
            [child.command, ...child.arguments],
            'powershell-start-process-child',
            segment
          ));
        }
      }

      if (canonicalCmd === 'powershell' || canonicalCmd === 'pwsh') {
        const encodedIndex = this._findPowerShellOptionIndex(tokens, offset + 1, ['encodedcommand', 'enc', 'e']);
        if (encodedIndex >= 0) {
          const encodedValue = this._optionAttachedValue(tokens[encodedIndex]) || tokens[encodedIndex + 1];
          const decoded = this._decodePowerShellEncodedCommand(encodedValue);
          if (decoded) {
            surfaces.push(...this._markNested(
              this._parsePowerShell(toolName, decoded, this._childContext(ctx)),
              `${canonicalCmd}-encoded-command`,
              false
            ));
          } else {
            surfaces.push(this._makeSurface(toolName, '<powershell-encoded-command>', ['<powershell-encoded-command>'], 'powershell-encoded-command-opaque', segment, { opaque: true }));
          }
        }

        const cIndex = this._findPowerShellOptionIndex(tokens, offset + 1, ['command', 'c']);
        if (cIndex >= 0) {
          const nested = this._optionAttachedValue(tokens[cIndex]) || tokens[cIndex + 1];
          if (nested) {
            surfaces.push(...this._markNested(
              this._parsePowerShell(toolName, nested, this._childContext(ctx)),
              `${canonicalCmd}-command`,
              false
            ));
          }
        }

        const fileIndex = this._findPowerShellOptionIndex(tokens, offset + 1, ['file', 'f']);
        if (fileIndex >= 0) {
          const scriptPath = this._optionAttachedValue(tokens[fileIndex]) || tokens[fileIndex + 1];
          if (scriptPath) surfaces.push(...this._parseKnownPowerShellScript(toolName, scriptPath, ctx, segment));
        }
      }

      if (canonicalCmd === 'cmd' && tokens[offset + 1] && /^\/c$/i.test(tokens[offset + 1])) {
        const nested = tokens.slice(offset + 2).join(' ');
        surfaces.push(...this._markNested(
          this._parseCmd(toolName, nested, this._childContext(ctx)),
          'powershell-cmd-c-inner',
          false
        ));
      }

      if (canonicalCmd === 'wsl' && tokens[offset + 1]) {
        surfaces.push(...this._markNested(
          this._parsePosix(toolName, tokens.slice(offset + 1).join(' '), this._childContext(ctx)),
          'wsl-inner',
          false
        ));
      }

      if (canonicalCmd === 'ssh') {
        const nested = this._sshNestedCommand(tokens.slice(offset + 1));
        if (nested) {
          surfaces.push(...this._markNested(
            this._parsePosix(toolName, nested, this._childContext(ctx)),
            'powershell-ssh-inner',
            true
          ));
        }
      }

      if (/^(?:\.\\|\.\/|[A-Za-z]:\\|\\\\|\/|~[\\/]).+\.ps1$/i.test(this._cleanPathToken(cmdRaw))) {
        surfaces.push(...this._parseKnownPowerShellScript(toolName, cmdRaw, ctx, segment));
      }
    }

    return this._dedupeSurfaces(surfaces);
  }

  // ========================================================================
  // cmd.exe parser
  // ========================================================================

  _parseCmd(toolName, command, ctx = {}) {
    ctx = this._normalizeContext(ctx);
    const input = this._boundedInput(command);
    if (!input.trim()) return [];
    if (ctx.depth > this.options.maxDepth) {
      return [this._makeSurface(toolName, '<parse-depth-limit>', ['<parse-depth-limit>'], 'cmd-parse-depth-limit', input, { opaque: true })];
    }

    const surfaces = [];
    for (const segment of this._splitCmdCommands(input)) {
      const tokens = this._tokenizeCmd(segment);
      if (!tokens.length) continue;
      const cmdRaw = tokens[0];
      const cmd = this._normalizeCommand(cmdRaw);
      surfaces.push(this._makeSurface(toolName, cmdRaw, tokens, 'cmd-direct', segment));

      if ((cmd === 'cmd' || cmd === 'command') && tokens[1] && /^\/c$/i.test(tokens[1])) {
        surfaces.push(...this._markNested(
          this._parseCmd(toolName, tokens.slice(2).join(' '), this._childContext(ctx)),
          'cmd-c-inner',
          false
        ));
      }

      if (cmd === 'powershell' || cmd === 'pwsh') {
        surfaces.push(...this._markNested(
          this._parsePowerShell(toolName, tokens.slice(1).join(' '), this._childContext(ctx)),
          'cmd-powershell-inner',
          false
        ));
      }

      if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'wsl'].includes(cmd)) {
        surfaces.push(...this._markNested(
          this._parsePosix(toolName, tokens.slice(1).join(' '), this._childContext(ctx)),
          'cmd-posix-inner',
          false
        ));
      }
    }
    return this._dedupeSurfaces(surfaces);
  }

  // ========================================================================
  // MCP helpers
  // ========================================================================

  _extractMcpSurfaces(toolName, toolInput, ctx) {
    const surfaces = [this._makeSurface(toolName, toolName, [toolName], 'mcp-tool-name', '', { remote: true, opaque: true })];

    for (const field of ['command', 'cmd', 'script']) {
      if (typeof toolInput[field] !== 'string' || !toolInput[field].trim()) continue;

      const shellKind = this._mcpShellKind(toolInput.shell || toolInput.interpreter);
      if (shellKind === 'powershell') {
        surfaces.push(...this._markNested(this._parsePowerShell(toolName, toolInput[field], this._childContext(ctx)), `mcp-${field}`, true));
      } else if (shellKind === 'cmd') {
        surfaces.push(...this._markNested(this._parseCmd(toolName, toolInput[field], this._childContext(ctx)), `mcp-${field}`, true));
      } else if (shellKind === 'posix' || shellKind === '') {
        surfaces.push(...this._markNested(this._parsePosix(toolName, toolInput[field], this._childContext(ctx)), `mcp-${field}`, true));
      } else {
        surfaces.push(this._makeSurface(toolName, '<opaque-command-field>', ['<opaque-command-field>'], `mcp-${field}-unknown-shell:${shellKind}`, toolInput[field], { remote: true, opaque: true }));
      }
    }

    return surfaces;
  }

  _mcpShellKind(shell) {
    if (!shell) return '';
    const s = this._normalizeCommand(shell);
    if (s === 'powershell' || s === 'pwsh') return 'powershell';
    if (s === 'cmd' || s === 'command') return 'cmd';
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(s)) return 'posix';
    return s;
  }

  // ========================================================================
  // POSIX utilities
  // ========================================================================

  _splitShellCommands(input) {
    const out = [];
    let buf = '';
    let quote = null;
    let esc = false;

    const flush = () => {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    };

    const s = String(input || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];

      if (esc) { buf += c; esc = false; continue; }
      if (c === '\\' && quote !== "'") { buf += c; esc = true; continue; }

      if (quote) {
        if (c === quote) quote = null;
        buf += c;
        continue;
      }

      if (c === "'" || c === '"') { quote = c; buf += c; continue; }

      if (c === '#' && this._isShellCommentStart(s, i)) {
        while (i < s.length && s[i] !== '\n') i++;
        flush();
        continue;
      }

      const two = c + n;
      if (two === '&&' || two === '||' || two === '|&') {
        flush();
        i++;
        continue;
      }

      const ampersandIsRedirect = c === '&' && (s[i - 1] === '>' || s[i - 1] === '<' || n === '>');
      if (c === ';' || c === '|' || (!ampersandIsRedirect && c === '&') || c === '\n') {
        flush();
        continue;
      }

      buf += c;
    }

    flush();
    return out;
  }

  _tokenizeShell(segment) {
    const tokens = [];
    let buf = '';
    let quote = null;
    let esc = false;
    const s = String(segment || '');
    const flush = () => { if (buf.length) { tokens.push(buf); buf = ''; } };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];

      if (esc) { buf += c; esc = false; continue; }
      if (c === '\\' && quote !== "'") { esc = true; continue; }

      if (quote) {
        if (c === quote) { quote = null; continue; }
        buf += c;
        continue;
      }

      if (c === "'" || c === '"') { quote = c; continue; }

      if (c === '#' && buf.length === 0 && this._isShellCommentStart(s, i)) break;
      if (/\s/.test(c)) { flush(); continue; }

      const op = this._readShellOperator(s, i);
      if (op) {
        flush();
        tokens.push(op.text);
        i += op.length - 1;
        continue;
      }

      if ('(){};'.includes(c)) {
        flush();
        tokens.push(c);
        continue;
      }

      buf += c;
    }

    flush();
    return tokens.filter(Boolean);
  }

  _readShellOperator(s, i) {
    const rest = s.slice(i);

    const fd = rest.match(/^\d+(?:>>|>\||>&\d+|>&-|>&|>|<<-|<<<|<<|<&\d+|<&-|<&|<>|<)/);
    if (fd) {
      const text = fd[0];
      if (/^\d+>$/.test(text) || /^\d+>>$/.test(text) || /^\d+>\|$/.test(text) || /^\d+<$/.test(text) || /^\d+<<-?$/.test(text) || /^\d+<>$/.test(text)) {
        return { text, length: text.length };
      }
      return { text, length: text.length };
    }

    for (const op of ['&>>', '<<<', '<<-', '>>', '<<', '<>', '>|', '>&', '<&', '&>', '&&', '||', '|&']) {
      if (rest.startsWith(op)) return { text: op, length: op.length };
    }

    if ('<>|&'.includes(s[i])) return { text: s[i], length: 1 };
    return null;
  }

  _isShellCommentStart(input, index) {
    if (input[index] !== '#') return false;
    if (index === 0) return true;
    const prev = input[index - 1];
    return /\s/.test(prev) || ';|&<>(){}'.includes(prev);
  }

  _collectHereDocs(command) {
    const scriptBodies = new Map();
    const inlineShellBodies = [];
    const stripped = [];
    const lines = String(command || '').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const markers = this._findHereDocMarkers(line);
      if (!markers.length) {
        stripped.push(line);
        continue;
      }

      stripped.push(line);
      const bodies = [];
      let cursor = i;
      for (const marker of markers) {
        const bodyLines = [];
        let j = cursor + 1;
        for (; j < lines.length; j++) {
          const candidate = marker.stripTabs ? lines[j].replace(/^\t+/, '') : lines[j];
          if (candidate === marker.word) break;
          bodyLines.push(marker.stripTabs ? lines[j].replace(/^\t+/, '') : lines[j]);
        }
        bodies.push(bodyLines.join('\n'));
        cursor = j;
      }
      i = cursor;

      const headerTokens = this._tokenizeShell(line);
      const redirectTarget = this._findRedirectTarget(headerTokens) || this._findTeeTarget(headerTokens);
      const firstIndex = this._firstCommandIndex(headerTokens);
      const firstCmd = firstIndex === null ? '' : this._normalizeCommand(headerTokens[firstIndex]);

      if (redirectTarget && this._isPosixScriptPath(redirectTarget)) {
        this._rememberScriptBody(scriptBodies, redirectTarget, bodies.join('\n'));
      } else if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(firstCmd)) {
        inlineShellBodies.push({ via: firstCmd, bodies, remote: false });
      } else if (firstCmd === 'ssh') {
        inlineShellBodies.push({ via: firstCmd, bodies, remote: true });
      }
    }

    return { strippedCommand: stripped.join('\n'), scriptBodies, inlineShellBodies };
  }

  _findHereDocMarkers(line) {
    const markers = [];
    let quote = null;
    let esc = false;
    const s = String(line || '');

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && quote !== "'") { esc = true; continue; }

      if (quote) {
        if (c === quote) quote = null;
        continue;
      }

      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '#' && this._isShellCommentStart(s, i)) break;

      if (s.startsWith('<<<', i)) { i += 2; continue; }
      if (!s.startsWith('<<', i)) continue;

      let j = i + 2;
      let stripTabs = false;
      if (s[j] === '-') { stripTabs = true; j++; }
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j >= s.length) continue;

      let word = '';
      if (s[j] === "'" || s[j] === '"') {
        const q = s[j++];
        while (j < s.length && s[j] !== q) word += s[j++];
      } else {
        while (j < s.length && !/\s/.test(s[j]) && !';|&<>(){}'.includes(s[j])) word += s[j++];
      }

      if (word) markers.push({ word, stripTabs });
      i = j;
    }

    return markers;
  }

  _extractCommandSubstitutions(input) {
    const inners = [];
    const s = String(input || '');
    let inSingle = false;
    let esc = false;

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];

      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === "'") { inSingle = !inSingle; continue; }
      if (inSingle) continue;

      if (c === '`') {
        let body = '';
        let j = i + 1;
        let innerEsc = false;
        for (; j < s.length; j++) {
          const x = s[j];
          if (innerEsc) {
            body += x === '`' ? '`' : `\\${x}`;
            innerEsc = false;
            continue;
          }
          if (x === '\\') { innerEsc = true; continue; }
          if (x === '`') break;
          body += x;
        }
        if (body.trim()) inners.push(body);
        i = j;
        continue;
      }

      const startsParenSub = (c === '$' && n === '(') || ((c === '<' || c === '>') && n === '(');
      if (!startsParenSub) continue;

      let depth = 1;
      let body = '';
      let quote = null;
      let innerEsc = false;
      let j = i + 2;

      for (; j < s.length; j++) {
        const x = s[j];
        if (innerEsc) { body += x; innerEsc = false; continue; }
        if (x === '\\' && quote !== "'") { body += x; innerEsc = true; continue; }
        if (quote) {
          if (x === quote) quote = null;
          body += x;
          continue;
        }
        if (x === "'" || x === '"') { quote = x; body += x; continue; }
        if (x === '(') { depth++; body += x; continue; }
        if (x === ')') {
          depth--;
          if (depth === 0) break;
          body += x;
          continue;
        }
        body += x;
      }

      if (body.trim()) inners.push(body);
      i = j;
    }

    return inners;
  }

  _extractPosixFunctionDefinitions(input) {
    const functions = new Map();
    const s = String(input || '');
    const pattern = /\b(?:function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*\))?\s*|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*)\{/g;
    let out = '';
    let last = 0;
    let match;

    while ((match = pattern.exec(s))) {
      if (!this._isPosixCodePosition(s, match.index)) continue;
      const name = match[1] || match[2];
      if (!name || this._isReservedFunctionName(name)) continue;
      const open = s.indexOf('{', match.index + match[0].length - 1);
      if (open < 0) continue;
      const close = this._findMatchingPosixBrace(s, open);
      if (close < 0) continue;

      const body = s.slice(open + 1, close);
      functions.set(name.toLowerCase(), body);
      out += s.slice(last, match.index) + '; ';
      last = close + 1;
      pattern.lastIndex = close + 1;
    }

    out += s.slice(last);
    return { strippedCommand: out, functions };
  }

  _isPosixCodePosition(input, index) {
    let quote = null;
    let esc = false;
    for (let i = 0; i < index; i++) {
      const c = input[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && quote !== "'") { esc = true; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '#' && this._isShellCommentStart(input, i)) {
        while (i < index && input[i] !== '\n') i++;
      }
    }
    return !quote;
  }

  _findMatchingPosixBrace(input, openIndex) {
    let depth = 1;
    let quote = null;
    let esc = false;
    for (let i = openIndex + 1; i < input.length; i++) {
      const c = input[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && quote !== "'") { esc = true; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '#' && this._isShellCommentStart(input, i)) {
        while (i < input.length && input[i] !== '\n') i++;
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  _isReservedFunctionName(name) {
    return new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'case', 'do', 'done', 'function']).has(String(name).toLowerCase());
  }

  _firstCommandIndex(tokens) {
    if (!tokens.length) return null;
    if (['for', 'select', 'case', 'function'].includes(tokens[0])) return null;

    let i = 0;
    while (i < tokens.length) {
      if (this._isControlTerminator(tokens[i])) return null;
      if (this._isControlWord(tokens[i])) { i++; continue; }
      if (this._isAssignment(tokens[i])) { i++; continue; }
      const redirect = this._redirectInfo(tokens[i]);
      if (redirect) { i += redirect.consumesValue ? 2 : 1; continue; }
      break;
    }

    if (i >= tokens.length || this._isControlTerminator(tokens[i])) return null;
    return i;
  }

  _stripPosixPrefixWrappers(tokens, start) {
    const wrappers = [];
    let i = start;

    while (i < tokens.length) {
      while (i < tokens.length && (this._isControlWord(tokens[i]) || this._isAssignment(tokens[i]))) i++;
      while (i < tokens.length && this._redirectInfo(tokens[i])) {
        const info = this._redirectInfo(tokens[i]);
        i += info.consumesValue ? 2 : 1;
      }
      if (i >= tokens.length) break;

      const cmd = this._normalizeCommand(tokens[i]);
      if (!cmd) break;

      if (cmd === 'sudo') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length) {
          if (tokens[i] === '--') { i++; break; }
          if (!tokens[i].startsWith('-')) break;
          const opt = tokens[i++];
          if (this._optionTakesValue(opt, new Set(['-u', '-g', '-h', '-p', '--user', '--group', '--host', '--prompt']))) i++;
        }
        continue;
      }

      if (cmd === 'env') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length) {
          if (tokens[i] === '--') { i++; break; }
          if (this._isAssignment(tokens[i])) { i++; continue; }
          if (tokens[i] === '-u' || tokens[i] === '--unset' || tokens[i] === '-S' || tokens[i] === '--split-string') { i += 2; continue; }
          if (tokens[i].startsWith('--unset=') || tokens[i].startsWith('--split-string=')) { i++; continue; }
          if (tokens[i].startsWith('-')) { i++; continue; }
          break;
        }
        continue;
      }

      if (cmd === 'command' || cmd === 'builtin') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length && (tokens[i] === '-p' || tokens[i] === '--')) {
          if (tokens[i] === '--') { i++; break; }
          i++;
        }
        continue;
      }

      if (cmd === 'exec') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length) {
          if (tokens[i] === '--') { i++; break; }
          if (tokens[i] === '-a') { i += 2; continue; }
          if (tokens[i] === '-c' || tokens[i] === '-l') { i++; continue; }
          break;
        }
        continue;
      }

      if (cmd === 'time') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length && tokens[i].startsWith('-')) i++;
        continue;
      }

      if (cmd === 'timeout') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length && tokens[i].startsWith('-')) {
          const opt = tokens[i++];
          if (this._optionTakesValue(opt, new Set(['-k', '--kill-after', '-s', '--signal']))) i++;
        }
        if (i < tokens.length && /^\d+(?:\.\d+)?[smhd]?$/i.test(tokens[i])) i++;
        continue;
      }

      if (cmd === 'nice') {
        wrappers.push({ command: tokens[i++] });
        if (tokens[i] === '-n' || tokens[i] === '--adjustment') i += 2;
        else if (tokens[i] && (tokens[i].startsWith('-n') || tokens[i].startsWith('--adjustment='))) i++;
        continue;
      }

      if (cmd === 'nohup') {
        wrappers.push({ command: tokens[i++] });
        continue;
      }

      if (cmd === 'stdbuf') {
        wrappers.push({ command: tokens[i++] });
        while (i < tokens.length && /^-(?:i|o|e)/.test(tokens[i])) i++;
        continue;
      }

      break;
    }

    return { index: i, wrappers };
  }

  _captureAlias(tokens, aliases) {
    if (this._normalizeCommand(tokens[0]) !== 'alias') return;
    for (const token of tokens.slice(1)) {
      const m = token.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/);
      if (m) aliases.set(m[1].toLowerCase(), m[2]);
    }
  }

  _captureInlineScriptWrite(tokens, scriptBodies) {
    const cmd = this._normalizeCommand(tokens[0]);

    if (cmd === 'cp' && tokens.length >= 3) {
      const source = tokens[tokens.length - 2];
      const targetPath = tokens[tokens.length - 1];
      if (this._isPosixScriptPath(targetPath)) {
        const body = this._lookupScriptBody(scriptBodies, source);
        if (body) this._rememberScriptBody(scriptBodies, targetPath, body);
      }
      return;
    }

    const target = this._findRedirectTarget(tokens) || this._findTeeTarget(tokens);
    if (!target || !this._isPosixScriptPath(target)) return;

    if (cmd === 'echo') {
      this._rememberScriptBody(scriptBodies, target, this._tokensWithoutRedirects(tokens.slice(1)).join(' '));
      return;
    }

    if (cmd === 'printf') {
      const raw = this._tokensWithoutRedirects(tokens.slice(1)).join(' ');
      this._rememberScriptBody(scriptBodies, target, raw.replace(/%s\\n|%s|\\n/g, '\n'));
      return;
    }

    if (cmd === 'tee') {
      const hereString = tokens.indexOf('<<<');
      if (hereString >= 0 && tokens[hereString + 1]) {
        this._rememberScriptBody(scriptBodies, target, tokens.slice(hereString + 1).join(' '));
      }
      return;
    }


    if (cmd === 'cat') {
      const hereString = tokens.indexOf('<<<');
      if (hereString >= 0 && tokens[hereString + 1]) {
        this._rememberScriptBody(scriptBodies, target, tokens.slice(hereString + 1).join(' '));
        return;
      }
      const source = tokens.slice(1).find(t => !this._redirectInfo(t) && t !== target && this._lookupScriptBody(scriptBodies, t));
      if (source) this._rememberScriptBody(scriptBodies, target, this._lookupScriptBody(scriptBodies, source));
    }
  }

  _tokensWithoutRedirects(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const info = this._redirectInfo(tokens[i]);
      if (info) {
        if (info.consumesValue) i++;
        continue;
      }
      out.push(tokens[i]);
    }
    return out;
  }

  _parseKnownPosixScript(toolName, scriptPath, ctx, segment) {
    const clean = this._cleanPathToken(scriptPath);
    const body = this._lookupScriptBody(ctx.scriptBodies, clean);

    if (!body) {
      if (!this.options.includeOpaqueScriptExecutions) return [];
      return [this._makeSurface(toolName, clean, [clean], 'posix-opaque-script-exec', segment, { opaque: true })];
    }

    const key = this._canonicalPathKey(clean);
    if (ctx.seenScripts.has(key)) return [];
    const child = this._childContext(ctx);
    child.seenScripts.add(key);

    return this._markNested(
      this._parsePosix(toolName, body, child),
      `script:${clean}`,
      false
    );
  }

  _findShellCIndex(tokens, start) {
    for (let i = start; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '-c') return i;
      if (/^-[A-Za-z]{1,4}$/.test(t) && t.includes('c') && tokens[i + 1]) return i;
      if (t === '--') break;
    }
    return -1;
  }

  _nextShellScriptArg(tokens, start) {
    const longValueOptions = new Set(['--rcfile', '--init-file']);
    const longNoValueOptions = new Set(['--debugger', '--dump-po-strings', '--dump-strings', '--help', '--login', '--noediting', '--noprofile', '--norc', '--posix', '--pretty-print', '--restricted', '--verbose', '--version']);

    for (let i = start; i < tokens.length; i++) {
      const t = tokens[i];
      if (this._redirectInfo(t)) { const info = this._redirectInfo(t); if (info.consumesValue) i++; continue; }
      if (t === '--') continue;
      if (t === '-c') return null;
      if (/^-[A-Za-z]{1,4}$/.test(t)) {
        if (t.includes('c')) return null;
        continue;
      }
      if (longValueOptions.has(t)) { i++; continue; }
      if (longNoValueOptions.has(t) || t.startsWith('--rcfile=') || t.startsWith('--init-file=')) continue;
      if (t.startsWith('-')) return null;
      return t;
    }
    return null;
  }

  _xargsNestedCommand(tokens) {
    let i = 0;
    const valueShort = new Set(['-I', '-E', '-P', '-S', '-s', '-n', '-L', '-l', '-d', '-a']);
    const valueLong = new Set(['--replace', '--max-procs', '--process-slot-var', '--delimiter', '--arg-file', '--max-args', '--max-lines', '--max-chars', '--eof']);

    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--') { i++; break; }
      if (!t.startsWith('-') || t === '-') break;

      if (/^-[nLsP]\S+/.test(t) || /^-I\S+/.test(t) || /^-d\S+/.test(t) || /^-a\S+/.test(t)) { i++; continue; }
      if (this._optionTakesValue(t, valueShort) || this._optionTakesValue(t, valueLong)) { i += 2; continue; }
      i++;
    }

    return i < tokens.length ? tokens.slice(i).join(' ') : null;
  }

  _findExecNestedCommands(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== '-exec' && tokens[i] !== '-execdir') continue;
      const body = [];
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j] === ';' || tokens[j] === '+') break;
        body.push(tokens[j]);
      }
      if (body.length) out.push(body.join(' '));
    }
    return out;
  }

  // ========================================================================
  // Remote/container/cloud nested command extractors
  // ========================================================================

  _sshNestedCommand(tokens) {
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--') { i++; break; }
      if (!t.startsWith('-') || t === '-') break;

      if (/^-[bcDEeFIiJLlmOopQRSWw]$/.test(t)) { i += 2; continue; }
      if (/^-o$/i.test(t)) { i += 2; continue; }
      if (/^-o\S+/i.test(t)) { i++; continue; }
      if (/^-[bcDEeFIiJLlmOopQRSWw].+/.test(t)) { i++; continue; }
      if (/^-[A-Za-z]+$/.test(t)) {
        const chars = t.slice(1);
        const valueFlags = 'bcDEeFIiJLlmOopQRSWw';
        const valueIndex = [...chars].findIndex(ch => valueFlags.includes(ch));
        if (valueIndex >= 0 && valueIndex === chars.length - 1) i += 2;
        else i++;
        continue;
      }
      i++;
    }

    if (i >= tokens.length) return null;
    i++; // host
    return i < tokens.length ? tokens.slice(i).join(' ') : null;
  }

  _dockerNestedCommand(tokens) {
    let subIndex = 0;
    while (subIndex < tokens.length && tokens[subIndex].startsWith('-')) {
      const opt = tokens[subIndex++];
      if (this._optionTakesValue(opt, new Set(['--context', '-H', '--host', '--config']))) subIndex++;
    }

    const sub = tokens[subIndex];
    if (!['exec', 'run'].includes(sub)) return null;

    let i = subIndex + 1;
    const valueOpts = new Set([
      '-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--name', '--hostname', '-h',
      '--network', '--entrypoint', '-v', '--volume', '--mount', '-p', '--publish', '--label', '-l',
      '--add-host', '--cap-add', '--cap-drop', '--device', '--restart', '--memory', '-m', '--cpus',
      '--platform', '--pull', '--ulimit', '--userns', '--ipc', '--pid', '--group-add', '--dns',
      '--dns-search', '--log-driver', '--log-opt', '--health-cmd', '--stop-signal', '--workdir',
    ]);

    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--') { i++; break; }
      if (!t.startsWith('-') || t === '-') break;
      if (/^-[evupmhwl]\S+/.test(t) && !valueOpts.has(t)) { i++; continue; }
      if (this._optionTakesValue(t, valueOpts)) { i += 2; continue; }
      i++;
    }

    if (i >= tokens.length) return null;
    i++; // container for exec; image for run
    return i < tokens.length ? tokens.slice(i).join(' ') : null;
  }

  _kubectlExecNestedCommand(tokens) {
    let i = 0;
    i = this._skipKubectlOptions(tokens, i);
    if (tokens[i] !== 'exec') return null;
    i++;

    const doubleDash = tokens.indexOf('--', i);
    if (doubleDash >= 0 && doubleDash + 1 < tokens.length) return tokens.slice(doubleDash + 1).join(' ');

    i = this._skipKubectlOptions(tokens, i);
    if (i >= tokens.length) return null;
    i++; // pod name
    i = this._skipKubectlOptions(tokens, i);
    return i < tokens.length ? tokens.slice(i).join(' ') : null;
  }

  _skipKubectlOptions(tokens, start) {
    let i = start;
    const valueOpts = new Set(['-c', '--container', '-n', '--namespace', '--context', '--kubeconfig', '--as', '--as-group', '--user', '--cluster', '--request-timeout', '--pod-running-timeout', '-f', '--filename']);
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === '--') return i;
      if (!t.startsWith('-') || t === '-') break;
      if (this._optionTakesValue(t, valueOpts)) i += 2;
      else i++;
    }
    return i;
  }

  _gcloudNestedCommand(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--command' && tokens[i + 1]) return tokens[i + 1];
      if (tokens[i].startsWith('--command=')) return tokens[i].slice('--command='.length);
    }
    return null;
  }

  _awsNestedCommands(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if ((t === '--parameters' || t === '--cli-input-json') && tokens[i + 1]) {
        out.push(...this._extractAwsCommands(tokens[i + 1]));
        i++;
        continue;
      }
      if (t.startsWith('--parameters=')) out.push(...this._extractAwsCommands(t.slice('--parameters='.length)));
      if (t.startsWith('--cli-input-json=')) out.push(...this._extractAwsCommands(t.slice('--cli-input-json='.length)));
      if (/^commands?=/i.test(t)) out.push(...this._extractAwsCommands(t));
    }
    return this._uniqueStrings(out).filter(Boolean);
  }

  _extractAwsCommands(value) {
    const raw = this._cleanPathToken(value);
    const out = [];

    try {
      const parsed = JSON.parse(raw);
      const collect = obj => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { for (const v of obj) collect(v); return; }
        for (const [k, v] of Object.entries(obj)) {
          if (/^commands?$/i.test(k)) {
            if (Array.isArray(v)) out.push(...v.map(String));
            else if (typeof v === 'string') out.push(v);
          } else collect(v);
        }
      };
      collect(parsed);
      if (out.length) return out;
    } catch (_) {
      // Fall through to CLI shorthand parsing.
    }

    const shorthand = raw.match(/commands?=\[?(.+)\]?$/i);
    if (shorthand) {
      const body = shorthand[1].replace(/^['"]|['"]$/g, '').replace(/\]$/, '');
      return body.split(/,(?=\s*[^\s])/).map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }

    const jsonish = [...raw.matchAll(/["']commands?["']\s*:\s*\[([^\]]+)\]/ig)];
    for (const m of jsonish) {
      out.push(...m[1].split(/,(?=\s*['"]?\S)/).map(s => s.trim().replace(/^['"]|['"]$/g, '')));
    }
    return out;
  }

  _azNestedCommands(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      if ((tokens[i] === '--scripts' || tokens[i] === '--script') && tokens[i + 1]) { out.push(tokens[i + 1]); i++; continue; }
      if (tokens[i].startsWith('--scripts=')) out.push(tokens[i].slice('--scripts='.length));
      if (tokens[i].startsWith('--script=')) out.push(tokens[i].slice('--script='.length));
    }
    return out;
  }

  // ========================================================================
  // PowerShell utilities
  // ========================================================================

  _splitPowerShellCommands(input) {
    const out = [];
    let buf = '';
    let quote = null;
    let esc = false;
    let braceDepth = 0;
    let parenDepth = 0;
    const s = String(input || '');

    const flush = () => {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];

      if (esc) { buf += c; esc = false; continue; }
      if (c === '`') { buf += c; esc = true; continue; }

      if (quote) {
        if (c === quote) quote = null;
        buf += c;
        continue;
      }

      if (c === "'" || c === '"') { quote = c; buf += c; continue; }
      if (c === '#') { while (i < s.length && s[i] !== '\n') i++; flush(); continue; }
      if (c === '{') { braceDepth++; buf += c; continue; }
      if (c === '}') { braceDepth = Math.max(0, braceDepth - 1); buf += c; continue; }
      if (c === '(') { parenDepth++; buf += c; continue; }
      if (c === ')') { parenDepth = Math.max(0, parenDepth - 1); buf += c; continue; }

      const two = c + n;
      if (braceDepth === 0 && parenDepth === 0 && (two === '&&' || two === '||')) {
        flush();
        i++;
        continue;
      }

      if (braceDepth === 0 && parenDepth === 0 && (c === ';' || c === '|' || c === '\n')) {
        flush();
        continue;
      }

      buf += c;
    }

    flush();
    return out;
  }

  _tokenizePowerShell(segment) {
    const s = String(segment || '').replace(/`\r?\n/g, ' ');
    const tokens = [];
    let buf = '';
    let quote = null;
    let esc = false;
    const flush = () => { if (buf.length) { tokens.push(buf); buf = ''; } };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];

      if (esc) { buf += c; esc = false; continue; }
      if (c === '`') { esc = true; continue; }

      if (quote) {
        if (c === quote) {
          if (quote === "'" && n === "'") { buf += "'"; i++; continue; }
          quote = null;
          continue;
        }
        buf += c;
        continue;
      }

      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '#') break;
      if (/\s/.test(c)) { flush(); continue; }
      if ((c === '&' || c === '|') && n === c) { flush(); tokens.push(c + n); i++; continue; }
      if ('{}()|;&,'.includes(c)) { flush(); tokens.push(c); continue; }
      buf += c;
    }

    flush();
    return tokens.filter(Boolean);
  }

  _powerShellAlias(cmd) {
    const aliases = new Map(Object.entries({
      iex: 'invoke-expression',
      saps: 'start-process',
      start: 'start-process',
      ii: 'invoke-item',
      irm: 'invoke-restmethod',
      iwr: 'invoke-webrequest',
      curl: 'invoke-webrequest',
      wget: 'invoke-webrequest',
      '%': 'foreach-object',
      '?': 'where-object',
      foreach: 'foreach-object',
      where: 'where-object',
      'powershell.exe': 'powershell',
      'pwsh.exe': 'pwsh',
      'cmd.exe': 'cmd',
    }));
    return aliases.get(cmd) || cmd;
  }

  _powerShellCommandRunsScriptBlock(cmd) {
    return new Set(['invoke-command', 'start-job', 'foreach-object', 'where-object', 'foreach']).has(cmd);
  }

  _extractPowerShellScriptBlocks(segment) {
    const blocks = [];
    const s = String(segment || '');
    let quote = null;
    let esc = false;

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '`') { esc = true; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c !== '{') continue;

      let depth = 1;
      let body = '';
      let q2 = null;
      let e2 = false;
      let j = i + 1;
      for (; j < s.length; j++) {
        const x = s[j];
        if (e2) { body += x; e2 = false; continue; }
        if (x === '`') { e2 = true; continue; }
        if (q2) { if (x === q2) q2 = null; body += x; continue; }
        if (x === "'" || x === '"') { q2 = x; body += x; continue; }
        if (x === '{') { depth++; body += x; continue; }
        if (x === '}') {
          depth--;
          if (depth === 0) break;
          body += x;
          continue;
        }
        body += x;
      }
      if (body.trim()) blocks.push(body);
      i = j;
    }

    return blocks;
  }

  _capturePowerShellScriptWrite(tokens, scriptBodies) {
    const cmd = this._powerShellAlias(this._normalizeCommand(tokens[0]));
    if (cmd !== 'set-content' && cmd !== 'out-file' && cmd !== 'add-content') return;

    const path = this._psOptionValues(tokens, ['path', 'literalpath', 'filepath'])[0] || this._firstPs1Token(tokens);
    const values = this._psOptionValues(tokens, ['value', 'inputobject']);
    if (path && values.length && /\.ps1$/i.test(path)) {
      this._rememberScriptBody(scriptBodies, path, values.join(' '));
    }
  }

  _parseKnownPowerShellScript(toolName, scriptPath, ctx, segment) {
    const clean = this._cleanPathToken(scriptPath);
    const body = this._lookupScriptBody(ctx.scriptBodies, clean);

    if (!body) {
      if (!this.options.includeOpaqueScriptExecutions) return [];
      return [this._makeSurface(toolName, clean, [clean], 'powershell-opaque-script-exec', segment, { opaque: true })];
    }

    const key = this._canonicalPathKey(clean);
    if (ctx.seenScripts.has(key)) return [];
    const child = this._childContext(ctx);
    child.seenScripts.add(key);

    return this._markNested(
      this._parsePowerShell(toolName, body, child),
      `script:${clean}`,
      false
    );
  }

  _powerShellStartProcessChild(tokens, offset) {
    const filePath = this._psOptionValues(tokens, ['filepath', 'path'])[0];
    const command = filePath || this._firstPowerShellPositional(tokens, offset + 1);
    if (!command) return null;

    const argValues = this._psOptionValues(tokens, ['argumentlist', 'args']);
    const args = [];
    for (const value of argValues) args.push(...this._tokenizePowerShell(value).filter(t => t !== ','));
    return { command, arguments: args };
  }

  _firstPowerShellPositional(tokens, start) {
    for (let i = start; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t || t === ',' || t === ')' || t === '(') continue;
      if (!t.startsWith('-')) return t;
      const consumed = this._consumePowerShellParameter(tokens, i);
      i = Math.max(i, consumed - 1);
    }
    return null;
  }

  _consumePowerShellParameter(tokens, index) {
    const valueParams = new Set([
      'filepath', 'path', 'literalpath', 'argumentlist', 'args', 'workingdirectory', 'verb', 'windowstyle',
      'redirectstandardoutput', 'redirectstandarderror', 'redirectstandardinput', 'credential', 'loaduserprofile',
    ]);
    const name = this._powerShellParameterName(tokens[index]);
    if (!name || ![...valueParams].some(p => p.startsWith(name))) return index + 1;
    if (this._optionAttachedValue(tokens[index]) !== null) return index + 1;
    let i = index + 1;
    while (i < tokens.length && tokens[i] !== ',' && !tokens[i].startsWith('-')) i++;
    return Math.max(index + 1, i);
  }

  _psOptionValues(tokens, names) {
    const canonical = names.map(n => n.toLowerCase());
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const name = this._powerShellParameterName(tokens[i]);
      if (!name || !canonical.some(n => n.startsWith(name) || name.startsWith(n))) continue;

      const attached = this._optionAttachedValue(tokens[i]);
      if (attached !== null) { out.push(attached); continue; }

      let j = i + 1;
      while (j < tokens.length) {
        const t = tokens[j];
        if (t === ',') { j++; continue; }
        if (t.startsWith('-')) break;
        if ([')', '}', '|', ';', '&', '&&', '||'].includes(t)) break;
        out.push(t.replace(/,$/, ''));
        j++;
      }
      i = j - 1;
    }
    return out.filter(Boolean);
  }

  _findPowerShellOptionIndex(tokens, start, names) {
    const canonical = names.map(n => n.toLowerCase());
    for (let i = start; i < tokens.length; i++) {
      const name = this._powerShellParameterName(tokens[i]);
      if (!name) continue;
      if (canonical.some(n => n.startsWith(name) || name.startsWith(n))) return i;
    }
    return -1;
  }

  _powerShellParameterName(token) {
    const m = String(token || '').match(/^-([A-Za-z][A-Za-z0-9]*)(?::|=)?/);
    return m ? m[1].toLowerCase() : '';
  }

  _optionAttachedValue(token) {
    const s = String(token || '');
    const idxColon = s.indexOf(':');
    const idxEq = s.indexOf('=');
    const indexes = [idxColon, idxEq].filter(i => i >= 0);
    if (!indexes.length) return null;
    const idx = Math.min(...indexes);
    return s.slice(idx + 1);
  }

  _decodePowerShellEncodedCommand(value) {
    if (!value) return '';
    try {
      return Buffer.from(String(value), 'base64').toString('utf16le').replace(/\0+$/g, '');
    } catch (_) {
      return '';
    }
  }

  _firstPs1Token(tokens) {
    return tokens.find(t => /\.ps1$/i.test(t)) || null;
  }

  // ========================================================================
  // cmd.exe utilities
  // ========================================================================

  _splitCmdCommands(input) {
    const out = [];
    let buf = '';
    let quote = false;
    let esc = false;
    const s = String(input || '');
    const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];
      if (esc) { buf += c; esc = false; continue; }
      if (c === '^') { esc = true; continue; }
      if (c === '"') { quote = !quote; buf += c; continue; }
      if (!quote && (c === '&' || c === '|' || c === '\n')) {
        flush();
        if (n === c) i++;
        continue;
      }
      buf += c;
    }
    flush();
    return out;
  }

  _tokenizeCmd(segment) {
    const tokens = [];
    let buf = '';
    let quote = false;
    let esc = false;
    const s = String(segment || '');
    const flush = () => { if (buf.length) { tokens.push(buf); buf = ''; } };

    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { buf += c; esc = false; continue; }
      if (c === '^') { esc = true; continue; }
      if (c === '"') { quote = !quote; continue; }
      if (!quote && /\s/.test(c)) { flush(); continue; }
      buf += c;
    }
    flush();
    return tokens.filter(Boolean);
  }

  // ========================================================================
  // General helpers
  // ========================================================================

  _makeSurface(toolName, commandRaw, argv = [], source, segment, flags = {}) {
    const rawArgv = (argv && argv.length ? argv : [commandRaw]).map(t => String(t || '')).filter(Boolean);
    const rawCommand = this._cleanCommandToken(commandRaw || rawArgv[0] || '');
    const normalizedCommand = flags.canonicalCommand || this._normalizeCommand(rawCommand);
    const command = rawCommand || normalizedCommand;

    const normalizedArgv = rawArgv.map((t, idx) => idx === 0 ? (normalizedCommand || this._normalizeCommand(t) || t) : t);
    const rawCommandLine = rawArgv.join(' ').trim();
    const commandLine = normalizedArgv.join(' ').trim();

    return {
      toolName,
      command,
      rawCommand: command,
      normalizedCommand,
      argv: normalizedArgv,
      rawArgv,
      commandLine,
      rawCommandLine,
      source,
      segment: String(segment || '').slice(0, 1000),
      remote: Boolean(flags.remote),
      opaque: Boolean(flags.opaque),
    };
  }

  _markNested(surfaces, sourcePrefix, remote) {
    return surfaces.map(surface => ({
      ...surface,
      source: `${sourcePrefix}:${surface.source}`,
      remote: Boolean(remote || surface.remote),
    }));
  }

  _dedupeSurfaces(surfaces) {
    const seen = new Set();
    const out = [];
    for (const surface of surfaces) {
      const key = [surface.toolName, surface.rawCommandLine, surface.commandLine, surface.source, surface.remote, surface.opaque].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(surface);
      if (out.length >= this.options.maxSurfaceCount) break;
    }
    return out;
  }

  _readCommandField(toolInput) {
    if (!toolInput || typeof toolInput !== 'object') return '';
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof toolInput[key] === 'string') return toolInput[key];
    }
    return '';
  }

  _normalizeCommand(value) {
    if (!value) return '';
    let s = this._cleanCommandToken(value);
    s = s.replace(/\\/g, '/');
    s = s.split('/').pop();
    s = s.replace(/\.(?:exe|cmd|bat|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msc)$/i, '');
    return s.toLowerCase();
  }

  _cleanCommandToken(value) {
    return String(value || '').trim().replace(/^['"]|['"]$/g, '');
  }

  _cleanPathToken(value) {
    return String(value || '').trim().replace(/^['"]|['"]$/g, '');
  }

  _basename(value) {
    return this._cleanPathToken(value).replace(/\\/g, '/').split('/').pop();
  }

  _canonicalPathKey(value) {
    return this._cleanPathToken(value).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  }

  _rememberScriptBody(map, path, body) {
    const clean = this._cleanPathToken(path);
    if (!clean) return;
    map.set(clean, body);
    map.set(this._canonicalPathKey(clean), body);
    map.set(this._basename(clean), body);
  }

  _lookupScriptBody(map, path) {
    const clean = this._cleanPathToken(path);
    return map.get(clean) || map.get(this._canonicalPathKey(clean)) || map.get(this._basename(clean)) || '';
  }

  _isPosixScriptPath(path) {
    return /\.(?:sh|bash|zsh|ksh)$/i.test(this._cleanPathToken(path));
  }

  _isAssignment(token) {
    return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token || '');
  }

  _redirectInfo(token) {
    const t = String(token || '');
    if (!t) return null;
    if (/^(?:\d*)?(?:>|>>|>\||<|<<|<<-|<<<|<>|&>|&>>)$/.test(t)) return { consumesValue: true };
    if (/^(?:\d*)?(?:>&|<&)$/.test(t)) return { consumesValue: true };
    if (/^(?:\d*)?(?:>&\d+|<&\d+|>&-|<&-)$/.test(t)) return { consumesValue: false };
    return null;
  }

  _isRedirect(token) {
    return Boolean(this._redirectInfo(token));
  }

  _isControlWord(token) {
    return new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '(', '{']).has(token);
  }

  _isControlTerminator(token) {
    return new Set(['fi', 'done', 'esac', '}', ')']).has(token);
  }

  _findRedirectTarget(tokens) {
    for (let i = 0; i < tokens.length; i++) {
      const info = this._redirectInfo(tokens[i]);
      if (!info || !info.consumesValue) continue;
      if (['<', '<<', '<<-', '<<<'].includes(tokens[i].replace(/^\d+/, ''))) continue;
      if (tokens[i + 1]) return tokens[i + 1];
    }
    return null;
  }

  _findTeeTarget(tokens) {
    if (this._normalizeCommand(tokens[0]) !== 'tee') return null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--') continue;
      if (tokens[i].startsWith('-')) continue;
      return tokens[i];
    }
    return null;
  }

  _nextNonOption(tokens, start) {
    for (let i = start; i < tokens.length; i++) {
      const info = this._redirectInfo(tokens[i]);
      if (info) { if (info.consumesValue) i++; continue; }
      if (tokens[i] === '--') continue;
      if (tokens[i].startsWith('-')) continue;
      return tokens[i];
    }
    return null;
  }

  _optionTakesValue(opt, valueOptions) {
    if (!opt) return false;
    if (opt.includes('=')) return false;
    if (valueOptions.has(opt)) return true;
    const base = opt.replace(/=.*/, '');
    if (valueOptions.has(base)) return true;
    return false;
  }

  _boundedInput(value) {
    const s = String(value || '');
    return s.length > this.options.maxInputLength ? s.slice(0, this.options.maxInputLength) : s;
  }

  _newContext() {
    return this._normalizeContext({});
  }

  _normalizeContext(ctx) {
    return {
      depth: Number.isFinite(ctx.depth) ? ctx.depth : 0,
      scriptBodies: ctx.scriptBodies || new Map(),
      seenScripts: ctx.seenScripts || new Set(),
      functions: ctx.functions || new Map(),
      aliases: ctx.aliases || new Map(),
      expandingAliases: ctx.expandingAliases || new Set(),
      executingFunctions: ctx.executingFunctions || new Set(),
    };
  }

  _childContext(ctx) {
    ctx = this._normalizeContext(ctx);
    return {
      depth: ctx.depth + 1,
      scriptBodies: ctx.scriptBodies,
      seenScripts: new Set(ctx.seenScripts),
      functions: ctx.functions,
      aliases: ctx.aliases,
      expandingAliases: new Set(ctx.expandingAliases),
      executingFunctions: new Set(ctx.executingFunctions),
    };
  }

  _uniqueStrings(values) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
      const s = String(value || '');
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  _escapeRegExp(value) {
    return String(value || '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  _escapeJsonString(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  }
}

module.exports = ClaudeCommandTriggerMatcher;
