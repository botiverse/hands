# Quiver Admin User Guide

Status: **draft v1** (X.1.4 — cross-cutting docs)
Audience: humans and agents operating the Quiver admin UI at `https://quiver-worker.artin.workers.dev/`

---

## 1. Overview

Quiver is an open-source APK / desktop-app / OTA-bundle distribution platform. The admin UI is the operator console for managing apps, versions, releases, channels, organizations, and teams.

**URL**: `https://quiver-worker.artin.workers.dev/`

**Auth**: Login with Raft. Sign in with your Raft account. Humans and agents are both first-class principals — an agent login lands in the same org as the human owner of the same Raft server.

**Stack**:
- Single-page React app (Vite + Tailwind + TanStack Query)
- Routes: `/`, `/settings`, `/apps/:appId/*`, `/orgs/:orgId`, `/invites/:token`
- All data flows through `worker/src/index.ts` Hono handlers; admin endpoints guarded by per-route role middleware (RBAC).

---

## 2. Caveats (as of 2026-06-28)

- **Invites do NOT send email yet.** The backend returns an `invite_url` (e.g. `https://quiver-worker.artin.workers.dev/invites/<uuid>`); the admin UI copies it to your clipboard on create. You'll need to share the URL manually (Slack DM, email, etc.). Email delivery is a P5.5 / P5.6 follow-up.
- **Duplicate pending invite returns 409.** Same email + same org + status=pending → conflict. Resend the existing one or wait for it to expire (7-day TTL).
- **App invite / member add ensures the principal is at least an org viewer.** Adding someone to an app who isn't in the org yet fails with 403/404 — invite them to the org first.
- **Last org owner cannot be removed or demoted.** If you try to remove the last owner, you get 409. Promote another member to owner first.
- **RBAC is per-route, not per-field.** Some endpoints reject unauthorized access; no per-field hiding.

---

## 3. Page-by-page

### 3.1 Top bar (always visible)

```
[ quiver ] [ Apps ] [ Org  owner ] [ Settings ]         alice@acme.com  [agent]  [avatar]  Logout
```

- **Org** link goes to `/orgs/<your-org-id>` (or `/orgs/placeholder` before first login). The role chip next to "Org" shows your current org role (owner=purple, admin=blue, others=gray).
- If `account.principal_type === 'agent'`, an **agent** badge is shown next to your display name.

### 3.2 `/` Apps list

Lists all apps visible to your current org. Each row shows:

- App name + "📦 Archived" badge if archived
- "⚠ other org" badge if `app.org_id` doesn't match your current org (defensive — shouldn't happen in v1)
- Slug (monospace)
- Description (1-2 line preview)
- Three stat badges: 📦 N product types, 🏷️ N release types, 🚀 N channels
- Platform badge (e.g. `android`, `ios`)
- "Show archived" toggle above the list with count
- "+ New app" → opens the 3-step App Creation Wizard

**App Creation Wizard** (3 steps):

1. **Basics** — name (required), slug (auto-generated kebab-case from name, editable), description (optional)
2. **Product types** — checklist of what we ship:
   - Android APK (default checked)
   - Electron desktop app (with sub-picker for supported platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64)
   - React Native OTA bundle
   - iOS IPA
   - CLI binary
   - "Add custom product type"
3. **Release types** — review seeded defaults (stable/rc/beta/internal with colors) + add custom

On save: creates the app + seeds default `product_types` + default `release_types` (stable/rc/beta/internal with colors) + default channels (production/beta/internal with `bundle_id` overrides for parallel install).

### 3.3 `/apps/:appId` App detail (Overview tab)

Default route. Shows:
- App name + platform badge + slug + "📦 Archived" badge if archived
- 3 quick links: "View audit log →", "Manage publishing →", "Manage access →"
- **Versions section** (default tab content):
  - Each version row: name (code) + channel + enabled/disabled badge + ⚠ force / scheduled badges
  - "Upload APK" button replaced by "+ New release" link to the Releases tab (legacy UploadDialog removed; release-first flow only)
  - "+ New channel" button → CreateChannelDialog (name/slug + optional bundle_id/password/git_url)
  - Each channel rendered as a `ChannelRow` card with Edit button → EditChannelDialog (change name, bundle_id, password, git_url, 2-step delete confirm with ref-check)
- **Operations section** (embed): recent parse/upload/publish operations with retry/delete actions

### 3.4 App context nav (under the top bar)

```
App context:  [Releases]  [Overview]  [Builds]  [Access]  [Audit]
```

Each link navigates to a sub-route under `/apps/:appId/`.

### 3.5 `/apps/:appId/builds` Builds tab

List of build artifacts. Each row: version (code) + product_type badge + release_type (colored chip) + channel + status badge (pending/building/succeeded/failed/smoke_testing/smoke_test_passed/smoke_test_failed) + ⚠ force badge + scheduled badge + date.

Click "Show assets" to expand an `BuildAssetList` table: platform / arch / filetype / size / sha256 prefix.

Click "Prepare release" to open `PrepareReleaseDialog`:
- Radio: full / platform / ip_range scope
- If platform: comma-separated platforms (e.g. `darwin-arm64,darwin-x64,linux-x64`)
- If ip_range: comma-separated CIDR (e.g. `10.0.0.0/8,192.168.0.0/16`)
- Click "Release" → `POST /api/apps/:appId/releases` with built scopes
- Backend defaults to `full/all` if scopes omitted

### 3.6 `/apps/:appId/releases` Releases tab

List of releases and drafts. Stats cards: Total / Active / Draft / Channels. Filter by channel and status. Each `ReleaseRow`:
- Status badge (draft=blue, active=green, superseded=gray, cancelled=red)
- Release type colored chip
- Channel + product type
- full/scoped badge + ⚠ force badge + rollout % badge
- Build ID hash
- Changelog and build/scope details shown inline
- Actions on drafts: **Publish**, **Edit**, **Delete draft**
- Actions on active releases: **Edit**, **Bump rollout** (slider 0-100% → `POST /bump-rollout`), **Force** / **Unforce** (`POST /force-update`), **Roll back** (creates a new release pointing to the current build), **Cancel release**

### 3.7 `/apps/:appId/access` App access tab

Per-app member management. Shows current principal's `org_role` + a guard ("can manage members" if owner/admin).

- **AppMemberList** — `GET /api/apps/:appId/members`:
  - Columns: principal (display name + provider_subject prefix) / type (human/agent) / app_role (admin/publisher/viewer dropdown for owner/admin except self) / joined date / Remove (owner/admin, except self, confirm)
- **AddAppMemberForm** — `POST /api/apps/:appId/members`:
  - Fetches `listOrgMembers`, filters out members already on this app
  - Select principal + role (admin/publisher/viewer) + Add button
  - Empty state: "All org members are already on this app."
  - Hint: "Direct add — principal must already be an org member. For inviting new people, use the Org settings → Invites tab."

### 3.9 `/apps/:appId/audit` Audit log

Per-app audit log (`audit_logs WHERE app_id = ?`). Columns: when / actor (with agent badge) / app id / action / payload (truncated JSON). 100 most recent entries.

**Actor display:** when `actor_type === 'agent'`, the actor cell renders a purple "agent" badge next to the principal UUID. Humans render as plain text. This matches the same convention used in Org settings → Members / Invites / Audit tabs, so you always know whether you're looking at human or agent activity without checking external tools.

**Action taxonomy** (the values you'll see in the action column):

| Action | When it appears |
|--------|-----------------|
| `app.create` / `app.update` / `app.archive` / `app.unarchive` | App CRUD via wizard or AppDetail Settings |
| `build.create` / `build.update` | New build uploaded or patched (status changes append here) |
| `build_asset.create` / `build_asset.delete` | Per-(platform, arch, filetype) binary upload or removal |
| `build.delete` | Whole build removal (only allowed when zero assets and zero releases) |
| `release.create` / `release.update` / `release.publish` / `release.cancel` / `release.rollback` / `release.bump_rollout` / `release.force_update` | Release draft, edit, publish, cancel, rollback, staged rollout bump, force-update toggle |
| `channel.create` / `channel.update` / `channel.delete` | Channel CRUD |
| `product_type.create/update/delete` / `release_type.create/update/delete` | Schema-row CRUD |
| `apk.upload` | Legacy APK upload (pre-P2.4 flow; still emitted when `/api/upload` is called) |
| `operation.create` / `operation.update` | Long-running op log (parse-apk, SSE-streamed operations) |
| `webhook.create` / `webhook.update` / `webhook.archive` | Webhook subscription CRUD (see §3.10 Webhooks tab) |
| `webhook.delivery` | A webhook delivery attempt succeeded or failed terminally |

**Payload column** shows the first ~400 chars of the JSON payload (truncated with ellipsis). Hover to see the full payload via `title=` attribute. Click the row to copy the full `payload_json` to clipboard (UX nicety; P5.5 v2 will add a side drawer).

**Filtering (v2):** P5.5 will add `?actor_id=` / `?action_prefix=` / `?app_id=` query params; today there's a single "All entries" view per app.

### 3.10 `/orgs/:orgId` Org settings (5 tabs)

**Access**: org owner / admin only (per-route RBAC; the Webhooks tab is admin-only). The org_id in the URL must match your current org; otherwise a yellow warning banner shows.

**Tabs**:
- **General** — static info from `/api/auth/me`: external_provider, server_id, server_slug, principal_type, org_id, your org_role (colored), server_role
- **Members** — `GET /api/orgs/:orgId/members`:
  - Columns: principal / type (agent badge) / @username (if present) / email (humans) or agent manifest URL (agents) / org_role dropdown (owner/admin/member/viewer, owner/admin only, excludes self) / joined date / last login / Remove (owner/admin only, confirm)
  - Filter dropdown: All / Humans only / Agents only
- **Invites** — `GET /api/orgs/:orgId/invites`:
  - Columns: email / role / status badge (pending/accepted/revoked/expired) / expires / Resend (admin) / Revoke (admin, confirm)
  - Status filter dropdown: All / Pending / Accepted / Revoked / Expired
  - "+ Invite member" button → modal: email (required, lowercased) + role (member/viewer) + optional message
  - On create: `POST /api/orgs/:orgId/invites` returns `invite_url`; admin UI copies to clipboard + shows toast with URL
- **Audit** — `GET /api/orgs/:orgId/audit-logs`:
  - 100 most recent entries; org-scoped (cross-app aggregation)
  - Columns: when / actor (agent badge) / app id / action / payload (truncated JSON, same hover-to-show as §3.9)
  - Org-level mutations (member role change, invite create/revoke) currently do **not** write to `audit_logs` because the table requires `app_id NOT NULL`; they are tracked only in Raft's own audit log. P5.5 v2 will widen the schema.
- **Webhooks** (admin only) — `GET /api/orgs/:orgId/webhooks`:
  - Each row: enabled badge (green / gray) + URL + subscribed events (badges, empty = "all") + Disable / Deliveries / Archive buttons
  - "+ Add webhook" button → modal: URL (required) + Secret (HMAC, min 8 chars) + Events checkboxes (empty = all). On create: toast confirms, webhook appears in list.
  - Click "Deliveries" to drill into that webhook's delivery history (`GET /api/orgs/:orgId/webhooks/:id/deliveries`): columns = when / event / status badge (pending=blue / succeeded=green / failed=red) / attempts of max / HTTP code / next attempt or error.
  - **Delivery semantics (v1):** Worker Cron Trigger (`*/5 * * * *`) reaps pending deliveries every 5 minutes. Failures retry with exponential backoff (5m → 30m → 2h, 3 attempts max), then are permanently `failed`. Every delivery carries `X-Quiver-Signature: sha256=<hmac>` so receivers can verify it came from your org.
  - **Secret rotation:** v1 has no rotation endpoint; archive the old webhook and create a new one. v2 will add a `POST /api/orgs/:orgId/webhooks/:id/rotate-secret` endpoint.

### 3.11 `/invites/:token` Accept invite (public)

No auth required to view. If you're not signed in, you see "Sign in with Raft to accept" button (preserves return_to so you bounce back after OAuth). If signed in, you see "Accept invite" button which calls `POST /api/invites/:token/accept` and navigates to the app or org dashboard.

States:
- `pending` — accept button
- `accepted` — "✓ You've already accepted this invite."
- `expired` — red message, ask inviter for new one
- `revoked` — red message, ask inviter

### 3.12 `/settings` Settings

Top card: "Current account" — display name + principal_type (with agent badge) + server + server_role + org_id + your org_role (colored) + hint to ask owner/admin to change role.

Below: static infrastructure info (Raft callback URL, Cloudflare account, D1 db, R2 bucket, container image).

---

## 4. Common workflows

### 4.1 Publish a new release (release-first, multi-asset)

The current publish flow is **release-first**. One release can carry multiple binaries (multi-arch Android / multi-OS Electron) — the schema's `build_assets` table holds one row per (platform, arch, filetype).

1. Go to `/apps/:appId/releases`.
2. Click **"+ New release"** → modal opens:
   - Pick **channel** (e.g. `production`), **product_type** (e.g. `android-apk`), **release_type** (e.g. `stable`)
   - Enter **version name** (e.g. `1.2.3`) + **version code** (integer, e.g. `42`) — manual; the release is metadata-first, binaries attach separately
   - Optional **changelog** (markdown; multi-line; first line is the summary shown in the row)
   - Pick **scope**: `full` (default, all users), `platform` (CSV like `android-arm64-v8a,darwin-arm64`), `user_cohort` (UUID), `ip_range` (CIDR)
3. Review the release, then click **Save draft** or **Publish now**. Both paths create the build and a draft release first; Publish now then calls `POST /api/apps/:appId/releases/:releaseId/publish`.
4. Queued files are uploaded to R2 (`POST /api/apps/:appId/upload`) and registered as `build_asset` rows (`POST /api/apps/:appId/builds/:buildId/assets`). Asset failures preserve the release row so operators can retry from the row.
5. Draft releases are editable and not visible to public update checks. Published releases become available to the public API when scope/channel/product match.
6. Release rows keep the **Assets drop zone** for adding or removing APK / dmg / deb / exe files after creation. The panel auto-detects platform/arch/filetype from the filename (e.g. `myapp-arm64-v8a.apk` → `android / arm64-v8a / apk`); you can override optional metadata per file.

Quiver no longer exposes the legacy versions publishing UI. Operators publish through Releases; the old `/apps/:appId/publish` route redirects to `/apps/:appId/releases`.

### 4.2 Roll back a bad release

1. Go to `/apps/:appId/releases`.
2. Find the bad active release.
3. Click "Roll back" → `POST /api/releases/:id/rollback` creates a new active release pointing to the **previous build** (or to a `build_id` you specify).
4. Old active release is now `superseded`.

### 4.3 Bump rollout percentage for a staged release

1. `/apps/:appId/releases` → find the active release.
2. Click "Bump rollout" → slider appears.
3. Drag to target % (0-100, step 5) → click "Set" → `POST /bump-rollout`.

### 4.4 Force update (critical fix)

1. `/apps/:appId/releases` → active release → click "Force" → `POST /force-update`.
2. All clients must install on next check; no "skip" option.
3. Unforce via "Unforce" button when fixed.

### 4.5 Add a new team member to your org

1. `/orgs/<your-org>` → Invites tab → "+ Invite member".
2. Enter their email (e.g. `bob@acme.com`).
3. Pick role: `member` (humans default) or `viewer` (agents / read-only).
4. Optional message.
5. Click "Create invite" → URL copied to clipboard.
6. Share the URL with the invitee (manually, since email delivery isn't wired yet — see Caveats §2).
7. They open the URL → `/invites/<token>` → "Sign in with Raft to accept" → they're in.
8. To promote them to admin/owner: Members tab → change role dropdown.

### 4.6 Add a new human to a specific app (not the whole org)

1. They need to be in your org first → invite via Org settings → Invites (steps above).
2. Once they're an org member: `/apps/:appId/access` → "Add app member" → select their name from the dropdown → pick role (`admin`/`publisher`/`viewer`) → Add.

### 4.7 Promote an agent to publisher or admin

Same flow as humans. Agents default to `org_role='viewer'` and `app_role='viewer'`. In Org settings → Members, change their role via the dropdown (you need to be owner/admin to do this).

### 4.8 Archive an app (soft delete)

(If your org allows it; v1 only ships the schema — archive UI is being built.) Future: `/apps/:appId` → Settings → "Archive" toggle.

---

## 5. Roles reference

| Role | Scope | Can do |
|---|---|---|
| `org:owner` | Org | Everything: manage members, manage invites, transfer ownership (v2), archive org, manage all apps in org |
| `org:admin` | Org | Manage members + invites, edit most app settings; can't delete last owner |
| `org:member` | Org | Read members + invites; view audit log |
| `org:viewer` | Org | Read members; no invite management |
| `app:admin` | App | Manage app members, edit app settings, delete app |
| `app:publisher` | App | Upload builds, create releases, edit release metadata |
| `app:viewer` | App | Read builds/releases; no edits |

**Effective role** for a (account, app) is `MAX(org_role, app_role)`. See `account-org-invite.md` §5.2 for the full role matrix.

---

## 6. Keyboard shortcuts

(none yet — v2 candidate)

---

## 7. Troubleshooting

### "500 Internal Server Error" with no body

- Check the Worker's `wrangler tail` for stack trace.
- Most common cause: `D1_ERROR: ...` — check if the migration you need is applied (`npx wrangler d1 migrations list quiver-db --remote`).
- Look at the corresponding audit log row (`/apps/:appId/audit` or `/orgs/:orgId/audit`) for the `error` field.

### "404 not found" for a newly-created app

- Quiver caches list endpoints. Wait ~5s for the cache to expire, or hard-refresh the page (Cmd+Shift+R / Ctrl+Shift+R).

### "401 unauthorized" on an admin endpoint

- The session cookie may have expired (14-day TTL by default; check `/settings` → "current account" shows you a valid session).
- Re-login at `/api/auth/login`.

### "403 forbidden" on an edit action

- Your current role doesn't allow the action. The UI usually shows a warning — check the page for `⚠ owner / admin required`.

### Invite "expired" but you just created it

- Check the clock on the server vs the URL you used. The 7-day TTL is computed at server time. If your local clock is way off, the visible "expires" date may be misleading.

---

## 8. Future (P5.5 / P5.6 / Phase 3 / Phase 4)

- Agent audit log per-org detail
- Org ownership transfer
- Multi-org switcher (top-bar dropdown)
- Scheduled release at exact datetime
- Smoke test integration (real macOS / Windows / Linux VMs)
- App transfer between orgs
- Webhook delivery with retry-on-failure queue
- CLI: `@oranix/quiver-cli` npm package for CI integration (see `cli-reference.md`)

---

## 9. Related docs

- `publish-architecture.md` — full system design
- `publish-tasks.md` — implementation task tracker
- `account-org-invite.md` — org/team/RBAC design
- `cli-reference.md` — `@oranix/quiver-cli` design (Phase 3)
- `tasks.md` link from `publish-tasks.md` — full task list with status
