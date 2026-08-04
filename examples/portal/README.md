# Installing contramaestre into the `portal` repo

`portal` is an npm-workspaces monorepo with two source roots — `frontend/src/`
(Vue 3 + TypeScript, `.ts`/`.vue`) and `backend/src/` (Fastify + JS ESM, `.js`) — and
topic docs already split under `docs/frontend/` and `docs/backend/`. Because portal has no
top-level `src/`, the docs-review check needs the multi-root **`mappings`** config (added in
contramaestre; see the repo root `README` and `.contramaestre/config/mustConsiderUpdatingDocs.json`).

This directory holds the two portal-specific config files, plus the steps to wire it up. It is
**not** installed automatically — these are hand-off steps for a human to run against the portal
repo.

## Prerequisite

Land the contramaestre changes first (the config-driven `mappings` support in
`docs-review.js`). If you install from GitHub in step 1, commit + push them; if you install from
the local working copy, they are picked up as-is.

## Steps

1. **Lay down the runtime in portal.** From the portal repo root, either add contramaestre as a
   dev dependency (its `postinstall` runs `contramaestre init`):

   ```sh
   # published (after pushing the contramaestre changes)
   npm install --save-dev github:your-user/contramaestre#v0.1.0
   # or local sibling checkout
   npm install --save-dev ../contramaestre
   ```

   …or run the installer directly, without adding a dependency:

   ```sh
   node ../contramaestre/bin/cli.js init
   ```

   This creates `portal/.contramaestre/` (router, handlers, checks, lib, default configs) and
   `portal/.claude/settings.json`, appends a managed block to portal's `.gitignore`
   (ignoring `.contramaestre/**` except `config/`), and sets `masterSwitch=true`. It
   **preserves** portal's existing `.claude/skills/customerNodes` and adds contramaestre's
   own skills (`generate-docs`, `reconcile-docs`, `adr-log`). Portal has no
   `.claude/settings.json` today, so nothing there is clobbered.

2. **Install the portal configs.** Overwrite the two freshly-created defaults with the versions
   in this directory (configs are preserve-on-install, so the installer will not touch them
   again on future upgrades):

   ```sh
   cp ../contramaestre/examples/portal/mustConsiderUpdatingDocs.json .contramaestre/config/
   cp ../contramaestre/examples/portal/adrTriggers.json            .contramaestre/config/
   ```

3. **Seed initial mirror docs.** docs-review is **opt-in** — it fires only when the mirror doc
   already exists. Use the `generate-docs` skill on the modules worth documenting, e.g.
   `frontend/src/components/flowDesigner/...` or `backend/src/routes/...`. Existing topic docs
   under `docs/` are left alone until a per-file mirror is seeded.

## Verify

Seed one mirror doc and confirm the loop fires:

1. `generate-docs "backend/src/routes/healthz.js"` → writes `docs/backend/routes/healthz.md`.
2. Edit `backend/src/routes/healthz.js` (any real change) without touching the doc.
3. End the Claude Code session. With `stopBehavior: "background"` a detached `docs-recon`
   agent is dispatched (look for a `BgDispatch:docs-recon-…` line in the contramaestre master
   log under `.contramaestre/hooks/logs/`); set `stopBehavior: "interactive"` in the config if
   you'd rather get an in-session nag while testing.

## Notes

- **Mirror path convention:** the `src/` segment is dropped —
  `frontend/src/components/Foo.vue → docs/frontend/components/Foo.md`,
  `backend/src/routes/user.js → docs/backend/routes/user.md`.
- **Other checks come along for free.** Installing brings the whole framework, not just
  docs-review: AccessGuard (secret-path blocklist), `format` (auto-format on Stop), BgBusyGuard,
  adr-review, and the SkillGate `deploy-to-google-cloud` rule that gates `gcloud` mutations
  behind `/deployToGoogleCloud`. Review `.contramaestre/config/conditionalTools.json` and
  `blockedPaths.json` if portal's workflows need different gating.
- **ADR location:** portal has no `docs/adr/` or `docs/project_notes/` yet; the first ADR
  creates them. Repoint `adrLocations` in `adrTriggers.json` if you prefer another location.
