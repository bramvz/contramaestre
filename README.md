# contramaestre — Claude Code scaffolding

Opinionated scaffolding for a Claude Code project that uses **hook-based
guardrails** (not advisory `CLAUDE.md` rules) to:

- Block reads/writes/deletes of sensitive paths.
- Gate destructive tool use behind explicit skill invocations.
- **Pause commit / push / merge / rebase / pull and `gh pr create|merge`**
  while a background documentation or ADR agent is still writing — so
  you never push half-finished bg changes (or push past them and leave
  a dirty tree).
- Nag (or, by default, **dispatch a background agent**) when source
  files change without their docs / ADRs being updated.
- Auto-format with prettier + eslint at the end of a session.

Everything is wired through one router (`.claude/hooks/router.js`) and a
handful of focused modules. The design tenet: **enforcement lives in
hooks, not in `CLAUDE.md`** — advisory rules drift under context pressure;
hooks always fire. See [ADR-001](docs/adr/0001-hooks-for-tracking-and-safe-editing.md).

---

## Using contramaestre in another project

Newscaff is consumed as a **git-based dev dependency** — no npm registry
publish needed. From your project:

```bash
npm install --save-dev github:your-user/contramaestre#v0.1.0
```

The `postinstall` step copies `.claude/` from `node_modules/contramaestre/`
into your project root with these rules:

- **Application code** (`hooks/router.js`, `hooks/handlers/**`,
  `hooks/checks/**`, `hooks/lib/**`, `hooks/README.md`, the schema
  reference docs) is **overwritten on every install**. Don't edit
  these — your edits will be wiped on the next `npm update contramaestre`.
- **Configs and skills** (`hooks/config/*.json`, `settings.json`,
  `skills/**/SKILL.md`) are **preserved if present**. Edit these
  freely; upgrades won't touch them. To force a refresh after a major
  upgrade: `npx contramaestre init --force`.
- **Runtime state** (`.state/`, `hooks/logs/*.log`) is **never copied
  or touched**.

### Required: install prettier + eslint yourself for auto-format

The Stop-time format check looks for `prettier` and `eslint` in your
project's `node_modules`. Newscaff lists them as its **own** devDeps
(for developing the scaffold), but those don't propagate to consumers
— npm doesn't install a dep's devDeps. **If you want the auto-format
check to activate, install the tools as your project's own direct
devDeps:**

```bash
npm install --save-dev prettier eslint @eslint/js typescript-eslint globals typescript
```

This is the standard pattern for shared JS tooling — see
`eslint-config-airbnb`, `@typescript-eslint/*`, `lint-staged`, etc. The
tools live in your project (you control versions); contramaestre composes
with them.

Without these installed, the format check is a silent no-op. Everything
else (AccessGuard, SkillGate, docs-review, adr-review) works regardless.

### Opt-out

To skip the auto `postinstall` step (e.g., team policy disallows
post-install scripts):

```bash
CLAUDE_CONTRAMAESTRE_SKIP_POSTINSTALL=1 npm install --save-dev github:your-user/contramaestre
# then init manually whenever you want:
npx contramaestre init
```

Or set `ignore-scripts=true` in your project's `.npmrc` to disable
all postinstall hooks (you'll need to manually run `npx contramaestre
init` afterwards).

### Upgrades

```bash
npm update contramaestre          # refreshes application code; preserves configs/skills
npx contramaestre init --force    # also refresh configs and skills (review diff first!)
```

---

## Quick tour

```
contramaestre/
├── .claude/
│   ├── settings.json                       # Hook registration (per-event command)
│   ├── hooks/
│   │   ├── router.js                       # Single dispatcher for all hook events
│   │   ├── README.md                       # Hook framework docs
│   │   ├── handlers/                       # One file per Claude Code event
│   │   ├── checks/                         # Stop-time checks (auto-loaded by stop.js)
│   │   ├── lib/                            # Reusable utilities (classes)
│   │   ├── config/                         # Hand-edited JSON configs + reference docs
│   │   └── logs/                           # Per-invocation logs (opt-in, gitignored)
│   └── skills/                             # Skills the hooks invoke as remediation
│       ├── adr-log/SKILL.md
│       └── reconcile-docs/SKILL.md
├── docs/
│   ├── adr/                                # Architectural Decision Records
│   └── project_notes/decisions.md          # ADR ledger (append-only index)
├── package.json                            # devDeps: prettier, eslint, typescript
├── eslint.config.js                        # Flat config (ESLint 9)
├── tsconfig.json                           # checkJs across the hook tree
├── .prettierignore
└── .gitignore
```

For the hook framework specifically (router, handlers, log shape, manual
testing), see [`.claude/hooks/README.md`](.claude/hooks/README.md).

---

## Components

There are six enforcement components, three skills, and a toolchain.

### 1. AccessGuard — PreToolUse path blocklist

**Where:** [`.claude/hooks/lib/AccessGuard.js`](.claude/hooks/lib/AccessGuard.js)
+ [`.claude/hooks/handlers/pre-tool-use.js`](.claude/hooks/handlers/pre-tool-use.js)

**What it does:** every tool call (`Read`, `Edit`, `Write`, `Glob`,
`Grep`, `Bash`, etc.) is screened against
[`.claude/hooks/config/blockedPaths.json`](.claude/hooks/config/blockedPaths.json).
If the tool would access a blocked path, the call is denied with
`Use of this tool is only permitted if … access a blocked path`. Covers
reads *and* writes *and* deletes (e.g., `Bash(rm …)`,
`Bash(Remove-Item …)`).

Blocklist entries support:

- Absolute paths: `"C:/Windows/System32/config/SAM"`, `"/etc/shadow"`
- Project-relative: `".env"`, `"secrets/api-keys.json"`
- Directory rules (trailing `/`): `"secrets/"` blocks the directory and
  everything beneath it
- Globs: `"**/id_rsa"`, `"**/*.pem"`, `"**/.env"`
- Tilde + env-var expansion: `"~/.aws/"`, `"$HOME/.config/gh/"`,
  `"%APPDATA%/Microsoft/Credentials/"`

#### Example

```jsonc
// .claude/hooks/config/blockedPaths.json
[
  ".env",
  ".env.*.local",
  "secrets/",
  "**/.npmrc",
  "**/id_rsa",
  "~/.aws/",
  "~/.ssh/",
  "%USERPROFILE%/.aws/credentials",
  "C:/Windows/System32/config/SAM",
  "/etc/shadow"
]
```

#### Self-protection

To prevent Claude from disabling its own guardrails, add the hook tree
itself to the blocklist when you're done editing:

```jsonc
".claude/hooks/",
".claude/settings.json"
```

While these entries are in the file, Claude's tool calls cannot edit
hook code, the dispatcher, the config, or the hook registration. Remove
temporarily if you need to make changes to the framework yourself.

---

### 2. SkillGate — conditional tool-use gating

**Where:** [`.claude/hooks/lib/SkillGate.js`](.claude/hooks/lib/SkillGate.js)
+ [`.claude/hooks/handlers/user-prompt-submit.js`](.claude/hooks/handlers/user-prompt-submit.js)
+ [`.claude/hooks/handlers/user-prompt-expansion.js`](.claude/hooks/handlers/user-prompt-expansion.js)

**What it does:** privileged tool calls (e.g. `gcloud run deploy …`)
are only permitted when the user has invoked a specific slash-command
skill earlier in the session, AND the captured variables from that
invocation match the tool's arguments.

#### How a gate opens

1. **`UserPromptSubmit`** — user types `/deployToGoogleCloud my-project prd`.
   SkillGate matches the literal prompt against each rule's
   `skillGateRegEx`, captures named groups (`project`, `env`), writes a
   **pending** gate entry to `.claude/.state/gates-<sessionId>.json`.
2. **`UserPromptExpansion`** — the slash-command is expanded by Claude
   Code. The fact that this event fired at all is the proof the skill
   exists and ran. Pending entries younger than 10s are promoted to
   **open**.
3. **`PreToolUse`** — subsequent tool calls are screened. An open gate
   matters only when: session matches, the call is not from a sub-agent
   (no `parent_tool_use_id`), and the gate is within `timeout` minutes
   of promotion.

#### Rule shape

Every rule lives in
[`.claude/hooks/config/conditionalTools.json`](.claude/hooks/config/conditionalTools.json).
The full schema reference is at
[`.claude/hooks/config/conditionalTools.md`](.claude/hooks/config/conditionalTools.md).

Minimal example:

```jsonc
{
  "rules": [
    {
      "name": "deploy-to-google-cloud",
      "skillName": "deployToGoogleCloud",
      "skillGateRegEx": "^/deployToGoogleCloud\\s+(?<project>[a-z][a-z0-9-]{1,30})\\s+(?<env>dev|staging|prd)\\b",
      "trigger": "^Bash.*\\bgcloud\\b",
      "alwaysAllow": [
        "\\bgcloud\\s+--version\\b",
        "\\bgcloud\\s+auth\\s+list\\b"
      ],
      "alwaysDeny": [
        "\\bgcloud\\s+projects\\s+delete\\b"
      ],
      "conditionalAllow": [
        "\\bgcloud\\s+run\\s+deploy\\s+\\S*-{env}\\b.*--project[= ]{project}\\b"
      ],
      "unmatchedAction": "deny",
      "timeout": 60
    }
  ]
}
```

Variables (`{project}`, `{env}`) are **regex-escaped** before
substitution, so a user-supplied skill argument with regex meta-chars
cannot broaden the gate.

#### Shell-aware trigger matching

`trigger` regexes are tested against parsed execution surfaces, not the
flattened JSON payload. So `echo '…gcloud…' | node …` doesn't falsely
trigger a `gcloud` rule — only an actual `gcloud` invocation does. See
[`.claude/hooks/lib/ClaudeCommandTriggerMatcher.js`](.claude/hooks/lib/ClaudeCommandTriggerMatcher.js)
and the test files in
[`.claude/hooks/lib/__tests__/`](.claude/hooks/lib/__tests__/).

The full design and trade-offs are in
[ADR-0002](docs/adr/0002-skill-gated-tool-screening.md).

---

### 3. BgBusyGuard — wait before publishing while bg agents are writing

**Where:** [`.claude/hooks/lib/BgBusyGuard.js`](.claude/hooks/lib/BgBusyGuard.js)
+ [`.claude/hooks/handlers/pre-tool-use.js`](.claude/hooks/handlers/pre-tool-use.js)
(third screen, after AccessGuard and SkillGate).

**What it does:** when a Bash tool call looks like a publish / branch-closeout
operation (see table below), the handler:

1. Reads `.claude/.state/dispatch-log.jsonl` and pairs each `dispatch`
   record with a matching `dispatch-end`. A pid is *in flight* when it
   has a start with no end; pid-liveness + a 30-minute staleness cap
   serve as fallback when the sentinel was SIGKILLed before it could
   write its end record.
2. If nothing is in flight, allows the call immediately (no wait).
3. Otherwise polls every second for up to **30 seconds**, returning early
   the moment the dispatch-log shows the bg agent(s) finished.
4. If the wait expires with bg agents still writing, **denies the tool
   call** with a reason listing each in-flight dispatch and instructing
   the model to retry in ~30 seconds. The hook re-checks on each
   retry — a naïve retry loop terminates as soon as the bg agents
   finish.

Guarded commands (matched by `BgBusyGuard.classify()`):

| Verb | Matches |
|---|---|
| `git commit` | `git commit …`, `git -C dir commit …`, `git -c k=v commit …` |
| `git push` | `git push …` (incl. `-f`, `--force-with-lease`) |
| `git merge` | `git merge feature`, `git merge --no-ff`, `git merge --abort` |
| `git rebase` | `git rebase main`, `git rebase --continue`, `git rebase --abort` |
| `git pull` | `git pull`, `git pull --rebase` |
| `gh pr create` | `gh pr create …` |
| `gh pr merge` | `gh pr merge 123 --squash` (etc.) |

`git checkout`, `git fetch`, `git status`, `git mergetool` are
**not** matched.

#### Escape hatch

```bash
CLAUDE_HOOK_SKIP_BG_GUARD=1
```

Set this in your environment to bypass the wait — useful when you
knowingly want to push without the pending bg writes (e.g., the bg
agent is doing something you intend to redo anyway). The bg agent's
own spawned child sets this automatically to prevent self-deadlock if
a bg session ever issues a guarded command on its own.

#### Why the PreToolUse hook timeout is 60 seconds

[`.claude/settings.json`](.claude/settings.json) sets PreToolUse's
hook timeout to 60s (other events stay at 30s). The 30-second wait
plus AccessGuard + SkillGate overhead fits comfortably; bumping the
timeout leaves headroom for future PreToolUse work without risking
Claude killing the hook mid-wait.

---

### 4. Stop checks — auto-discovered, aggregating dispatcher

**Where:** [`.claude/hooks/handlers/stop.js`](.claude/hooks/handlers/stop.js)
auto-loads every `*.js` file in [`.claude/hooks/checks/`](.claude/hooks/checks/).

**What it does:** when Claude finishes a turn, the dispatcher runs every
check, collects their `{block: true, reason}` results, and emits a
single combined Stop-decision payload. If more than one check fires,
each reason is wrapped in a numbered banner (`ITEM 1 of N`) with an
explicit preamble asking Claude to address every item (and reminding
it that multiple skills can be invoked in one turn).

Three checks ship:

| Check | What it checks | Skill it invokes |
|---|---|---|
| `docs-review.js` | Watched source files changed without their docs/ counterparts | [`reconcile-docs`](.claude/skills/reconcile-docs/SKILL.md) |
| `adr-review.js`  | Session changes look architecturally substantial, no ADR added | [`adr-log`](.claude/skills/adr-log/SKILL.md) |
| `format.js`      | Run `prettier --write` + `eslint --fix` on session-changed files | n/a (direct shell, no skill) |

To add a new Stop check: drop a `.js` file in
[`.claude/hooks/checks/`](.claude/hooks/checks/). It should export
`(payload, ctx) => { block, reason } | null`. The dispatcher picks it up
automatically; no registration needed.

#### docs-review configuration

[`.claude/hooks/config/mustConsiderUpdatingDocs.json`](.claude/hooks/config/mustConsiderUpdatingDocs.json):

```jsonc
{
  "stopBehavior": "background",   // "background" (default) | "interactive"
  "patterns": [
    "src/"
  ]
}
```

| Field | Purpose |
|---|---|
| `stopBehavior` | `"background"` (default): dispatch a headless agent to do the reconciliation, main session ends cleanly. `"interactive"`: block the Stop with a nag; Claude must address it before stopping. |
| `patterns` | Source paths/dirs/globs to watch. Convention: `src/foo/bar.ts` → `docs/foo/bar.md`. The default watches the whole `src/` tree. |

**Opt-in mirror policy.** The check only fires when the doc counterpart
**already exists on disk**. A new source file with no doc stays silent
until you seed the doc manually via the [`generate-docs`](.claude/skills/generate-docs/SKILL.md)
skill — at which point the file is opted into the mirror and
`reconcile-docs` keeps it in sync afterwards.

When the patterns match, a doc counterpart exists, and the doc wasn't
touched this session, the check either:

- (background) spawns a detached `claude -p` with the reconcile-docs
  skill, a list of `(source, doc)` pairs, and the current `git diff`.
- (interactive) returns a block telling Claude to invoke the
  reconcile-docs skill in-session.

#### adr-review configuration

[`.claude/hooks/config/adrTriggers.json`](.claude/hooks/config/adrTriggers.json):

```jsonc
{
  "stopBehavior": "background",
  "adrLocations": {
    "logFile": "docs/project_notes/decisions.md",       // append-only index
    "perFileGlob": "docs/adr/[0-9]*.md"                 // per-file ADRs
  },
  "substantiality": {
    "minFilesChanged": 5,
    "minLinesChanged": 200,
    "triggerPaths": [
      "package.json",
      "**/Cargo.toml",
      "**/migrations/*",
      "openapi.{yaml,yml,json}",
      "**/*.proto",
      "src/**"
    ],
    "excludeFromLineCount": [
      "package-lock.json", "yarn.lock", "**/*.min.js", "**/__generated__/**"
    ],
    "mode": "either"                                    // "either" | "both"
  }
}
```

| Field | Purpose |
|---|---|
| `stopBehavior` | Same semantics as docs-review. |
| `adrLocations.logFile` | The single-file ADR ledger that gets one line per ADR. |
| `adrLocations.perFileGlob` | The per-file directory pattern. Both fields together — the adr-log workflow writes both files for each ADR. |
| `substantiality.minFilesChanged` / `minLinesChanged` | Floor for "the session was substantial enough to warrant an ADR". |
| `substantiality.triggerPaths` | Paths that *always* trigger consideration regardless of volume (e.g. dependency manifests, schemas, public contracts). |
| `substantiality.excludeFromLineCount` | Don't count lines in these paths toward `minLinesChanged` (lockfiles, generated code, etc.). |
| `substantiality.mode` | `"either"` (default): trigger paths OR volume floor fires. `"both"`: both must fire. |

The check is suppressed (no nag, no dispatch) if **both** an entry in
`logFile` *and* a file matching `perFileGlob` were touched this
session — i.e. the ADR workflow's two writes both happened.

#### format check

Always runs at Stop. No config knob. Behavior:

- If `node_modules/prettier` doesn't exist → no-op. Run `npm install`
  to activate.
- Runs `npx --no-install prettier --write` and `eslint --fix` on
  session-changed files.
- Silent on success. Blocks Stop only when `eslint --fix` leaves real
  errors that can't be auto-resolved — the errors are surfaced to
  Claude so it can fix them before stopping.

---

### 5. BackgroundDispatcher — detached headless agents (sentinel-wrapped)

**Where:** [`.claude/hooks/lib/BackgroundDispatcher.js`](.claude/hooks/lib/BackgroundDispatcher.js)
+ [`.claude/hooks/lib/dispatch-sentinel.js`](.claude/hooks/lib/dispatch-sentinel.js)

**What it does:** spawns `claude -p` as a detached process from a hook,
so the main Claude session can end cleanly while reconciliation work
continues in the background. Used by docs-review and adr-review when
`stopBehavior: "background"`.

Key behaviours:

- Uses `claude -p` (headless), **not** `claude --bg`. Headless writes
  to the **main worktree** so changes show up in your `git status`
  immediately. `claude --bg` would isolate writes to
  `.claude/worktrees/<id>/` and require a separate merge step.
- Spawns with `--permission-mode acceptEdits` plus a per-spawn
  `--settings` allowlist (written to a tempfile under
  `.claude/.state/` so long paths survive Windows `cmd.exe` argv
  rules) limiting Bash, Read, Write, etc. to exactly what the
  relevant skill needs. No widening of permissions for interactive
  sessions.
- **Does not commit.** The agent writes uncommitted modifications;
  you review and commit yourself.
- Falls back to interactive Stop block when `claude` isn't on PATH,
  so gaps are never silently lost.
- Every dispatch is logged at `.claude/.state/dispatch-log.jsonl` —
  **two records per dispatch**:
  - `event: "dispatch"` written when the spawn returns (timestamp,
    session ID, name, sentinel pid, granted tool allowlist, prompt
    head, settings tempfile path).
  - `event: "dispatch-end"` written by the sentinel when the bg
    `claude -p` exits (timestamp, sentinel pid, exit reason, exit
    code or signal).

  BgBusyGuard pairs these by pid to know exactly when a dispatch is
  finished, without having to do error-prone pid-liveness checks
  alone. Useful for both cost audit and unblocking the user's next
  commit.

#### Sentinel wrapper

Each dispatch is launched as `node dispatch-sentinel.js <log> <name>
-- claude.cmd <args>` rather than `claude.cmd` directly. The sentinel:

- Forwards the prompt from its stdin to the `claude -p` child's stdin
  (the prompt is **not** an argv positional — Windows `cmd.exe` and
  Node 20.12+'s CVE-2024-27980 hardening both mangle long argv).
- Waits for the child to exit and writes the `dispatch-end` record
  on every exit path (normal exit, `SIGINT`, `SIGTERM`, uncaught
  exception, top-level `process.on('exit')` catch-all). The only
  case where no end record is written is `SIGKILL` — and BgBusyGuard
  falls back to pid-liveness + a 30-minute staleness cap there.
- On Windows launches `claude.cmd` via `cmd.exe /d /s /c
  "<quoted-cmdline>"` with `windowsVerbatimArguments:true` to handle
  paths containing spaces (e.g. `C:\Users\Some User\…`).

The sentinel also writes a matching `BgDispatch:<name>  end (…)` line
to the **originating session's** master log via
[`lib/master-log.js`](.claude/hooks/lib/master-log.js) (see
§Invocation logging below).

#### Self-deadlock prevention

`BackgroundDispatcher` sets `CLAUDE_HOOK_SKIP_BG_GUARD=1` in the
spawned child's env, so if the bg session ever issues a guarded
command (commit / push / merge / rebase / pull / `gh pr …`) it does
not wait on its own pid being in-flight. Subagents spawned by the
main session do **not** inherit this and still honor the guard.

#### Per-spawn tool allowlists

In each check, an array constant declares the tools the skill needs:

```js
// docs-review.js
const RECONCILE_DOCS_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(git diff *)',
  'Bash(git status *)',
  'Bash(git ls-files *)',
  'Bash(date +%F)',
];
```

This list mirrors the skill's `allowed-tools` frontmatter (which is a
*safety cap*, not a permission grant). Anything not on this list
requires permission at runtime — and since the agent is headless,
unexpected tool calls just fail. That's the intended safety surface.

---

### 6. Invocation logging

**Where:** [`.claude/hooks/router.js`](.claude/hooks/router.js)

**On by default.** Disable with `CLAUDE_HOOK_LOG=0` (also accepts
`false`, `off`, `no`, case-insensitive):

```powershell
# PowerShell (persistent)
setx CLAUDE_HOOK_LOG 0

# PowerShell (current session)
$env:CLAUDE_HOOK_LOG = "0"
```

```bash
# Linux/macOS
export CLAUDE_HOOK_LOG=0
```

When enabled, every hook firing writes **two** files:

- **Per-invocation structured log** — `.claude/hooks/logs/<sessionId>_<isoTimestamp>.log`,
  pretty-printed JSON with event name, payload, env, and Node info.
- **Per-session master log** — `.claude/hooks/logs/master-<sessionId>.log`,
  append-only, one line per module invocation:

  ```
  <isoTimestamp>  <component(padded)>  <outcome>
  ```

  Outcomes are decoded from handler stdout (`block: …`, `deny: …`,
  `allow`, `systemMessage: …`) or fall back to the literal stdout
  truncated to 240 chars. The Stop dispatcher logs an entry per check
  (`Stop:docs-review`, `Stop:adr-review`, `Stop:format`) plus a
  `Stop:dispatcher` summary, plus the router's own per-event entry.

#### Background dispatches show up in the originating session's log

The master log gives you a unified timeline for bg activity you fired:

- **Start** — `docs-review` / `adr-review` emit a
  `BgDispatch:<name>  start pid=<n> …` line right after a successful
  dispatch.
- **Body** — every hook event inside the spawned bg session is
  mirrored into the originating session's master log with a
  `bg[<short-bg-sid>] <component>` prefix (the bg session's own
  master log is preserved unchanged for standalone debugging).
- **End** — the sentinel writes `BgDispatch:<name>  end (<reason>,
  exit=<n>)` on the bg `claude -p` exit.

The mirroring is driven by the `CLAUDE_HOOK_SENTINEL_SESSION` env
var, which `BackgroundDispatcher` sets on the spawned child to the
originating main-thread session id; the router (running inside the
bg session) reads it and appends to both master logs.

A typical bg docs reconciliation looks like:

```
…
Stop:docs-review                      no-op
BgDispatch:docs-recon-abc-123def      start pid=12345 gaps=2
Stop                                  no-op
bg[a3f2cd] SessionStart               no-op
bg[a3f2cd] PreToolUse                 allow
bg[a3f2cd] PostToolUse                no-op
…
bg[a3f2cd] Stop                       no-op
BgDispatch:docs-recon-abc-123def      end (child-exit, exit=0)
```

The shared helper at
[`.claude/hooks/lib/master-log.js`](.claude/hooks/lib/master-log.js)
keeps filename sanitization, line format, and the
`CLAUDE_HOOK_LOG=0` off-switch consistent across the router and the
sentinel.

The `logs/` directory is gitignored.

---

## Skills

Three skills ship. Two are auto-invoked by Stop-check nags / background
dispatches; one is user-invoked when you want to seed a new doc.

### `adr-log`

[`.claude/skills/adr-log/SKILL.md`](.claude/skills/adr-log/SKILL.md)

Records an Architectural Decision Record. Each ADR produces two writes:

1. A full ADR file at `docs/adr/<NNNN>-<kebab-title>.md` in the
   4-field format (Context / Decision / Alternatives / Consequences),
   with `Scope` and `Guardrails` sections.
2. A one-line entry appended to
   `docs/project_notes/decisions.md` — the index/ledger.

Hard limits enforced by the skill: title ≤ 60 chars, ≤ 5 bullets per
section, no code blocks > 3 lines. The skill explicitly says **do not
infer human intent from a diff** — when invoked interactively, it asks
the user; when invoked from a background dispatch, the prompt instructs
it to mark fields `**Needs review:** …` and set `Status: Proposed`
rather than invent intent.

Two seed ADRs already exist:

- [ADR-001](docs/adr/0001-hooks-for-tracking-and-safe-editing.md) — Why
  we use hooks instead of advisory rules.
- [ADR-0002](docs/adr/0002-skill-gated-tool-screening.md) — Why SkillGate
  exists and how the two-phase open works.

### `reconcile-docs`

[`.claude/skills/reconcile-docs/SKILL.md`](.claude/skills/reconcile-docs/SKILL.md)

Reconciles a `docs/` mirror against `src/` for files listed in
`mustConsiderUpdatingDocs.json`. Auto-invoked by `docs-review`. Given a
list of `(source, doc)` pairs from the Stop hook, the skill:

- Reads each source diff and the existing doc.
- Classifies the change (material / trivial / deprecation).
- For trivial changes, bumps only `Last updated:`.
- For material changes, updates prose focused on **why** the code
  exists, constraints, gotchas — *not* signatures or what `git log`
  already shows.

### `generate-docs`

[`.claude/skills/generate-docs/SKILL.md`](.claude/skills/generate-docs/SKILL.md)

**User-invoked only** — there is no auto-trigger. Use when adding a new
module that warrants durable prose. You name the source file; the skill
creates the canonical mirror doc at `docs/X.md`. Refuses to overwrite
an existing doc (directs you to `reconcile-docs` for updates). Same
documentation standard and quality rules as `reconcile-docs`. Asks at
most three focused questions for the "why" that source code can't
reveal.

This skill is the on-ramp for the **opt-in mirror policy** — until you
run `generate-docs` for a source file, `docs-review` stays silent about
it (no nags, no auto-dispatch). Once the doc exists, `reconcile-docs`
keeps it in sync.

---

## Toolchain

Standard JS toolchain. **For working on contramaestre itself**, after
cloning:

```bash
npm install
```

This installs prettier, eslint v9 (flat config), typescript, and
`typescript-eslint`. (When consuming contramaestre via `npm install
github:.../contramaestre`, these tools do **not** propagate — npm doesn't
install a dependency's devDeps. Consumers must install them as their
own direct devDeps; see [Using contramaestre in another
project](#using-contramaestre-in-another-project) above.)

Scripts:

| Script | What |
|---|---|
| `npm run format` | `prettier --write .` |
| `npm run format:check` | `prettier --check .` |
| `npm run lint` | `eslint .` |
| `npm run lint:fix` | `eslint . --fix` |
| `npm run typecheck` | `tsc --noEmit` (with `allowJs`/`checkJs`, type-checks the hook tree) |

Config files:

- [`package.json`](package.json) (inline `"prettier": {...}` field)
- [`eslint.config.js`](eslint.config.js)
- [`tsconfig.json`](tsconfig.json)
- [`.prettierignore`](.prettierignore)

The Stop-time format check ([`.claude/hooks/checks/format.js`](.claude/hooks/checks/format.js))
uses these via `npx --no-install`. Until you `npm install`, the check
is silently a no-op.

---

## Configuration reference

Every hand-edited config lives under `.claude/hooks/config/`.

| File | Reference | Purpose |
|---|---|---|
| [`blockedPaths.json`](.claude/hooks/config/blockedPaths.json) | This README §AccessGuard | Paths AccessGuard denies on PreToolUse |
| [`conditionalTools.json`](.claude/hooks/config/conditionalTools.json) | [conditionalTools.md](.claude/hooks/config/conditionalTools.md) | SkillGate rules: skillGateRegEx → trigger → allow/deny |
| [`mustConsiderUpdatingDocs.json`](.claude/hooks/config/mustConsiderUpdatingDocs.json) | This README §Stop checks | docs-review watch list + stopBehavior |
| [`adrTriggers.json`](.claude/hooks/config/adrTriggers.json) | This README §Stop checks | adr-review substantiality + ADR locations + stopBehavior |

Per-session state files (gitignored, no manual editing needed):

| File | Owner | Purpose |
|---|---|---|
| `.claude/.state/gates-<sid>.json` | SkillGate | Open/pending gates with captured variables |
| `.claude/.state/docs-nagged-<sid>.json` | docs-review | Set of source paths already nagged about this session |
| `.claude/.state/adr-nagged-<sid>.json` | adr-review | `{at, mode, triggerFiles: [...]}` — accumulates trigger paths nagged so far; re-nags only when new triggers appear |
| `.claude/.state/format-ran-<sid>.json` | format | `{<filePath>: <sha256-of-formatted-content>}` map — per-file dedup, re-runs only on changed/new files |
| `.claude/.state/dispatch-log.jsonl` | BackgroundDispatcher + sentinel | Append-only audit log: `event:"dispatch"` per spawn, `event:"dispatch-end"` per sentinel exit. Paired by pid by BgBusyGuard. |
| `.claude/.state/dispatched-settings-*.json` | BackgroundDispatcher | Per-spawn `--settings` tempfile for the bg agent's tool allowlist. Cleaned up best-effort; orphans older than 24h are pruned on the next dispatch. |
| `.claude/hooks/logs/master-<sid>.log` | router | One-line-per-module-invocation summary (on by default; disable via `CLAUDE_HOOK_LOG=0`) |
| `.claude/hooks/logs/<sid>_<ts>.log` | router | Per-invocation structured JSON dump (same on/off knob) |

---

## What happens at each hook event

| Event | Handler | Behaviour |
|---|---|---|
| `SessionStart` | [session-start.js](.claude/hooks/handlers/session-start.js) | (stub — no-op) |
| `UserPromptSubmit` | [user-prompt-submit.js](.claude/hooks/handlers/user-prompt-submit.js) | SkillGate: capture pending gate variables from any rule whose `skillGateRegEx` matches the prompt. |
| `UserPromptExpansion` | [user-prompt-expansion.js](.claude/hooks/handlers/user-prompt-expansion.js) | SkillGate: promote pending gates to open. |
| `PreToolUse` | [pre-tool-use.js](.claude/hooks/handlers/pre-tool-use.js) | AccessGuard → SkillGate → BgBusyGuard (commit/push/merge/rebase/pull/PR wait up to 30s for bg dispatches to finish). First deny wins. |
| `PostToolUse` | [post-tool-use.js](.claude/hooks/handlers/post-tool-use.js) | (stub — no-op) |
| `Stop` | [stop.js](.claude/hooks/handlers/stop.js) | Auto-load every `checks/*.js`, run each, aggregate `{block, reason}` results, emit one combined Stop decision. |
| `SubagentStop` | [subagent-stop.js](.claude/hooks/handlers/subagent-stop.js) | (stub — no-op) |
| `Notification` | [notification.js](.claude/hooks/handlers/notification.js) | (stub — no-op) |
| `PreCompact` | [pre-compact.js](.claude/hooks/handlers/pre-compact.js) | (stub — no-op) |

---

## Known limitations

- **The background-dispatch model uses a real Claude session per
  invocation** and consumes your subscription quota. The per-session
  dedup state files prevent re-dispatching the same gap, but a chatty
  project with many Stop events can add up. Each dispatch is recorded
  in `.claude/.state/dispatch-log.jsonl` for audit.
- **Background agents share the main worktree.** If you edit `docs/api/foo.md`
  in your editor while a background agent is reconciling it, last
  writer wins. Rare in practice for docs/ADR, but real.
- **Background agents don't auto-commit.** Their changes appear as
  uncommitted modifications in `git status`; you review and commit
  yourself. This is intentional — see the trade-offs in
  [ADR-0002](docs/adr/0002-skill-gated-tool-screening.md).
- **`stopBehavior: "background"` falls back to interactive** if `claude`
  isn't on PATH (e.g., spawning hook can't find the CLI). Gaps are
  never silently lost.
- **Format and adr-review re-fire across turns within a session.** Both
  use content-aware dedup (format keys on per-file post-format hash;
  adr-review keys on the union of trigger paths already nagged about).
  Loop safety within a single Stop chain is provided by the
  dispatcher's `stop_hook_active` guard.
- **The hook framework needs Node.js on PATH** — Node 20+ for the
  toolchain (`package.json` engines field), but the hook router itself
  uses only built-in modules and runs on any LTS.

---

## ADRs

Architectural decisions for this scaffolding are in
[`docs/adr/`](docs/adr/) with a one-line index at
[`docs/project_notes/decisions.md`](docs/project_notes/decisions.md).
Quick links:

- [ADR-001 — Hook-based guardrails for change tracking and safe editing](docs/adr/0001-hooks-for-tracking-and-safe-editing.md)
- [ADR-0002 — Gate privileged tool calls behind skill invocations](docs/adr/0002-skill-gated-tool-screening.md)

---

## Disabling components

Each enforcement layer is opt-out without touching code:

| Layer | How to disable |
|---|---|
| AccessGuard | Empty the array in [`blockedPaths.json`](.claude/hooks/config/blockedPaths.json) |
| SkillGate | Empty the `rules` array in [`conditionalTools.json`](.claude/hooks/config/conditionalTools.json) |
| BgBusyGuard | Per-invocation: `CLAUDE_HOOK_SKIP_BG_GUARD=1` in env. There is no permanent off-switch in config — when bg dispatches are in flight, waiting is the safe default. |
| docs-review | Empty `patterns` in [`mustConsiderUpdatingDocs.json`](.claude/hooks/config/mustConsiderUpdatingDocs.json) |
| adr-review | Set `substantiality.minFilesChanged` and `minLinesChanged` to very high values, and empty `triggerPaths`, OR delete [`adrTriggers.json`](.claude/hooks/config/adrTriggers.json) |
| format | Remove `prettier` / `eslint` from `node_modules` (skip `npm install`) |
| Invocation logs | Set `CLAUDE_HOOK_LOG=0` (or `false`/`off`/`no`); they're **on by default** |
| All hooks | Remove the relevant event from `.claude/settings.json`, or delete `.claude/settings.json` entirely |
