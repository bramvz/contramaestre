# Claude Code hooks — team scaffolding

Single-entry-point hook router for Claude Code. Cross-platform (Windows + macOS + Linux).

## Layout

```
.claude/
├── settings.json                        # Hook config (checked in, shared)
└── hooks/
    ├── router.js                        # Single dispatcher for all hook events
    ├── README.md                        # This file
    ├── logs/                            # Per-invocation JSON logs (gitignored)
    │   └── .gitignore
    └── handlers/                        # One file per event, kebab-case
        ├── session-start.js             # dummy
        ├── session-end.js               # dummy
        ├── user-prompt-submit.js        # dummy
        ├── pre-tool-use.js              # dummy
        ├── post-tool-use.js             # dummy
        ├── notification.js              # dummy
        ├── stop.js                      # dummy
        ├── subagent-stop.js             # dummy
        └── pre-compact.js               # dummy
```

## How it wires together

`.claude/settings.json` registers every hook event with the same invocation —
`node .../router.js <EventName>`. For each event, the router:

1. Reads the stdin JSON payload from Claude Code.
2. **Writes an invocation log** to `logs/<sessionId>_<timestamp>.log` containing
   event name, argv, payload, `CLAUDE_*` env vars, and node info. Default
   **on** — set `CLAUDE_HOOK_LOG=0` (or `false`/`off`/`no`) to disable.
3. **Appends one line to a per-session master log** at
   `logs/master-<sessionId>.log` (same on/off knob). One line per module
   invocation, formatted `<isoTs>  <component(padded)>  <outcome>`. Outcomes
   are decoded from handler stdout (block / deny / allow / systemMessage)
   or the literal stdout if unrecognised.
4. Dispatches to `handlers/<event-name>.js` (kebab-case) if it exists.
5. Exits 0 so Claude continues normally.

If a handler is missing or throws, the router logs to stderr and still exits 0
— hooks never block Claude on internal failures.

## Requirements

- **Node.js** on `PATH` (any LTS version). That's it.
- No npm install. The router and handlers use only Node's built-in modules.

## Cross-platform notes

We use **exec form** for the hook command (`command: "node"`, with the script
path in `args`), not shell form. Exec form spawns Node directly with no shell,
so behavior is identical on Windows, macOS, and Linux. Shell form would resolve
through `sh` on Unix but Git Bash *or* PowerShell on Windows — error-prone.

`${CLAUDE_PROJECT_DIR}` is substituted by Claude Code to the repo root in both
`command` and `args` strings.

## Output channels — important

- **stderr** — surfaced to the user in real time. NOT fed back to the model.
  Use this for logging / observability messages.
- **stdout** — for some events (`SessionStart`, `UserPromptSubmit`, `PreCompact`)
  stdout is injected into Claude's context. Don't log to stdout unless you want
  Claude to see it. For structured control (block a tool, deny a permission,
  etc.), print a JSON object — see the hooks reference for the schema.
- **exit 0** — Claude continues normally.
- **exit 2** — blocking error (effect depends on event: blocks the tool call,
  rejects the prompt, prevents stop, etc.). stderr is shown to Claude so it
  can self-correct.
- **any other code** — non-blocking error; stderr is shown to the user.

The current router always exits 0. To implement a blocking handler, the handler
itself should call `process.exit(2)` after writing a reason to stderr.

## Invocation logs

Logging is **on by default**. Set `CLAUDE_HOOK_LOG=0` (or `false`/`off`/`no`)
in the environment to disable everything below.

### Per-invocation structured log

Every hook firing writes one file:

```
.claude/hooks/logs/<sessionId>_<isoTimestamp>.log
```

Contents (pretty-printed JSON):

```json
{
  "timestamp": "2026-05-15T12:34:56.789Z",
  "eventName": "SessionStart",
  "argv": ["SessionStart"],
  "cwd": "C:\\path\\to\\your-project",
  "projectDir": "C:\\path\\to\\your-project",
  "node": { "version": "v22.18.0", "platform": "win32", "arch": "x64" },
  "claudeEnv": { "CLAUDE_PROJECT_DIR": "...", "CLAUDE_CODE_SESSION_ID": "..." },
  "parseError": null,
  "payload": {
    "session_id": "...",
    "hook_event_name": "SessionStart",
    "source": "startup",
    ...
  }
}
```

### Per-session master log

One file per session, append-only, one line per module invocation:

```
.claude/hooks/logs/master-<sessionId>.log
```

Example tail:

```
2026-05-17T18:52:55.918Z  UserPromptSubmit                      no-op
2026-05-17T18:52:55.999Z  PreToolUse                            deny: Stop execution, tell user you tried to access a blocked path
2026-05-17T18:52:56.252Z  Stop:adr-review                       silent
2026-05-17T18:52:56.336Z  Stop:docs-review                      silent
2026-05-17T18:52:56.366Z  Stop:format                           silent
2026-05-17T18:52:56.366Z  Stop:dispatcher                       no-block
2026-05-17T18:52:56.366Z  Stop                                  no-op
```

The outcome string is decoded from whatever the handler wrote to stdout:
`block: <reason>`, `<permissionDecision>: <reason>`, `systemMessage: …`, or
the literal stdout truncated to 240 chars. Multi-line outcomes are
flattened with ` ⏎ ` so each entry stays one line. The dispatcher and
individual checks can append finer-grained entries by calling
`ctx.masterLog(component, outcome)`.

The `logs/` directory is gitignored except for `.gitignore` itself.

## Implementing a handler

Replace the no-op body with real logic. Handlers are functions:

```js
module.exports = function postToolUse(payload, ctx) {
  if (payload.tool_name !== 'Edit' && payload.tool_name !== 'Write') return;
  const filePath = payload.tool_input?.file_path;
  if (!filePath || !filePath.endsWith('.ts')) return;

  const { execSync } = require('child_process');
  try {
    execSync(`npx prettier --write "${filePath}"`, { stdio: 'inherit' });
  } catch (err) {
    process.stderr.write(`prettier failed: ${err.message}\n`);
    process.exit(2); // tell Claude to look at the failure
  }
};
```

The `ctx` argument provides:

| Field | Type | Notes |
|---|---|---|
| `eventName` | `string` | e.g. `"PostToolUse"` |
| `rawStdin` | `string` | Raw JSON string before parse |
| `argv` | `string[]` | `process.argv.slice(2)` |
| `env` | `NodeJS.ProcessEnv` | Full env |
| `projectDir` | `string` | `$CLAUDE_PROJECT_DIR` or `cwd` |
| `hooksDir` | `string` | `.claude/hooks` |
| `logsDir` | `string` | `.claude/hooks/logs` |
| `log(msg)` | `(string) => void` | Helper that writes to stderr |
| `masterLog(component, outcome)` | `(string, string) => void` | Append a fine-grained entry to the master log; no-op when logging is disabled |

## Verifying it works

After cloning, start a fresh Claude Code session in the repo. After session
start a file like
`.claude/hooks/logs/<sessionId>_2026-05-15T12-34-56-789Z.log` should appear.

You can also test the router manually without restarting Claude Code:

**PowerShell (Windows):**
```powershell
$env:CLAUDE_PROJECT_DIR = "$PWD"
'{"session_id":"test","hook_event_name":"SessionStart","source":"startup"}' | node .\.claude\hooks\router.js SessionStart
```

**bash / zsh (Mac/Linux):**
```bash
export CLAUDE_PROJECT_DIR="$PWD"
echo '{"session_id":"test","hook_event_name":"SessionStart","source":"startup"}' | node .claude/hooks/router.js SessionStart
```

A new log file should appear under `.claude/hooks/logs/`.
