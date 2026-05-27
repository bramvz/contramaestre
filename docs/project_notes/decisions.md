# Architectural Decisions

Append-only index of project ADRs. One bullet per decision; full content
lives in [`../adr/`](../adr/). Never delete entries — when an ADR is
superseded, mark the line inline (`— **Superseded by ADR-NNN**`) and
keep it.

Format:

```
- **ADR-NNN** (YYYY-MM-DD, <Status>) — <Title> — guardrail: <one-line invariant> — [details](../adr/NNNN-kebab-title.md)
```

The full ADR file uses the template defined in
[`.claude/skills/adr-log/SKILL.md`](../../.claude/skills/adr-log/SKILL.md)
(Status, Scope, Context, Decision, Alternatives, Consequences,
Guardrails). The Stop hook that prompts for ADR consideration is
[`.claude/hooks/checks/adr-review.js`](../../.claude/hooks/checks/adr-review.js).

## Decisions

<!-- New entries go below this line, in ascending ADR number order. -->