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
reviewing the changelog, and never activate without explicit, current human
authorization.**

**Raft agents — manifest actions (no CLI, no tokens).** After a one-time
`raft integration login --service <hands-service>`, release management is
plain `raft integration invoke`; the server enforces app RBAC (viewer for
reads, publisher for writes):

```bash
# create a DRAFT from an existing verified build (the server enforces draft;
# activation is impossible on this endpoint — publish-release is the only path)
raft integration invoke --service <hands-service> --action create-release \
  --param app_id=<app-uuid> --param build_id=<build-uuid>

# attach reviewed bilingual notes (change-logs/<version>/*.md is the source of truth)
raft integration invoke --service <hands-service> --action update-release \
  --param app_id=<app-uuid> --param release_id=<release-uuid> \
  --param release_notes='{"en":"...","zh-CN":"..."}'

# ONLY after explicit human approval of the draft:
raft integration invoke --service <hands-service> --action publish-release \
  --param app_id=<app-uuid> --param release_id=<release-uuid>
```

Also available: `list-releases`, `get-release`, `list-release-shares`
(viewer), `create-release-share` / `revoke-release-share` (publisher —
share pages are how a draft gets to a human for device review; links have no
expiry unless you set one and die only on revoke). When reporting a
release, always cite the build's APK SHA-256 — the binary hash is the
authority, not a branch head or run id. A 403 means your identity lacks the
app role: ask an app admin to grant it; never borrow credentials.

**Humans / CI — hands CLI** (browser login or deploy token):

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

### Exact iOS simulator QA artifacts

Use this lane for a zipped `.app` bundle that Stamp or another agent must
download and install into Simulator by exact byte identity. It is deliberately
separate from iOS IPA/TestFlight publishing:

- the artifact kind is `ios-simulator-app` and the build is marked QA-only;
- `.ipa` and `.apk` filenames are rejected;
- Hands recomputes the uploaded ZIP's size and SHA-256 before marking it ready;
- completion is one-shot: verified bytes are copied to an immutable R2 key, so
  reusing an unexpired upload URL cannot replace the ready artifact;
- QA-only builds are rejected by the release-creation API and therefore never
  enter public latest/update/history offers.

The Agent Login flow is create → direct upload → complete → read/presign:

```bash
# 1. Declare the exact artifact. channel_id may be a UUID or slug and defaults
# to the app's default/main channel for ledger grouping only.
raft integration invoke --service <hands-service> \
  --action create-ios-simulator-artifact \
  --param app_id=<app-uuid> \
  --data-json '{
    "filename":"raft-ios-simulator.app.zip",
    "size_bytes":37563642,
    "sha256":"885b328f3a72299bd4368fd876dbcb4a8646b6f15b6e656fc8bec396a62beac8",
    "source_commit":"470023f98d154e50d7ba07b01a2cd53eb4367fc9",
    "version_name":"1.0",
    "build_number":"1",
    "bundle_id":"build.raft.app",
    "github_run_id":"29700366778",
    "github_artifact_id":"8446353537"
  }' --json > qa-artifact-create.json

# 2. PUT the bytes outside the integration transport. Use the exact method,
# URL, and Content-Type returned in the response's upload block.
curl --fail-with-body -X PUT \
  -H 'Content-Type: application/zip' \
  --upload-file raft-ios-simulator.app.zip \
  "$(jq -r .upload.url qa-artifact-create.json)"

# 3. Ask Hands to stream/hash the stored object. It becomes ready only when
# both exact byte length and SHA-256 match the declaration.
raft integration invoke --service <hands-service> \
  --action complete-ios-simulator-artifact \
  --param app_id=<app-uuid> \
  --param asset_id="$(jq -r .asset_id qa-artifact-create.json)" --json

# 4. The durable coordinate is (build_id, asset_id); download_api is a stable
# authenticated reference. Ask for a short-lived anonymous URL for binary use.
raft integration invoke --service <hands-service> \
  --action presign-ios-simulator-artifact \
  --param app_id=<app-uuid> \
  --param asset_id="$(jq -r .asset_id qa-artifact-create.json)" --json
```

Stamp should freeze both source commit and Hands asset coordinates, then
download the returned URL and verify the response's `server_sha256` before `ditto`
or `simctl install`. Use `list-ios-simulator-artifacts` with
`source_commit`, `github_run_id`, or `sha256` when recovering a coordinate;
use `get-ios-simulator-artifact` for the complete provenance record.

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

Triage is a **member-level** operation: reading tickets needs `viewer`, and
updating status/assignee or adding comments needs org **member** (or an app
`publisher` — e.g. a publisher deploy token). See the
[permissions reference](../rbac-permissions.md) for the full role matrix.

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
