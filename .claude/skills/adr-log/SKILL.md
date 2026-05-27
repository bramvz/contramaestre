---
name: adr-log
description: >
  Use when recording or superseding an Architectural Decision Record (ADR)
  for a repository. Creates one full ADR file plus one decision-log entry.
  Trigger on requests like "log a decision", "record an ADR", "track this
  choice", or when meaningful code changes introduce or alter architecture,
  contracts, dependencies, interfaces, invariants, data ownership, or layering.
when_to_use: >
  Do not trigger for routine refactors, generated files, pure bug fixes,
  formatting, or dev-tool bumps with no architectural consequence. If rationale,
  alternatives, or trade-offs are missing, ask targeted questions instead of
  inventing intent from code.
argument-hint: '"<title or decision summary>"'
user-invocable: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - "Bash(date +%F)"
  - "Bash(mkdir -p docs/adr docs/project_notes)"
  - "Bash(git add docs/adr/*)"
  - "Bash(git add docs/project_notes/decisions.md)"
---

# adr-log

Capture decision intent for humans and future agents. Keep it short, factual,
and useful during code review.

Use `$ARGUMENTS` as the initial decision summary when present.

## Defaults

- ADR files: `docs/adr/<number>-<kebab-title>.md`
- Ledger: `docs/project_notes/decisions.md`
- If `.claude/hooks/config/adrTriggers.json` exists, read it first and use
  `adrLocations.perFileGlob` and `adrLocations.logFile`.
- New repos start at `0001`. Existing repos keep their current numeric width.
- Next number = max number found in ADR filenames or ledger entries + 1.
- Use `date +%F` for `YYYY-MM-DD`.

## ADR threshold

Write an ADR for decisions that affect future implementation choices:

- Boundaries, layering, ownership, APIs, schemas, events, or contracts.
- Technology/library/vendor choices with long-term coupling.
- Security, reliability, performance, data, or operability constraints.
- Numeric or behavioral invariants future code must preserve.
- Reversing or replacing an earlier ADR.

Skip and say why for routine refactors, pure bug fixes, generated files,
formatting, test-only changes, or dev-tool bumps with no architectural effect.

## Quality rules

- One decision per ADR.
- Title: imperative, present tense, ≤ 60 chars.
- Prefer bullets. Max 5 bullets per section.
- Context = why now. Decision = what rule/choice binds future work.
- Alternatives must be real options, not strawmen.
- Consequences must include one benefit and one cost.
- Guardrails tell future agents what to preserve and when to revisit.
- Do not paste diffs, long code blocks, Slack threads, or meeting dumps.
- Do not infer human intent from a diff. Use code for facts; ask for missing
  rationale, alternatives, or trade-offs.

## Workflow

1. Resolve paths, date, and next number.
   - Glob ADR files, read the ledger if it exists, and detect collisions.
   - If filename numbers and ledger numbers disagree, use the max and mention it.

2. Gather only missing inputs.
   Required: title, context, decision, alternatives, benefit, cost/guardrail.
   Ask at most 3 concise questions. If the user already provided enough, proceed.

3. Create missing directories if using defaults:

   ```bash
   mkdir -p docs/adr docs/project_notes
   ```

4. Write the ADR file.

   Path:

   ```text
   docs/adr/<NNNN>-<kebab-title>.md
   ```

   Template:

   ```markdown
   # ADR-<NNNN>: <Title> (YYYY-MM-DD)

   **Status:** Accepted
   **Scope:** <components/APIs/files/contracts affected>

   ## Context
   - <Why this decision is needed now>
   - <Constraint, quality attribute, or problem being resolved>

   ## Decision
   - <The chosen rule, technology, contract, or invariant>

   ## Alternatives
   - <Option A> — rejected because <reason>
   - <Option B> — rejected because <reason>

   ## Consequences
   - Benefit: <what becomes easier, safer, faster, or clearer>
   - Cost: <trade-off, risk, coupling, or maintenance burden>

   ## Guardrails
   - Preserve: <invariant/contract future changes must respect>
   - Revisit when: <condition that could invalidate this decision>
   ```

5. Append exactly one ledger line.

   If the ledger does not exist, create it first:

   ```markdown
   # Architectural Decisions

   Append-only index. Each line links to the full ADR. Do not delete or reorder
   entries; supersede them inline.
   ```

   Entry format:

   ```markdown
   - **ADR-<NNNN>** (YYYY-MM-DD, Accepted) — <Title> — guardrail: <one-line invariant> — [details](../adr/<NNNN>-<kebab-title>.md)
   ```

   If paths are configured differently, compute the relative link from the ledger
   file to the ADR file.

6. Validate before responding.
   - ADR number is unique.
   - ADR filename matches the title.
   - Ledger has one new entry and links to the ADR.
   - Required sections are present and short.
   - No invented rationale or fake alternatives.
   - Existing ADRs were not reordered or rewritten.

7. Stage touched files only.
   - Stage ADR files individually: `git add docs/adr/<file>.md`
   - Stage ledger separately: `git add docs/project_notes/decisions.md`
   - Never run `git add .`.
   - Do not commit.

8. Respond with:
   - ADR number
   - ADR file path
   - Ledger path
   - Any skipped/staging caveat

## Superseding an ADR

When replacing a prior ADR:

1. Write a new ADR with `**Status:** Accepted`.
2. In the new ADR context, mention `Supersedes ADR-<old>`.
3. Edit only the old ADR status line:

   ```markdown
   **Status:** Superseded by ADR-<new> on YYYY-MM-DD
   ```

4. Append this marker to the old ledger line:

   ```markdown
   — **Superseded by ADR-<new>**
   ```

5. Stage the new ADR, old ADR, and ledger.
6. Never delete the old ADR.