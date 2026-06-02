---
name: reconcile-docs
description: Use when a Claude Code Stop hook reports watched src/ files changed but their mirrored docs/ files were not edited. Reconcile only the supplied source/doc pairs from .contramaestre/config/mustConsiderUpdatingDocs.json. Update docs to preserve maintainer context: why the code exists, how it connects to other modules, non-obvious constraints, contracts, and gotchas. Avoid API-reference or changelog-style restatements of code.
argument-hint: "[source/doc pairs from hook]"
user-invocable: false
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash(git diff *)
  - Bash(git status *)
  - Bash(git ls-files *)
  - Bash(date +%F)
---

# Reconcile docs

Input: `$ARGUMENTS` contains one or more `(source, doc)` pairs from the Stop hook. Process exactly those pairs. Do not scan or create docs for unrelated files.

Goal: keep `docs/` as a selective mirror of `src/` for files that warrant durable explanation. Write for both humans and LLMs maintaining the code later.

## Documentation standard

Document what is hard to recover from source alone:

- why the module exists and what responsibility boundary it owns
- how it connects to upstream callers, downstream effects, shared state, schemas, jobs, hooks, or related modules
- contracts other code relies on
- non-obvious constraints, invariants, ordering, security, performance, or lifecycle assumptions
- gotchas, failure modes, and design trade-offs

Do not document:

- signatures, parameter lists, obvious control flow, or well-named private helpers
- directory layout already implied by the mirror path
- formatting-only changes, renames with no semantic impact, or generic framework behavior
- commit history; `git log` already has that

Prefer the smallest useful edit. If a paragraph is obvious after reading the source, delete or avoid it.

## Workflow

1. Get today’s date with `date +%F`.

2. For each supplied `(source, doc)` pair:
   - Inspect the source change with `git diff HEAD -- <source>`.
   - If the source is untracked, read the file and check `git status --short -- <source>`.
   - Read the existing doc if present.
   - If the doc is missing, create it from the template below.

3. Classify the source change:
   - Behavior, public API, contract, data flow, integration, constraint, or gotcha changed: update the relevant prose and `Last updated:`.
   - Internal refactor, rename, formatting, or helper-only change with no contract impact: update only `Last updated:`.
   - Bug fix with unchanged intended behavior: update `Last updated:`; add a gotcha only when the failure mode is likely to recur.
   - Deletion or deprecation: mark the doc section deprecated and explain the replacement when evident. Do not delete the doc unless the hook explicitly requests removal.
   - Unclear impact: make the lightest safe edit, usually `Last updated:` only, and mention the uncertainty in the final summary.

4. Edit docs:
   - Preserve the existing structure unless it is misleading.
   - Batch multiple sources into one doc edit when they share the same doc.
   - Keep sections short. Use bullets only for actual contracts, gotchas, or relationships.
   - Do not add empty sections or write “none known.”
   - Keep `## Recent changes` only for reader-relevant behavior, contract, deprecation, or gotcha updates. Do not add routine refactors there.

5. Validate:
   - Re-read each edited doc.
   - Run `git diff -- <doc>` for touched docs and remove noise.
   - Do not commit.

## New doc template

  ```markdown
  # <Module name>

  <2-4 sentences explaining why this module exists, what boundary it owns, and why that boundary matters. Do not restate the filename or obvious implementation.>

  ## Connections

  - <Only non-obvious relationships to callers, jobs, schemas, hooks, services, shared state, or neighboring modules.>

  ## Constraints and gotchas

  - <Invariants, ordering assumptions, lifecycle constraints, failure modes, or surprising behavior.>

  ## Design notes

  - <Important trade-offs or alternatives rejected. Omit this section if there is no non-obvious rationale.>

  ## Recent changes

  - <YYYY-MM-DD> — <Optional: only behavior, contract, deprecation, or gotcha changes worth preserving.>

  Last updated: YYYY-MM-DD
  ```