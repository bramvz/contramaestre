# conditionalTools.json — schema reference

Configuration for [`SkillGate`](../lib/SkillGate.js): gates that screen PreToolUse
calls based on whether the user invoked a specific skill earlier in the session.

## Top-level shape

```jsonc
{
  "$schemaVersion": 1,
  "$comment": "Free-form human note describing the file's purpose.",
  "rules": [ /* zero or more rules; see below */ ]
}
```

| Field | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `$schemaVersion` | integer | no | — | Tag for future migrations. Current schema is `1`. |
| `$comment` | string | no | — | Human-only commentary. Ignored by the loader. |
| `rules` | array | yes | `[]` | Ordered list of rules. Order matters — see [Trigger order](#trigger-order). |

## Rule shape

```jsonc
{
  "name": "deploy-to-google-cloud",
  "skillName": "deployToGoogleCloud",
  "description": "…",
  "skillGateRegEx": "^/deployToGoogleCloud\\s+(?<project>[a-z][a-z0-9-]{1,30})\\s+(?<env>dev|staging|prd)\\b",
  "trigger": "^Bash.*\\bgcloud\\b",
  "alwaysAllow": [ /* regex */ ],
  "alwaysDeny":  [ /* regex */ ],
  "conditionalAllow": [ /* regex templates with {name} placeholders */ ],
  "unmatchedAction": "deny",
  "timeout": 60
}
```

| Field | Type | Required | Default | Purpose |
|---|---|---|---|---|
| `name` | string | yes | — | Unique key. Used as the state-file map key for this rule's gate, so it must be stable across config edits. Don't reuse `name` between rules. |
| `skillName` | string | yes | — | Human-readable skill identifier surfaced in the deny message. Decoupled from `skillGateRegEx` so the message stays clean even if the regex is complex. |
| `description` | string | no | — | Documentation for humans reading the JSON. Ignored at runtime. |
| `skillGateRegEx` | regex string | yes | — | Tested against the **literal** user prompt at `UserPromptSubmit`. Match opens a `pending` gate; captured **named groups** (`(?<name>…)`) become the gate's variables. Use named groups for every variable you want to reference in `conditionalAllow`. |
| `trigger` | regex string | yes | — | Tested against the [flattened tool command](#flattened-tool-command). If it matches, this rule (and no other) screens the tool call. See [Trigger order](#trigger-order). |
| `alwaysAllow` | array of regex strings | no | `[]` | Patterns tested against the flattened command. Any match short-circuits to **allow**, regardless of gate state. Use for clearly safe read-only commands. |
| `alwaysDeny` | array of regex strings | no | `[]` | Patterns tested against the flattened command. Any match short-circuits to **deny** with `"Use of this tool is not permitted."`, regardless of gate state. Use for catastrophic operations. |
| `conditionalAllow` | array of regex template strings | no | `[]` | Templates may contain `{name}` placeholders referencing groups from `skillGateRegEx`. When the gate is **open**, captured values are regex-escaped and substituted in, then the resolved patterns are tested. Match → allow. |
| `unmatchedAction` | `"deny"` \| `"allow"` | no | `"deny"` | What to do when `trigger` matched but none of allow/deny/conditional did. Deny is the safe default. |
| `timeout` | number | no | `30` | Minutes after promotion-to-`open` before the gate is treated as closed. |

## How regex matching works

For shell tools (`Bash`, `Monitor`, `PowerShell`, `mcp__*`), SkillGate
delegates to [`ClaudeCommandTriggerMatcher`](../lib/ClaudeCommandTriggerMatcher.js),
which parses the `command` per shell and extracts **execution surfaces** —
every place an executable is actually invoked (direct call, subshell,
brace group, function call, pipe, wrapper like `docker run`/`ssh`/
`xargs`, heredoc-written script that is later `bash`'d, `pwsh
-EncodedCommand` payload, `& {…}` scriptblock, etc.). Each rule regex is
tested against per-surface candidates, including backward-compatible
shapes like `<toolName> <command>` and `<toolName>{"command":"<command>"}`.

This means:

- `Bash({command: "gcloud --version"})` is matched against surface
  `Bash gcloud --version` (and equivalents). Rules referencing `gcloud`
  match.
- `Bash({command: "echo '{...gcloud...}' | node ..."})` is matched
  against `Bash echo` and `Bash node` — **not** against the literal
  `gcloud` substring inside the echoed JSON string. So rules referencing
  `gcloud` do *not* fire (this is the fix for the substring false-positive
  class — see [`KNOWN_BUGS.md`](../KNOWN_BUGS.md) §1).
- `Bash({command: "cat <<EOF\ngcloud ...\nEOF"})` — the heredoc body is
  treated as data, not invocation. But if the same body is written to
  `/tmp/x.sh` and the next command is `bash /tmp/x.sh`, the matcher
  re-extracts and `gcloud` is recognised as an invocation.

For non-shell tools the matching surface is the tool name itself; rules
targeting them remain simple substring/prefix matches.

## Gate lifecycle

```
closed  ──UserPromptSubmit matches──▶  pending
                                          │
                                          │  UserPromptExpansion fires
                                          │  within 10s
                                          ▼
                                        open
                                          │
                                          │  timeout minutes elapse
                                          ▼
                                       expired  (treated as closed)
```

- `closed` is the implicit starting state.
- `pending` means the regex matched, vars are captured, but no expansion has confirmed the skill actually exists/ran yet. Pending gates are **not** open for screening purposes.
- `open` requires confirmation from `UserPromptExpansion`. The 10-second window prevents stale `pending` entries from being silently promoted by an unrelated later expansion.
- `expired` is computed lazily from `promotedAt + timeout`. No active cleanup; the entry stays on disk so the deny message can still render the right skill name and variables.

## Variable substitution

Inside `conditionalAllow` templates, `{name}` is replaced by the captured value
of the same-named group from `skillGateRegEx`. Values are **regex-escaped before
substitution** so a user-supplied skill argument containing regex meta-characters
(`.*`, `\\d+`, …) cannot broaden the gate beyond the rule author's intent.

Example:

```jsonc
// skillGateRegEx captures: project="my-proj.x", env="prd"
// Template:
"\\bgcloud\\s+config\\s+set\\s+project\\s+{project}\\b"
// Resolved (project value escaped, env unused):
"\\bgcloud\\s+config\\s+set\\s+project\\s+my\\-proj\\.x\\b"
```

If a referenced `{name}` isn't in the captured vars, the placeholder is left
literal — the resulting regex will not match anything useful, which is the
safe failure mode.

## Trigger order

Rules are evaluated in array order. The first rule whose `trigger` matches the
flattened command is the only one that runs — subsequent rules are ignored,
even if they would have also matched.

**Implication:** if rule A has a broader trigger than rule B and A comes first,
B never runs. Put more specific triggers earlier when in doubt.

## Sub-agent calls

A tool call is treated as coming from a sub-agent if the PreToolUse payload
has a non-empty `parent_tool_use_id` field. Sub-agent calls never see a gate
as open, even if the main thread opened one — so a sub-agent will hit the
`gate-closed` branch (skill-gate message) on any tool that would otherwise
have matched `conditionalAllow`.

## Session scoping

Gate state is keyed per-session at:

```
.claude/.state/gates-<sanitized-sessionId>.json
```

Gates opened in session A are not visible to session B, even if both run
against the same project directory.

## Failure modes

- **Missing config file** — SkillGate silently treats `rules` as empty; every tool call falls through to `allow`. Same as opt-out.
- **Malformed config (bad JSON, bad regex)** — Whole rule is skipped, an error logged to stderr; other rules continue.
- **State file corruption** — Read returns empty state; gates appear closed until the next successful write.
- **Regex DOS in user-supplied skill args** — Captured values are escaped before being injected; you should not be able to construct a catastrophic backtracking regex through skill arguments. The static `conditionalAllow` patterns themselves are written by you; pick them carefully.
