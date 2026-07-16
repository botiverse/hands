# Hands RBAC — roles & permissions reference

Hands uses **role-based access control** (RBAC) with two role scopes: an
**organization** role and a per-**app** role. Every admin API endpoint declares
the minimum role required; the public (client) update/download/feedback-submit
API is separate and needs no admin role.

## Roles

**Org roles** (rank low→high): `viewer` < `member` < `admin` < `owner`
**App roles** (rank low→high): `viewer` < `publisher` < `admin`

- **viewer** — read-only: browse apps, builds, releases, analytics, feedback.
- **member** — a collaborating team member: everything viewer can do, plus
  member-level writes (today: feedback triage).
- **publisher** (app) — ships: create builds/assets, publish/roll out/roll back
  releases, manage share links, toggle rollout/feature flags. A publisher may
  also export the app's ASC team key solely for local Apple notarization; this
  is a sensitive audited exception intended for protected release runners.
- **admin** — configures and secures: app settings, channels & types, member and
  server-grant management, deploy tokens, client keys, store credentials, and
  destructive actions (archive/purge/delete).
- **owner** (org) — org superuser.

## How a role is resolved

For an app request, `ensureAppRole` grants access if **either** bar is met:

- the caller's **org** role is high enough, **or**
- their explicit **app** role is high enough.

Org role overrides app role, so an org admin/owner implicitly has admin on every
app in the org. The default org bar is `viewer` for read endpoints and `admin`
for write endpoints — except endpoints that opt into a lower org bar:

- **Feedback triage** (`requireFeedbackTriageRole`) uses org bar **member** (or
  app `publisher`). So any org member can triage; a bare read-only viewer cannot.

**Deploy tokens** carry only an app role (`viewer` or `publisher`) and no org
role, so a token uses the app-role bar directly — e.g. a `publisher` token can
triage feedback, a `viewer` token can only read it.

## Endpoint → minimum role

Reads (`GET`/list/stream/download/analytics) are `viewer` unless noted.

| Area | Write endpoints | Min role |
| --- | --- | --- |
| **Feedback triage** | `PATCH feedback/:id`, `POST feedback/:id/comments` | **member** (or app publisher) |
| **App create** | `POST /api/apps` | org member |
| **APK parse** | `POST /api/parse-apk` | org member |
| **Builds** | `POST builds`, `PATCH builds/:id`, `POST builds/:id/assets`, `POST upload` | publisher |
| **Releases** | `POST/PATCH/DELETE releases`, `publish`, `rollback`, `bump-rollout`, `force-update` | publisher |
| **Release shares** | `POST/PATCH/DELETE releases/:id/shares` | publisher |
| **Rollout / feature flags** | `PUT feature-flags/:key` | publisher |
| **Operations** | `POST operations/:id/retry` | publisher |
| **Local notarization** | `POST notarization-credentials/export` | publisher (sensitive, audited, non-cacheable) |
| **App config** | `PATCH app`, `POST/PATCH/DELETE channels`, `product-types`, `release-types` | admin |
| **App icon** | `PUT icon` | publisher |
| **Membership & access** | `POST/PATCH/DELETE members`, `server-grants`, `deploy-tokens` | admin |
| **Secrets** | `client-key`, `rotate-client-key`, `asc-credentials`, `agc-credentials` (get/put/verify/submit) | admin |
| **Destructive** | `POST archive`, `POST purge`, `DELETE builds/:id`, `DELETE operations/:id` | admin |

Reads gated above viewer (sensitive metadata): `GET deploy-tokens`,
`GET client-key`, `GET asc-credentials`, `GET agc-credentials`,
`GET agc-submissions/:id` require **admin**.

## 403 responses are machine-readable

A denied call returns the required and current role plus a `next_action` and a
`manage_url` pointing at where an admin grants the role — act on it, don't just
fail:

```json
{
  "error": "insufficient_app_role",
  "code": "INSUFFICIENT_APP_ROLE",
  "required_role": "publisher",
  "current_role": "viewer",
  "next_action": "...ask an admin to grant you the 'publisher' role on this app (Access → Members).",
  "manage_url": "https://app.hands.build/apps/{appId}/settings"
}
```

## Changing an operation's required role

Route guards live in `worker/src/index.ts` (`requireAppRole("<role>")`,
`requireOrgRole(...)`, or a purpose-built guard like
`requireFeedbackTriageRole()`); the role helpers and `ensureAppRole` live in
`worker/src/lib/permissions.ts`. When you change a bar, update this table, the
handler doc comment, and any agent/admin guide that names the role.
