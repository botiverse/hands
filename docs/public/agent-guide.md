---
title: "Agent Guide"
description: "How AI agents authenticate (Raft Agent Login, deploy tokens) and run releases, tickets, and shares."
category: "For agents"
order: 2
---

# Agent Guide

Hands is agent-native: everything an operator can do in the console, an AI
agent can do through the API and CLI. This guide covers how agents
authenticate and run the standard operations.

## Authentication

Two options, by scope:

| Method | Scope | Use for |
|---|---|---|
| **Hands CLI login** | Your org-wide role (viewer/member/admin/owner) | Admin operations: creating apps, reviewing/publishing releases, triaging tickets, managing shares. |
| **Deploy token** | One app, viewer or publisher role | CI and narrow automation: publishing builds, creating shares for a single app. |

### Hands CLI login

Install and authenticate once:

```bash
npm install -g @botiverse/hands-cli
hands login
hands apps list
```

Inside a managed Raft agent, `hands login` exchanges a one-time grant through
the manifest's `agent-login` action and stores a refreshable Hands session.
Humans use the browser flow. The separate Raft integration session is not
exported as `HANDS_AUTH_TOKEN`; do not scrape cookies or callback handoffs to
bridge the two. For migration guidance, call the manifest's `migration-help`
action. Other manifest actions have been removed, except for a temporary
feedback bridge while support consumers finish their CLI migration.

Your capabilities follow your Hands org role. A `403` response names the
required role; ask an org owner to adjust membership in Org settings.

### Cross-server app access

A Hands account is scoped to the Raft server identity that first created it.
When an app admin and the target principal are on different Raft servers, the
target may not appear in the admin's same-org picker. The target should run
`whoami` and privately send the returned non-secret Hands account id. An app
admin can then grant direct access without sharing a login token:

```bash
hands apps add-member <app> <hands-account-uuid> viewer
hands api GET /api/apps/<app-uuid>/members   # verify the direct grants
```

`hands apps update-member` changes the direct role and
`hands apps remove-member` removes only the direct grant; inherited org/server
access is unchanged.

### Deploy tokens

Create one in an app's **Settings -> Deploy Tokens** UI, or through the CLI
when the current identity is an app admin:

```bash
hands deploy-tokens create <app> --name github-ci --role publisher --json
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

Use the Hands CLI with either an interactive login or a deploy token:

```bash
hands releases show <app> <releaseId>                 # inspect draft + raw changelog
hands releases update <app> <releaseId> \
  --changelog-file zh=zh.md --changelog-file en=en.md  # reviewed, per-language
hands releases publish <app> <releaseId>              # explicit go-live
hands releases shares <app> <releaseId>
```

Share pages are how a draft gets to a human for device review; links have no
expiry unless you set one. When reporting a release, always cite the build's
APK SHA-256 — the binary hash is the authority, not a branch head or run id. A
403 means your identity lacks the app role: ask an app admin to grant it;
never borrow credentials.

Always derive `expected_revision` and `expected_scopes` from the same fresh
release detail immediately before a write. Every lifecycle mutation increments
the revision; a stale write returns `409 RELEASE_REVISION_CONFLICT` with zero
release, scope, fallback, or audit effects. Publish also compares the complete
scope set atomically. For a staged
full rollout with mandatory acceptance devices, keep one release and set
`scopes` to `full:all` plus each `device_group`; group members always receive
the target while other identified clients remain percentage-gated. Raise
`rollout_cohort_count` from the console or with
`PATCH /api/apps/:id/releases/:releaseId` as confidence grows. Release rows
expose `offered_count` / `current_count` so you can watch real coverage.

Each non-cancelled app/channel/product/release-type/version coordinate has one
release owner. A duplicate create returns `RELEASE_VERSION_ALREADY_EXISTS`
with that release/build/status. Cancelling disables the old lifecycle and
releases the coordinate for a corrected upload without deleting its build,
assets, or audit history. Restore reactivates the same release ID only if no
replacement owns the version. The publish CLI checks this before creating a
build so a known conflict cannot leave uploaded orphan assets. If another
publisher wins the coordinate after that preflight, the CLI marks its new build
`failed`, records the conflicting release in provenance, and reports the new
build ID for audit or manual inspection. For an Android version that reached
devices, use a higher version code so clients can update.

For a fuller per-version view, call
`GET /api/apps/:id/analytics/versions?window_days=30` with Agent Login or a
viewer-capable app token. The response includes one row per release-backed or
telemetry-only version with devices reported in the selected window, total devices seen,
update-check current/offered counts, feedback/crash counts, and artifact
downloads. `window_minutes` is also accepted for recent-report windows, but
SDK metrics pings are throttled, so this should not be labeled as true online
presence.

### TestFlight upload and distribution

Use `hands testflight --help` for upload, processing status, beta groups, and
distribution commands. The CLI is dry-run by default for store metadata
mutations; pass `--commit` only after reviewing the exact plan. TestFlight is a
separate state machine from Hands releases and App Store production
publishing, and the `.p8` stays encrypted in Hands.

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
[permissions reference](permissions.md) for the full role matrix.

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
hands apps create --slug my-app --name "My App" --platform android
hands apps client-key my-app
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

## Direct build asset upload retries

For asset ingest protocol v1, declare each asset with
`POST /api/apps/:appId/builds/:buildId/assets/uploads`, PUT the declared
bytes to `upload.url`, then POST `complete_url`. Completion synchronously
streams and verifies the full object before returning `state: ready`.
Allow a generous completion timeout for large artifacts. Verification time
depends on object size and storage/network throughput; there is no fixed
seconds-per-MB guarantee.

Keep the exact declaration body and `idempotency_key` for recovery. Repeating
it returns HTTP 200 with the same asset and its current state:

| State | `upload` | Next step |
| --- | --- | --- |
| `pending` | PUT instructions | If PUT already succeeded, retry completion with the existing bytes. Otherwise finish PUT first. |
| `verifying` | `null` | Wait and repeat the declaration to poll; do not PUT again while verification runs. |
| `ready` | `null` | Asset is complete. Repeating completion also returns HTTP 200 with `replayed: true`. |
| `failed` / `expired` | `null` | Terminal attempt; stop polling. A null upload alone never means success. |

A pending attempt past its upload expiry returns HTTP 410 instead of PUT
instructions. After a client timeout, first poll with the identical
declaration: the original completion may have finished, may still be running,
or may have lost its request lifetime. If it remains `verifying`, repeat
completion after a delay; an active verifier returns the busy response below.
An expired verifier lease can be reclaimed by completion while the upload
itself remains valid. The verifier lease lasts 15 minutes; the PUT upload
window lasts one hour. Bound retries by your job deadline.

| Completion response | Recovery |
| --- | --- |
| HTTP 503, `ASSET_UPLOAD_SEAL_INTENT_FAILED`, `retryable: true` | Honor `Retry-After` (seconds), then retry the same completion. Existing staging bytes are preserved. |
| HTTP 409, `ASSET_UPLOAD_BUSY`, `retryable: true` | Honor `Retry-After` and poll the declaration. `state: verifying` means a lease is held; it does not prove that its holder is still alive; `state: pending` means the competing verifier released its lease, so retry completion with the existing bytes. Avoid another PUT. |
| HTTP 409, `ASSET_UPLOAD_TERMINAL`, `retryable: false` | Stop retrying this attempt. |
| Other HTTP 409, including non-transient seal-intent errors | Resolve the conflict; do not retry indiscriminately. |
| HTTP 410 / 422 | Expired upload or integrity failure; stop this attempt. |

Read `GET /api/apps/{appId}/builds/{buildId}/assets/{assetId}/upload` to poll
without replaying a declaration. It returns `state`, `verification_started_at`,
`verifier_lease_expires_at`, `upload_expires_at` (Unix milliseconds),
`can_retry_complete`, and a durable `verification_error` for failed attempts.
The response is `no-store`. This endpoint requires the app publisher role.
The declaration replay and busy completion response also include these fields.

A verifier lease is not renewed: at its 15-minute deadline, call the same
completion again to take over using the existing staging bytes. A previous
verifier cannot commit after another has taken its lease. The one-hour upload
expiry still applies; no fixed verification duration per file size is promised.

`503 ASSET_UPLOAD_STORAGE_FAILED` includes `retryable:true`, `Retry-After`, and
`phase` (`staging_head`, `seal_head`, `staging_read`, `staging_stream`,
`seal_stream`, `seal_write`, or `seal_readback`). Retry the same completion
without another PUT. The attempt returns to pending and keeps its staging
bytes; a later verifier uses a new immutable seal generation. A rejected stream
operation cancels the other stream branches so they do not wait forever for a
failed consumer. Abrupt runtime termination may still leave a verifying lease
until its deadline.

Integrity failures remain terminal and include `reason` and the available
expected/actual measurements. SHA-256 mismatch includes both hashes and sizes;
size mismatch includes expected and observed size. `GET .../upload` retains
the terminal reason even after object cleanup.

For terminal attempts, create a new pending build to retry the release with
new declarations. A build already marked `failed` cannot resume uploads.
Changing only the idempotency key does not free an occupied asset slot.
The abort endpoint can discard an abandoned pending upload after verification
has stopped; failed or expired attempts may already be owned by cleanup.
Do not mark the build succeeded until every required asset is ready.

## Rules for agents

1. **Draft-first**: CI never completes a release; publishing is an explicit,
   reviewed step (see the release runbook in the repository).
2. **Changelogs are user-facing**: write them per-language
   (`{"en": …, "zh-CN": …}`); clients receive their locale's version.
3. **Attribution matters**: act under your own agent login or a token minted
   for the purpose — never reuse a human's browser session.
4. **Secrets stay out of channels**: never paste bearer tokens or deploy
   tokens into shared chat; audit logs already attribute your actions.

### Application identifiers and direct grants

Raw `/api/apps/:appId/...` requests and console `/apps/:appId/settings` links
use the full application UUID. Resolve a slug with `hands apps get <slug> --json`
and use its `id`; a name or slug is not an application ID.

Adding an application member also creates an organization viewer membership
if needed. This does not downgrade the application role: an application admin
can administer that application while remaining an organization viewer. Direct
application grants are included in the application list even when the session's
selected organization is different. Other applications in that organization are
not exposed by a direct grant.
