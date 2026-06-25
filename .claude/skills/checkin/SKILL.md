---
name: checkin
description: >
  Record what the user is working on for the current Claude Code session.
  Use when the user runs /checkin, or says "check in", "log what I'm working
  on", "I'm starting work on …", or "continue". Captures whether the work is a
  Jira ticket (referenced by number, found by description, or newly created) or
  non-Jira work (feature / bug / customer / other), and writes it to
  .contramaestre/.state/<sessionId>.json for the rest of the session. After
  recording, it investigates an existing ticket, summarizes it, and offers to
  draft an implementation plan.
when_to_use: >
  User-invoked. Run whenever the user wants to declare or update the focus of
  the current session. For Jira check-ins the Atlassian (Jira) MCP must be
  connected — if it is not, stop and give the connection steps.
argument-hint: '[jira <TICKET|description> | non-jira <description> | continue]'
user-invocable: true
---

# checkin

Capture the focus of the current session and persist it to a per-session state
file. Be conversational but precise: gather only what's missing, confirm
anything ambiguous, and never invent a ticket number or work type.

Use `$ARGUMENTS` as initial input when present (e.g. `jira ISMS-481`,
`non-jira fixing the login redirect bug`, `continue`).

## What this produces

A single JSON file at:

```text
.contramaestre/.state/<sessionId>.json
```

`<sessionId>` is the **current Claude Code session id** — read it from the
`CLAUDE_CODE_SESSION_ID` environment variable (do not guess it):

```bash
echo "$CLAUDE_CODE_SESSION_ID"
```

(PowerShell equivalent: `$env:CLAUDE_CODE_SESSION_ID`.) If the variable is
empty, ask the user for their session id rather than inventing one.

### Schema (write exactly these keys)

| key | type | meaning |
|---|---|---|
| `jira` | boolean | `true` if working on a Jira ticket, `false` if not |
| `newTicket` | boolean \| null | `true` if this skill newly created the ticket; `false` if it referenced/found an existing one; `null` when `jira` is `false` |
| `ticketNumber` | string \| null | the Jira ticket key (e.g. `"ISMS-481"`), or `null` for non-Jira |
| `desc` | string \| null | non-Jira: the user's description of the work. Jira: the ticket's title/summary when available (else `null`). |
| `type` | null \| `"feature"` \| `"bug"` \| `"customer"` \| `"other"` | work type (non-Jira only), else `null` |
| `timestamp` | string | current UTC time in ISO 8601 (e.g. `"2026-06-25T14:41:00Z"`) when this check-in was written |

If a state file for this `<sessionId>` already exists, you **MUST overwrite it
completely** — the new content fully replaces the old, and **none of the
original content may remain** (never merge, patch, or append; the only
exception is `continue`, which refreshes the existing file's `timestamp`).
Ensure the `.contramaestre/.state/` directory exists first.

---

## Step 1 — Determine the State

The three states are **`checkin jira`**, **`checkin non-jira`**, and
**`continue`**. If `$ARGUMENTS` already makes the state clear, use it.
Otherwise ask with `AskUserQuestion` (single-select):

- **checkin jira** — working on a Jira ticket
- **checkin non-jira** — working on something not tracked in Jira
- **continue** — keep working on whatever was already checked in

---

## Step 2 — Gather context for the chosen state

### State: `continue`

No new context is gathered. Refresh the **`timestamp`** on the existing record,
keeping every other field unchanged.

- Read `.contramaestre/.state/<sessionId>.json`.
  - If it exists: set `timestamp` to the current UTC time (obtain it as in
    Step 3), leave `jira`, `newTicket`, `ticketNumber`, `desc`, and `type`
    exactly as they are, and write the file back. Confirm what they're
    continuing.
  - If it does **not** exist: tell the user there's nothing to continue and ask
    them to run `/checkin jira` or `/checkin non-jira`. Do not create a file.

### State: `checkin jira`

**First, verify the Jira MCP is available.** Call the Atlassian MCP
`getAccessibleAtlassianResources` tool (this also yields the `cloudId` you'll
need). If the Atlassian/Jira MCP tools are **not available**, or the call fails
because the connector is not connected, **do not proceed** — show the
[Jira MCP not available](#jira-mcp-not-available) instructions and stop.

If available, pick one of three context options (from `$ARGUMENTS` or via
`AskUserQuestion`):

1. **Reference an existing ticket by number.**
   - Take the ticket key from the user (e.g. `ISMS-481`).
   - Confirm it exists by fetching it with `getJiraIssue`; show its summary so
     the user knows it's the right one.
   - Set `ticketNumber` = the key, `newTicket` = `false`.

2. **Describe the ticket → search for it.**
   - Search with `searchJiraIssuesUsingJql` using a text query over the
     description, e.g.
     `summary ~ "<terms>" OR description ~ "<terms>" ORDER BY updated DESC`
     (scope to `assignee = currentUser()` if helpful).
   - Present the top matches (key + summary) and **confirm the correct one with
     the user** via `AskUserQuestion`. Do not assume the first hit.
   - Use the **confirmed** ticket as the one being worked on.
   - Set `ticketNumber` = the confirmed key, `newTicket` = `false`.

3. **Create a new ticket.**
   - Gather the needed fields: project (offer `getVisibleJiraProjects` if the
     user is unsure), issue type, summary, and optional description. Use
     `getJiraProjectIssueTypesMetadata` if you need valid issue types.
   - Create it with `createJiraIssue`.
   - Set `ticketNumber` = the newly created key, `newTicket` = `true`.

For all Jira check-ins: `jira` = `true`, `type` = `null`, and `desc` = the
ticket's **title/summary** — capture it from the issue you referenced, found, or
created (use `null` only if no title is available).

### State: `checkin non-jira`

- The user **must describe** what they're working on. If `$ARGUMENTS` lacks a
  description, ask for one.
- Classify the description into exactly one `type`:
  - `"feature"` — a platform feature
  - `"bug"` — a bug
  - `"customer"` — a customer job
  - `"other"` — anything else
- If the type is **not clear** from the description, clarify with the user via
  `AskUserQuestion` (the four options above). Do not guess silently.
- Set `jira` = `false`, `newTicket` = `null`, `ticketNumber` = `null`,
  `desc` = the user's description, `type` = the chosen enum value.

---

## Step 3 — Write the state file

1. Resolve `<sessionId>` from `CLAUDE_CODE_SESSION_ID`.
2. Get the current UTC timestamp — run `date -u +%Y-%m-%dT%H:%M:%SZ`
   (PowerShell: `[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')`). **Never
   hand-write the time** — always read it from the system.
3. Ensure `.contramaestre/.state/` exists.
4. Write `.contramaestre/.state/<sessionId>.json` with the full schema,
   including `timestamp`. If the file already exists you **MUST overwrite it
   completely** — the new content fully replaces the old; none of the original
   content may remain.

**Example — Jira, existing ticket:**

```json
{
  "jira": true,
  "newTicket": false,
  "ticketNumber": "ISMS-481",
  "desc": "Test (a scenario of) the Business Continuity Plan",
  "type": null,
  "timestamp": "2026-06-25T14:41:00Z"
}
```

**Example — non-Jira bug:**

```json
{
  "jira": false,
  "newTicket": null,
  "ticketNumber": null,
  "desc": "Fixing the login redirect loop on Safari",
  "type": "bug",
  "timestamp": "2026-06-25T14:41:00Z"
}
```

## Step 4 — Confirm

Tell the user concisely what was recorded (state + ticket number or
description/type) and the file path written. For `continue`, restate what
they're continuing.

## Step 5 — Investigate and offer to plan

After writing the state file, move the user toward a plan. (Skip this step for
`continue` — just restate the existing focus.)

### Existing Jira ticket (`newTicket: false` — referenced by number or matched by search)

1. **Investigate.** Fetch the full ticket with `getJiraIssue`, requesting at
   least `summary`, `description`, `status`, `priority`, `labels`, `subtasks`,
   `issuelinks`, and `comment` (use `responseContentFormat: "markdown"`).
2. **Summarize for the user** in a few lines: the objective, current
   status/priority, key requirements or acceptance criteria, notable comments,
   and any subtasks / linked issues / blockers.
3. **Offer a plan, based on how much the ticket gives you:**
   - **Sufficient data** (clear objective + enough scope/requirements to outline
     concrete steps): proactively **propose to draft an implementation plan**
     grounded in the ticket — e.g. *"I have enough from {KEY} to draft an
     implementation plan. Want me to?"* If they agree, draft it. If they want it
     formally approved and recorded, suggest switching to plan mode first.
   - **Insufficient data** (sparse or vague ticket): ask **"Shall we draft a
     plan together?"** and, if yes, gather the missing specifics before
     outlining.

### Newly created Jira ticket (`newTicket: true`)

There's nothing to investigate yet — only the details just entered. Offer to
plan: ask **"Shall we draft a plan together?"** and, if yes, work from what the
user described when creating it.

### Non-Jira work

Prod the user to create a plan: if the description is concrete enough,
**propose to draft an implementation plan** for the `{type}` work; otherwise ask
**"Shall we draft a plan together?"** Either way, nudge toward a plan before
diving into changes.

Make the plan offer **once and clearly** — if the user declines, don't repeat it.

---

## Jira MCP not available

If the Atlassian/Jira MCP is not connected, stop and tell the user to connect it
before retrying a Jira check-in:

1. Go to https://claude.ai/customize/connectors
2. Find **Atlassian** → click **Connect**
3. Complete the Atlassian sign-in popup → **Accept**

Then they can re-run `/checkin jira`.
