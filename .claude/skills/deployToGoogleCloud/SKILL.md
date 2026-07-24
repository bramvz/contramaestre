---
name: deployToGoogleCloud
description: Opens the SkillGate that authorises mutating gcloud commands for one GCP project and environment. Usage - /deployToGoogleCloud <project> <env> where <project> is the GCP project id and env is dev, uat, or prd. User-invoked only; without this gate open, all mutating gcloud commands are denied by the PreToolUse hook.
---

# Deploy to Google Cloud

Invoking this skill is what opens the gate: the contramaestre hooks match the
literal invocation text against the `deploy-to-google-cloud` rule in
`.contramaestre/config/conditionalTools.json` and capture `<project>` and
`<env>` as the gate's variables. This file adds no permissions by itself —
follow the instructions below so your gcloud usage matches what the gate will
actually allow.

## Step 1 — Validate the invocation

The gate only opens if the invocation matched this exact shape:

```
/deployToGoogleCloud <project> <env>
```

- `<project>`: GCP project id — lowercase letter first, then lowercase
  letters/digits/hyphens, 2–31 chars total (e.g. `mosaic-api-dev`).
- `<env>`: exactly one of `dev`, `uat`, `prd`.

If either argument is missing or malformed, **the gate did NOT open** (the
hook's regex didn't match) and you cannot open it yourself. Tell the user the
correct form and ask them to re-invoke the skill — do not attempt any mutating
gcloud command in the meantime.

## Step 2 — Confirm scope to the user

When the arguments are valid, state plainly:

- Deploy gate open for project `<project>`, environment `<env>`.
- It is valid for **60 minutes**, in **this session only**, and does **not**
  extend to subagents — run all gcloud commands directly, never via the Agent
  tool.

Then ask what to deploy, or proceed if the user already said so.

## Rules for every gcloud command while the gate is open

The PreToolUse hook screens each command independently. Commands that don't
match the allowed patterns are denied even with the gate open, so:

1. **Always pass the project explicitly**: `--project=<project>` (or
   `--project <project>`) on every mutating command. The ambient gcloud
   default project does NOT count — a command without the flag is denied.
   (`gcloud config set project <project>` is allowed but does not unlock
   flag-less commands; prefer the explicit flag.)
2. **Cloud Run resource names — env-dependent**:
   - **dev / uat gate (relaxed)**: any service name is fine, suffixed or
     not — EXCEPT names referencing `prd`. Any `gcloud run` command that
     mentions a prd resource is denied on a non-prd gate; production is only
     reachable through a `prd` gate. Never rename a resource to dodge this;
     ask the user to re-invoke the skill with `prd` instead.
   - **prd gate (strict)**: the service name must end in `-prd`
     (e.g. `faq-api-prd`). Keep the `-<env>` suffix convention for new
     services in every environment, even where the gate doesn't force it.
3. **Read-only commands need no gate** and always work: `--version`, `help`,
   `auth list`, `projects list`, `config list|get-value`, `logging read`.
4. **Never attempt the always-denied commands**, with or without the gate:
   `projects delete`, anything under `organizations`, `iam service-accounts
   delete`, `resource-manager folders delete`. If the task seems to require
   one, stop and tell the user to run it themselves.

## When a command is denied anyway

Do not retry near-variations to find a pattern that slips through — the gate
is the authorisation mechanism, not an obstacle. A denial means one of:

- the command didn't name `--project=<project>` explicitly → add the flag;
- a `gcloud run` command referenced a `prd` resource on a dev/uat gate →
  production needs its own `prd` gate; ask the user to re-invoke for prd;
- a Cloud Run resource on a `prd` gate lacked the `-prd` suffix → use the
  correct name;
- the gate expired (60 min) or this is a new session → ask the user to
  re-invoke `/deployToGoogleCloud <project> <env>`;
- the command targets a different project than the gate was opened for → ask
  the user to re-invoke the skill for that project.

Report the denial and the fix to the user in one sentence; only re-run after
the cause is addressed.
