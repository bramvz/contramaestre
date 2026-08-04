---
name: generate-docs
description: >
  Create an initial documentation file for a single source file at its
  configured mirror path (by default src/X.ext → docs/X.md, or per the
  `mappings` in mustConsiderUpdatingDocs.json). Use when the user
  asks to "generate docs for <file>", "create initial docs for <file>",
  "document this module", or adds a new module that warrants durable
  prose. Companion to `reconcile-docs`: this skill seeds the doc,
  reconcile-docs maintains it afterwards. Refuses to overwrite an
  existing doc.
when_to_use: >
  User-invoked only — never trigger automatically from a hook. Skip
  files whose purpose is obvious from name (trivial utilities,
  one-off scripts, generated code, tests, pure boilerplate).
argument-hint: '"<source file path>"'
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - "Bash(git log *)"
  - "Bash(date +%F)"
  - "Bash(git add docs/*)"
---

# generate-docs

Create an initial documentation file for one source file. Use this when
adding a new module that warrants long-term explanation. To keep
already-existing docs in sync with code changes use the
[`reconcile-docs`](../reconcile-docs/SKILL.md) skill instead — the two
are deliberately separate so the per-file mirror is **opt-in**.

`$ARGUMENTS` is the source-file path (project-relative or absolute).

## Documentation standard

Document what is hard to recover from source alone:

- why the module exists and what responsibility boundary it owns
- how it connects to upstream callers, downstream effects, shared
  state, schemas, jobs, hooks, or related modules
- contracts other code relies on
- non-obvious constraints, invariants, ordering, security,
  performance, or lifecycle assumptions
- gotchas, failure modes, and design trade-offs

Do not document:

- signatures, parameter lists, obvious control flow, or well-named
  private helpers
- directory layout already implied by the mirror path
- generic framework behavior
- commit history; `git log` already has that

If a paragraph would be obvious to anyone reading the source, delete
or avoid it. Prefer the smallest useful first draft — the doc grows as
the module accrues gotchas.

## Workflow

1. **Resolve the source path** from `$ARGUMENTS`. Normalize to
   project-relative. Verify the file exists. If the path is outside
   the mirrored area (not under any configured `sourceRoot`, or not
   under `src/` when no mappings are configured), confirm with the
   user before proceeding.

2. **Compute the mirror doc path.** If
   `.contramaestre/config/mustConsiderUpdatingDocs.json` defines a
   `mappings` list, use the first mapping whose `sourceRoot` prefixes
   the source path: strip that `sourceRoot`, prepend the mapping's
   `docRoot`, and swap the extension for `.md`. Otherwise fall back to
   the single-root default `src/ → docs/`.
   - With `mappings` (e.g. a `frontend/` + `backend/` monorepo):
     - `frontend/src/components/Foo.vue` → `docs/frontend/components/Foo.md`
     - `backend/src/routes/user.js` → `docs/backend/routes/user.md`
   - Single-root default (no `mappings`):
     - `src/foo/bar.ts` → `docs/foo/bar.md`
     - `src/foo/bar.py` → `docs/foo/bar.md`
   - Any source extension → `.md`

3. **Refuse to overwrite.** If the doc file already exists, stop and
   tell the user. They can either delete it manually or invoke
   `reconcile-docs` to update the existing doc.

4. **Read the source** and skim `git log -n 5 -- <source>` if helpful
   to spot recurring themes for "Recent changes".

5. **Get today's date** with `date +%F`.

6. **Ask focused questions only when you cannot determine the answer
   from the code itself.** Required for a useful doc:
   - *Why does this module exist?* (the boundary it owns — usually the
     hardest thing to infer from code alone)
   - *What constraints or gotchas have bitten people?*
   - *What contracts do callers / downstream consumers rely on?*

   Ask at most 3 concise questions. If the user already supplied
   enough context in their invocation, proceed without asking.

7. **Create the parent directories and write the doc** using the
   template below.

8. **Stage only that one doc file:** `git add <docPath>`. Do not
   commit.

9. **Respond with:**
   - Source path
   - Doc path created
   - Any open questions you skipped (so the user can fill them in)

## New doc template

```markdown
# <Module name>

<2-4 sentences explaining why this module exists, what boundary it
owns, and why that boundary matters. Do not restate the filename or
obvious implementation.>

## Connections

- <Only non-obvious relationships to callers, jobs, schemas, hooks,
  services, shared state, or neighboring modules.>

## Constraints and gotchas

- <Invariants, ordering assumptions, lifecycle constraints, failure
  modes, or surprising behavior.>

## Design notes

- <Important trade-offs or alternatives rejected. Omit this section
  if there is no non-obvious rationale.>

## Recent changes

- <YYYY-MM-DD> — initial document.

Last updated: YYYY-MM-DD
```

If after reading the source there is no non-obvious "why" to write —
i.e., the file does not warrant durable prose yet — say so and refuse
to write a placeholder doc. Empty templates erode trust in the mirror.

## Quality rules

- One source file per invocation.
- Title: noun phrase or imperative, ≤ 60 chars.
- Each section ≤ 5 bullets, each bullet ≤ 1 line.
- No code blocks longer than 3 lines.
- No pasting of function signatures, imports, or full type
  declarations.

## Do not

- Do not overwrite an existing doc. Direct the user to
  `reconcile-docs` instead.
- Do not infer human intent from a diff or call sites alone. Use the
  source for facts; ask the user for "why".
- Do not document trivial files (one-off scripts, generated code,
  pure boilerplate, tests).
- Do not write placeholder docs for files that do not yet warrant
  durable prose.
- Do not commit. The user owns the commit.
