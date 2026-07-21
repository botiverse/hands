# Hands RBAC — roles & permissions reference

Hands authorizes app actions with atomic **permissions**. Human memberships use
named roles as permission bundles; app tokens may use a role bundle, explicit
permissions, or both. Route guards expand and union all grants into one
effective-permission set before authorizing the request.

Organization membership remains role-based. The public client
update/download/feedback-submit API is separate unless a route explicitly
requires an app-token permission.

## App permissions

The initial registry is:

| Permission | Meaning |
| --- | --- |
| `app:read` | Read app data, builds, releases, feedback, and analytics. |
| `app:publish` | Create and publish builds, releases, and distribution assets. |
| `app:admin` | Manage app settings, members, credentials, and destructive operations. |
| `feedback:write` | Submit feedback tickets for the app. |

App roles are centrally defined bundles:

| Role | Effective app permissions |
| --- | --- |
| `viewer` | `app:read` |
| `publisher` | `app:read`, `app:publish`, `feedback:write` |
| `admin` | `app:read`, `app:publish`, `app:admin`, `feedback:write` |

`GET /api/app-permissions` returns the live registry and role mappings used by
the Console. Adding a permission happens in the registry, not in a UI-specific
role/permission union.

## Roles

**Org roles** (rank low→high): `viewer` < `member` < `admin` < `owner`
**App roles** (rank low→high): `viewer` < `publisher` < `admin`

- **viewer** — read-only: browse apps, builds, releases, analytics, feedback.
- **member** — a collaborating team member: everything viewer can do, plus
  member-level writes (today: feedback triage).
- **publisher** (app) — ships: create builds/assets, publish/roll out/roll back
  releases, manage share links, toggle rollout/feature flags.
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

**App tokens** are app-scoped and have no org role. A token can keep a role
bundle (`viewer` or `publisher`), explicit permissions, or both. At least one
grant is required. The resolver expands the symbolic role bundle and unions it
with the explicit permissions, deduplicating the effective set. The role is not
copied into a permission snapshot, so future bundle changes remain authoritative.

Scoped tokens are also fenced to `/api/apps/{theirAppId}` before route-level
authorization. They cannot use org/global endpoints or another app's URL.

Legacy `requireAppRole(...)` routes still require an actual role grant. A
custom permission such as `app:publish` does not impersonate the `publisher`
role or satisfy every route historically guarded by that role. Custom grants
are accepted only by routes migrated to an exact `requireAppPermission(...)`
check. This keeps capability-specific permissions narrow while existing role
routes are migrated deliberately.

If stored explicit-permission JSON is empty, malformed, or contains an unknown
permission, the entire token grant fails closed: the role is not expanded,
effective permissions are empty, and authentication returns 403.

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

Route guards live in `worker/src/index.ts`. New capability-specific routes use
`requireAppPermission("<permission>")`; existing `requireAppRole("<role>")`
routes resolve the role bundle's required permission through the same
effective-permission evaluator. Registry and role mappings live in
`worker/src/lib/app_permissions.ts`; principal resolution and guards live in
`worker/src/lib/permissions.ts`. When changing a permission boundary, update
this table, the handler comment, and any agent/admin guide that names it.
