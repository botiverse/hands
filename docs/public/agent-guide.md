# Agent Guide

Hands is agent-native: everything an operator can do in the console, an AI
agent can do through the API and CLI. This guide covers how agents
authenticate and run the standard operations.

## Authentication

Two options, by scope:

| Method | Scope | Use for |
|---|---|---|
| **Raft Agent Login** | Your org-wide role (viewer/member/admin/owner) | Admin operations: creating apps, reviewing/publishing releases, triaging tickets, managing shares. |
| **Deploy token** | One app, viewer or publisher role | CI and narrow automation: publishing builds, creating shares for a single app. |

### Raft Agent Login

From a Raft-connected machine:

```bash
raft integration login --service hands-4cc7a2
raft integration invoke --service hands-4cc7a2 --list-actions
raft integration invoke --service hands-4cc7a2 --action list-apps
```

Raft stores the Agent Login session inside the integration service and applies
it when `integration invoke` calls a manifest action. It deliberately does
**not** export that session as `HANDS_AUTH_TOKEN`, and `raft integration env`
may report that the service is HTTP-actions-only. This is a security boundary,
not a missing login.

Do not expect the local `hands` CLI to inherit an integration login. Use
manifest actions for interactive admin work. Use a dedicated app deploy token
for CLI/CI automation.

Your capabilities follow your Hands org role. A `403` response names the
required role; ask an org owner to adjust membership in Org settings.

### Deploy tokens

Created in an app's **Settings -> Deploy Tokens** UI, by the CLI when it
already has an admin bearer token, or by an admin Agent Login action:

```bash
raft integration invoke --service hands-4cc7a2 \
  --action create-deploy-token \
  --param app_id=<app-uuid> \
  --data-json '{"name":"github-ci","app_role":"publisher"}' \
  --json
```

The raw token is returned exactly once. Pipe it directly into the target CI
secret store, then discard the response file. If storage fails, revoke that
token id and mint a replacement; never leave an unused credential active.

Deploy tokens are app-scoped, never expire unless revoked, and are
attributed in audit logs as
`deploy-token:<name>@<app>`. Prefer them for CI; prefer Agent Login for
interactive agent operations.

### Integration manifest URL contract

Manifest action paths must be absolute, and URL resolution must produce the
real API route. The correct Hands contract is:

```json
{
  "execution": { "base_url": "https://hands.build" },
  "endpoint": { "path": "/api/apps" }
}
```

Do not combine `base_url: https://hands.build/api` with an action path that
also starts with `/api`; manifest validation rejects the duplicated API base.
Do not combine that nested base with `/apps` either: standard URL resolution
resets the path to `https://hands.build/apps`, which serves the dashboard
instead of the API. After changing a manifest, verify both
`--list-actions` and one real JSON action response in production.

## Standard operations

All CLI commands accept `--json` for scripting.

### Release flow (draft-first policy)

CI creates drafts; an agent reviews and publishes. **Never publish without
reviewing the changelog.**

```bash
hands releases show <app> <releaseId>                 # inspect draft + raw changelog
hands releases update <app> <releaseId> \
  --changelog-file zh=zh.md --changelog-file en=en.md  # reviewed, per-language
hands releases publish <app> <releaseId>              # explicit go-live
```

Staged rollout: publish, then raise `rollout_cohort_count` from the console
or `PATCH /api/apps/:id/releases/:releaseId` (`{"rollout_cohort_count": 25}`)
as confidence grows. Release rows expose `offered_count` / `current_count`
so you can watch real coverage.

For a fuller per-version view, call
`GET /api/apps/:id/analytics/versions?window_days=30` with Agent Login or a
viewer-capable app token. The response includes one row per release-backed or
telemetry-only version with devices reported in the selected window, total devices seen,
update-check current/offered counts, feedback/crash counts, and artifact
downloads. `window_minutes` is also accepted for recent-report windows, but
SDK metrics pings are throttled, so this should not be labeled as true online
presence.

### Ticket triage (feedback + crashes)

```bash
hands feedback list <app> --status open --kind crash
hands feedback show <app> <ticketId>
hands feedback update <app> <ticketId> --status in_progress --assignee <name>
hands feedback comment <app> <ticketId> "reproduced; fix in progress"
hands feedback update <app> <ticketId> --status resolved
```

Crash tickets carry a grouping signature and, when the build's
`mapping.txt` was uploaded, an auto-retraced stack in the comments.
`GET /api/apps/:id/feedback/crash-groups` aggregates by signature.

### Share links

```bash
hands releases share <app> <releaseId> --password <pw>   # password optional
hands releases shares <app> <releaseId>
hands releases update-share <app> <releaseId> <shareId> --ttl-seconds 1209600
hands releases revoke-share <app> <releaseId> <shareId>
```

The share URL is printed once; tokens are stored hashed.

### Apps (org member role)

```bash
# create (API; CLI covers list/get)
curl -X POST https://hands.build/api/apps \
  -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-app","name":"My App","platform":"android"}'
```

New apps are seeded with default channels (`main`, `preview`, `nightly`) and
product types, and get a **client key** (`qk_…`) that clients must send as
`X-Hands-Client-Key` on feedback/crash submissions (the legacy
`X-Quiver-Client-Key` header is still accepted):

```bash
curl -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/client-key          # read
curl -X POST -H "Authorization: Bearer $HANDS_BEARER_TOKEN" \
  https://hands.build/api/apps/<appId>/rotate-client-key   # (re)generate
```

Rotation invalidates the old key immediately — client builds must be updated
with the new one.

## Handling permission (403) errors

Hands's role-403s are **machine-readable** — act on them instead of failing
silently:

```json
{
  "error": "insufficient_org_role",       // or "insufficient_app_role"
  "required_role": "member",
  "current_role": "viewer",
  "resource": "POST /api/apps",            // the action you attempted
  "org_id": "…", "app_id": null,
  "manage_url": "https://app.hands.build/orgs/{orgId}/members"
}
```

On this response:

1. **Don't retry blindly** — you are missing `required_role`, not hitting a
   transient error.
2. **Tell the human the exact next step**, quoting `manage_url`: e.g. "I need
   **admin** on this org to run `<resource>` (currently **viewer**). An org
   admin can raise my role at `<manage_url>`, then I'll retry."
3. **Retry the same request** once they confirm the role change.

App creation (`POST /api/apps`) needs an **org member or higher** specifically —
an app-member role or deploy token is not enough. New Agent Login accounts
normally start as org members; an org admin can manually downgrade an account to
viewer for read-only access. If an app should live under a different
organization, that org's member/admin creates it there rather than changing
your role in this one.

## Rules for agents

1. **Draft-first**: CI never completes a release; publishing is an explicit,
   reviewed step (see the release runbook in the repository).
2. **Changelogs are user-facing**: write them per-language
   (`{"en": …, "zh-CN": …}`); clients receive their locale's version.
3. **Attribution matters**: act under your own agent login or a token minted
   for the purpose — never reuse a human's browser session.
4. **Secrets stay out of channels**: never paste bearer tokens or deploy
   tokens into shared chat; audit logs already attribute your actions.
