# Agent Guide

Quiver is agent-native: everything an operator can do in the console, an AI
agent can do through the API and CLI. This guide covers how agents
authenticate and run the standard operations.

## Authentication

Two options, by scope:

| Method | Scope | Use for |
|---|---|---|
| **Raft Agent Login** | Your org-wide role (viewer/admin/owner) | Admin operations: creating apps, reviewing/publishing releases, triaging tickets, managing shares. |
| **Deploy token** | One app, viewer or publisher role | CI and narrow automation: publishing builds, creating shares for a single app. |

### Raft Agent Login

From a Raft-connected machine:

```bash
raft integration login --service quiver
# → prints a one-time "service callback handoff URL"
curl -s "<that URL>"
# → {"ok":true,"token_type":"Bearer","access_token":"…","expires_at":…,"account":{…}}
```

Use the token as `Authorization: Bearer <access_token>` against `/api/*`, or
export it for the CLI:

```bash
export QUIVER_BEARER_TOKEN=<access_token>
```

Callback codes are one-time; re-run the login for a fresh session. Your
capabilities follow your Quiver org role — `403` responses name the required
role (ask an org owner to adjust membership in Org settings).

### Deploy tokens

Created in an app's **Access** tab (or by an admin via API). App-scoped,
never expire unless revoked, attributed in audit logs as
`deploy-token:<name>@<app>`. Prefer them for CI; prefer Agent Login for
interactive agent operations.

## Standard operations

All CLI commands accept `--json` for scripting.

### Release flow (draft-first policy)

CI creates drafts; an agent reviews and publishes. **Never publish without
reviewing the changelog.**

```bash
quiver releases show <app> <releaseId>                 # inspect draft + raw changelog
quiver releases update <app> <releaseId> \
  --changelog-file zh=zh.md --changelog-file en=en.md  # reviewed, per-language
quiver releases publish <app> <releaseId>              # explicit go-live
```

Staged rollout: publish, then raise `rollout_cohort_count` from the console
or `PATCH /api/apps/:id/releases/:releaseId` (`{"rollout_cohort_count": 25}`)
as confidence grows. Release rows expose `offered_count` / `current_count`
so you can watch real coverage.

### Ticket triage (feedback + crashes)

```bash
quiver feedback list <app> --status open --kind crash
quiver feedback show <app> <ticketId>
quiver feedback update <app> <ticketId> --status in_progress --assignee <name>
quiver feedback comment <app> <ticketId> "reproduced; fix in progress"
quiver feedback update <app> <ticketId> --status resolved
```

Crash tickets carry a grouping signature and, when the build's
`mapping.txt` was uploaded, an auto-retraced stack in the comments.
`GET /api/apps/:id/feedback/crash-groups` aggregates by signature.

### Share links

```bash
quiver releases share <app> <releaseId> --password <pw>   # password optional
quiver releases shares <app> <releaseId>
quiver releases update-share <app> <releaseId> <shareId> --ttl-seconds 1209600
quiver releases revoke-share <app> <releaseId> <shareId>
```

The share URL is printed once; tokens are stored hashed.

### Apps (admin role)

```bash
# create (API; CLI covers list/get)
curl -X POST https://quiver.oranix.io/api/apps \
  -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"my-app","name":"My App","platform":"android"}'
```

New apps are seeded with default channels (`main`, `preview`, `nightly`) and
product types.

## Rules for agents

1. **Draft-first**: CI never completes a release; publishing is an explicit,
   reviewed step (see the release runbook in the repository).
2. **Changelogs are user-facing**: write them per-language
   (`{"en": …, "zh-CN": …}`); clients receive their locale's version.
3. **Attribution matters**: act under your own agent login or a token minted
   for the purpose — never reuse a human's browser session.
4. **Secrets stay out of channels**: never paste bearer tokens or deploy
   tokens into shared chat; audit logs already attribute your actions.
