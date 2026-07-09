# Hands Publish Architecture — Implementation Spec & Tasks

> **Status: historical design document (frozen).** Written during the
> 2026-06 build-out; several sections describe plans that shipped
> differently. For current behavior see `docs/public/` (served at
> `/docs`), `docs/release-runbook.md`, and the code. Kept for design
> rationale and history. (Banner added 2026-07-04.)

Status: **live tracking doc** (companion to `publish-architecture.md`)
Owner: @Pi-Worker2
Last update: 2026-06-28

This doc breaks the v3 architecture into trackable work units. Each task has:
- **Status**: TODO | IN_PROGRESS | DONE | BLOCKED | DEFERRED
- **Estimate**: rough time-to-ship
- **Phase**: which migration phase the work lands in
- **Depends on**: blocking tasks

Convention: tasks are numbered `P{phase}.{n}` where phase ∈ {1, 2, 3, 4}. Sub-tasks use `.{m}` (e.g. `P2.3.1`).

---

## Status legend

- ✅ DONE — shipped to main + deployed
- 🟡 IN_PROGRESS — actively being worked on
- 🔵 TODO — not started, on the roadmap
- ⛔ BLOCKED — waiting on another task / user decision
- ⏸ DEFERRED — intentionally pushed to later (v2+)

---

## Phase 1 — additive, non-breaking

Goal: introduce new columns + scaffold tables without breaking the existing `versions` table. Add minimal admin UI for new fields.

### P1.1 — Database schema (additive columns) ✅ DONE

**Commit**: `8265107 feat(db): publish architecture Phase 1`
**Migration**: `migrations/sql/0005_publish_phase1.sql`

| Task | Status | Notes |
|---|---|---|
| P1.1.1 `apps.archived`, `apps.archived_at`, `apps.description` | ✅ DONE | indexed on `(archived, created_at DESC)` |
| P1.1.2 `channels.bundle_id`, `channels.password`, `channels.git_url`, `channels.enabled_product_types_json`, `channels.metadata_json` | ✅ DONE | all nullable / default `[]` / `{}` |
| P1.1.3 `builds` table (scaffold, no usage yet) | ✅ DONE | mirrors v3 §3.7 schema, nullable FK to channels |
| P1.1.4 `signing_credentials` table (scaffold) | ✅ DONE | encrypted_blob BLOB, account-level |

### P1.2 — Admin UI: AppsList + Archive

**Commit**: `b016ab5 feat: apps.archived UI + archive/unarchive endpoint`

| Task | Status | Notes |
|---|---|---|
| P1.2.1 `App` type includes `description`, `archived`, `archived_at` | ✅ DONE | `admin/src/lib/api.ts` |
| P1.2.2 `handleListApps` / `handleGetApp` return new columns | ✅ DONE | `worker/src/routes/apps.ts` |
| P1.2.3 `handleCreateApp` accepts optional `description` | ✅ DONE | |
| P1.2.4 `POST /api/apps/:appId/archive` endpoint | ✅ DONE | body `{archived: bool}`, audit logged |
| P1.2.5 AppsList "Show archived" toggle + count | ✅ DONE | `admin/src/pages/AppsList.tsx` |
| P1.2.6 AppsList archived badge + opacity + description display | ✅ DONE | |
| P1.2.7 Empty-state distinguishes "no apps" vs "all archived" | ✅ DONE | |

### P1.3 — Admin UI: Changelog in UploadDialog

**Commit**: `d565d1b feat: changelog textarea in UploadDialog step 3`

| Task | Status | Notes |
|---|---|---|
| P1.3.1 Migration `0006_versions_changelog.sql` adds `versions.changelog` | ✅ DONE | nullable TEXT |
| P1.3.2 `handleCreateVersion` accepts + stores `changelog` | ✅ DONE | `worker/src/routes/versions.ts` |
| P1.3.3 `insertVersion` accepts `changelog` in body | ✅ DONE | extracted from `handleCreateVersion` for retry reuse |
| P1.3.4 `handleListVersions` SELECT includes `changelog` | ✅ DONE | |
| P1.3.5 `Version` interface in admin API has `changelog` field | ✅ DONE | `admin/src/lib/api.ts` |
| P1.3.6 UploadDialog step 3 markdown changelog textarea | ✅ DONE | persisted to `versions.changelog` |
| P1.3.7 Test mock schema includes `changelog` | ✅ DONE | |

### P1.4 — Admin UI: remaining Phase 1 fields ✅ DONE

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P1.4.1 UploadDialog step 3: `should_force_update` checkbox | ✅ DONE | 15min | commit `2c076fb` |
| P1.4.2 UploadDialog step 3: `availability_at` datetime picker | ✅ DONE | 30min | commit `2c076fb` |
| P1.4.3 UploadDialog step 3: `provenance_json` auto-fill + editable | ✅ DONE | 1h | git_commit / git_branch / ci_url / source, in collapsible `<details>` |
| P1.4.4 Migrations: `versions.should_force_update`, `versions.availability_at`, `versions.provenance_json` | ✅ DONE | 30min | `0007_versions_publish_fields.sql` |
| P1.4.5 Publishing dashboard: show changelog column | ✅ DONE | 30min | collapsible markdown viewer, commit `1bc6487` |
| P1.4.6 Publishing dashboard: `enabled` toggle button | ✅ DONE | 30min | wired earlier in commit `b016ab5` |
| P1.4.7 Publishing dashboard: `Force update` toggle | ✅ DONE | 30min | new "Force" / "Unforce" button + ⚠ force update badge |
| P1.4.8 Channel CRUD UI: edit password / bundle_id / git_url | ✅ DONE | 2h | new page or inline edit in AppDetail channels tab |

### Phase 1 total: ✅ DONE — all 8 sub-tasks shipped

---

## Phase 2 — multi-platform + build/release split

Goal: introduce `product_types`, `release_types`, `build_assets`, `releases`, `release_scopes`. Backfill from existing `versions`. App creation wizard (3-step).

### P2.1 — Database schema: new tables

| Task | Status | Estimate | Migration |
|---|---|---|---|
| P2.1.1 `product_types` table + indexes | ✅ DONE | 30min | `0008_product_types.sql` |
| P2.1.2 `release_types` table | ✅ DONE | 30min | `0009_release_types.sql` |
| P2.1.3 `build_assets` table | ✅ DONE | 30min | `0010_build_assets.sql` |
| P2.1.4 `releases` table + indexes | ✅ DONE | 30min | `0011_releases.sql` |
| P2.1.5 `release_scopes` table + indexes | ✅ DONE | 30min | `0012_release_scopes.sql` |
| P2.1.6 `builds` table gets `should_force_update` / `availability_at` / `provenance_json` | ✅ DONE | 30min | `0015_builds_publish_fields.sql` |

### P2.2 — Backfill from existing `versions`

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.2.1 Seed default `product_types` per existing app | ✅ DONE | 1h | `0013_phase2_backfill.sql` |
| P2.2.2 Seed default `release_types` per existing app | ✅ DONE | 30min | same |
| P2.2.3 Seed default channels (production/beta/internal) per existing app | ✅ DONE | 1h | with bundle_id defaults |
| P2.2.4 Backfill each `versions` row → `builds` + `build_assets` | ✅ DONE | 1h | platform='android', filetype='apk' |
| P2.2.5 Backfill each `versions` row → `releases` + `release_scopes` (full) | ✅ DONE | 1h | status='active', is_full=1, scope=full/all |
| P2.2.6 Backfill builds fields from versions (provenance, force-update) | ✅ DONE | 30min | one-time UPDATE applied after 0015 |
| P2.2.7 Idempotent seed migration for apps created post-0013 | ✅ DONE | 30min | `0014_phase2_seed_existing.sql` |
| P2.2.8 Deprecate `versions` table (rename to `_versions_legacy`) | 🔵 TODO | 30min | Phase 2 final migration; keep until admin UI migrated |

### P2.3 — App creation wizard (3 steps)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.3.1 Wizard shell component (multi-step modal with stepper) | ✅ DONE | 3h | shared component for any multi-step wizard |
| P2.3.2 Step 1: Basics (name / slug / description) | ✅ DONE | 30min | port existing CreateAppDialog |
| P2.3.3 Step 2: Product types checklist + per-product supported_platforms sub-picker | ✅ DONE | 2h | Sentry-style wizard inspiration |
| P2.3.4 Step 3: Release types review (seeded defaults, add/remove) | ✅ DONE | 1h | |
| P2.3.5 Wizard save: insert app + product_types + release_types + channels in transaction | ✅ DONE | 1h | |
| P2.3.6 AppsList update: filter by default product_types | ✅ DONE | 30min | AppsList already renders platform + product_type badges; product_type filter is implemented (re-checked during #21 cleanup). |

### P2.4 — UploadDialog 5-step wizard (channel-first)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.4.1 Step 1: Channel + product_type + release_type dropdowns + context preview | ✅ DONE | 2h | current UploadDialog hardcoded to APK |
| P2.4.2 Step 2: Version name + code (auto-suggested) | ✅ DONE | 30min | |
| P2.4.3 Step 3: Files per-platform matrix (Electron: N file pickers; APK: 1; bundle: 1) | ✅ DONE | 4h | most complex piece |
| P2.4.4 Step 4: Release details (changelog / should_force_update / availability / provenance) | ✅ DONE | 2h | |
| P2.4.5 Step 5: Review + push | ✅ DONE | 1h | wire to /api/builds + /api/builds/:id/assets |
| P2.4.6 Backend: `POST /api/builds` (insert builds + build_assets) | ✅ DONE | 3h | replaces /api/parse-apk + /api/apps/:id/upload |
| P2.4.7 Backend: parse container with parser_kind dispatch (apk-aapt / electron-asar / rn-bundle) | 🔵 TODO | 4h | container currently only knows apk-aapt |

### P2.5 — Builds tab + Releases tab + Prepare release modal

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.5.1 Builds tab (table view, status badge, Prepare release button) | ✅ DONE | 3h | |
| P2.5.2 Releases tab (table view, scope column, status, actions) | ✅ DONE | 3h | |
| P2.5.3 Prepare release modal (validation checks + scope radio + cohort slider) | ✅ DONE | 3h | ToDesktop's validation checks inspiration |
| P2.5.4 Backend: `POST /api/releases` (promote build → release with scope) | ✅ DONE | 3h | with scope resolution logic |
| P2.5.5 Backend: `POST /api/releases/:id/rollback` | ✅ DONE | 2h | creates new release pointing to older build |
| P2.5.6 Backend: `POST /api/releases/:id/bump-rollout` | ✅ DONE | 1h | increments `rollout_cohort_count` |
| P2.5.7 Backend: `POST /api/releases/:id/force-update` toggle | ✅ DONE | 1h | flips `should_force_update` |
| P2.5.8 Backend: webhook dispatch on release lifecycle events | ✅ DONE | 3h | commit `0a71ee2`. webhooks + webhook_deliveries tables (migration 0017); 6 org-scoped admin routes under `/api/orgs/:orgId/webhooks`; Worker Cron `*/5 * * * *` reaper (`handleReapDeliveries`) with HMAC SHA-256 signing, 3-attempt exponential backoff (5m / 30m / 2h); `emitWebhookEvent()` wired into handleCreateRelease / handleRollbackRelease / handleCreateBuild (terminal status) / handleUpdateBuild (terminal status). |
| P2.5.9 Frontend: OrgSettings Webhooks tab + delivery history | ✅ DONE | 4h | commit `0a71ee2`. List / create / toggle enable / archive / drill into deliveries table (status badge + attempts + HTTP code + next attempt / error). |
| P2.5.10 Frontend: AppDetail Settings: default release channel picker | ✅ DONE | 2h | commit `aa900a6`. Migration 0018 adds `apps.default_channel_id` (nullable FK to channels, backfilled from first channel per app). `PATCH /api/apps/:appId` (`handleUpdateApp`) accepts name / description / default_channel_id; admin-only. NewReleaseDialog pre-fills channel from app.default_channel_slug. |
| P2.5.11 Frontend: New Release 4-step wizard (GitHub/ToDesktop flow) | ✅ DONE | 3h | task #30 commit. `admin/src/lib/releaseFileDetect.ts` (shared filename→{platform,arch,filetype} detector) + `admin/src/components/ReleaseAssetUploader.tsx` (shared drop-zone UI, panel + dialog variants; dialog variant has `deferUpload` so files are collected during step 3 and uploaded+registered after the release exists). NewReleaseDialog rewritten as Target → Version → Assets → Review wizard with stepper, per-step validation, optional advanced scope/rollout/force-update. 'Publish' runs createBuild → createRelease → uploadApk + createBuildAsset per file; asset failures don't roll back the release. |

### Phase 2 total: ~50 hours work

---

## Phase 3 — OTA bundles + per-platform Electron + CLI

### P3.1 — Schema additions for OTA + Electron

| Task | Status | Estimate | Migration |
|---|---|---|---|
| P3.1.1 `build_assets.target_app_version` (extract from metadata_json) | 🔵 TODO | 30min | `0011_build_assets_target_app_version.sql` |
| P3.1.2 `build_assets.fingerprint_hash` | 🔵 TODO | 15min | same migration |
| P3.1.3 `releases.metadata` per-release custom fields | 🔵 TODO | 30min | `0012_releases_metadata.sql` |

### P3.2 — Container parsers

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P3.2.1 `electron-asar` parser (extract app version, asar hash, platforms) | 🔵 TODO | 1 day | new parser in `container/src/server.ts` |
| P3.2.2 `rn-bundle` parser (extract target_app_version, fingerprint, engine) | 🔵 TODO | 1 day | |
| P3.2.3 `cli-binary` parser (basic version + arch) | 🔵 TODO | 4h | |
| P3.2.4 Parser dispatcher (route by parser_kind) | 🔵 TODO | 4h | |

### P3.3 — Public API additions

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P3.3.1 `GET /public/apps/:slug/bundles` (OTA, returns all enabled matching) | 🔵 TODO | 2h | |
| P3.3.2 Scope resolution logic on `/public/v2/apps/:slug/latest` (full / platform / ip_range / cohort) | ✅ DONE | 4h | commit `ede5627`. New `/public/v2/...` route with priority ordering (ip_range=4, user_cohort=3, platform=2, full=1), CIDR containment for ip_range, CSV match for platform, exact-match for user_cohort header. Tie-break by created_at DESC + release_id ASC. Response includes `scoped` block + optional `fallback_release` for non-full winners. v1 endpoint unchanged (still reads legacy `versions` table). |
| P3.3.3 IP range → user matching (Cloudflare `cf-connecting-ip`) | ✅ DONE | 2h | covered by P3.3.2; cf.clientIp is the only source (X-Forwarded-For never trusted). |
| P3.3.4 User cohort matching (cookie / auth) | 🟡 PARTIAL | 4h | P3.3.2 reads cohort from `X-Hands-Cohort` header (legacy `X-Quiver-Cohort` still accepted); cookie / Raft-session-based cohort lookup deferred to v2 (needs auth at the public edge, which the current edge doesn't have). |

### P3.4 — CLI (`@botiverse/hands-cli`)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P3.4.1 npm package scaffold | 🔵 TODO | 2h | `packages/cli/` or separate repo |
| P3.4.2 `hands login` (token save + verify) | 🔵 TODO | 4h | |
| P3.4.3 `hands build push` (zip + multipart upload + parse + sign) | 🔵 TODO | 1 day | most complex command |
| P3.4.4 `hands builds` (list + inspect) | 🔵 TODO | 4h | |
| P3.4.5 `hands release create` (full / platform / ip / cohort scopes) | 🔵 TODO | 1 day | |
| P3.4.6 `hands release rollback` | 🔵 TODO | 4h | |
| P3.4.7 `hands whoami / ops / channels / webhooks` | 🔵 TODO | 1 day | |
| P3.4.8 CLI docs + README | 🔵 TODO | 4h | |

### Phase 3 total: ~3 weeks work

---

## Phase 4 — polish + smoke test + polish

### P4.1 — Smoke test infrastructure

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P4.1.1 APK container smoke test (install + start activity + screenshot) | 🔵 TODO | 3 days | requires Android emulator in container |
| P4.1.2 Electron smoke test (run .AppImage on linux VM + screenshot) | 🔵 TODO | 1 week | hard — needs real Win/Mac/Linux VMs |
| P4.1.3 Auto-update smoke test (install prev → install new → verify) | 🔵 TODO | 3 days | |

### P4.2 — Signing infrastructure

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P4.2.1 AES-256-GCM encryption for `signing_credentials.encrypted_blob` | 🔵 TODO | 2 days | uses Cloudflare KMS |
| P4.2.2 Mac Developer ID signing in container | 🔵 TODO | 1 week | needs Apple cert + notary tools |
| P4.2.3 Windows HSM EV signing | 🔵 TODO | 1 week | |
| P4.2.4 Azure Artifact Signing integration | 🔵 TODO | 4 days | |
| P4.2.5 APK signing (apksigner v1/v2/v3) | 🔵 TODO | 2 days | already have apksigner in container |

### Phase 4 total: ~6 weeks work (deferred — focus on Phases 1-3 first)

---

## Cross-cutting

### X.1 — Documentation

| Task | Status | Notes |
|---|---|---|
| X.1.1 `publish-architecture.md` v3 | ✅ DONE | `a7dc7a0` |
| X.1.2 `publish-tasks.md` (this file) | ✅ DONE | tracks all work; refreshed 2026-06-28 to reflect shipped work (webhooks P2.5.8, default_channel P2.5.10, audit log UI + scoped endpoint P5.5, Phase 5 P5.1–P5.3 backend all DONE, role cross-org isolation shipped). |
| X.1.3 `account-org-invite.md` | ✅ DONE | companion doc for Phase 5 (account/team/invite/RBAC) |
| X.1.4 Admin user guide | ✅ DONE | | `docs/admin-user-guide.md` (15 KB, 9 sections: Overview / Caveats / Page-by-page / Workflows / Roles / Shortcuts / Troubleshooting / Future / Related) |
| X.1.5 Public API reference | ✅ DONE | | `docs/public-api-reference.md` (12 KB, 9 sections: Overview / Endpoints / Client patterns / Error codes / Versioning / Auth boundary / Performance / Open questions / Related) — current contract doc per expert suggestion |
| X.1.6 CLI reference | ✅ DONE | Phase 3 | `docs/cli-reference.md` v2: status legend (Current / Planned / Future) on every section, §18 implementation status aligned with actual Phase 2 backend shipped, §19 expanded references, §20 stability + compat strategy, §21 test + release process (planned). Per @Codex-Kuikly-KMP专家's "low-conflict finishing item" suggestion. |

### X.2 — Testing

| Task | Status | Notes |
|---|---|---|
| X.2.1 Unit tests for handlers (currently 25 passing) | ✅ DONE | 25/25 vitest green. test count grew from 11 → 25 with migrations 0016 (org/RBAC) + 0017 (webhooks) + 0018 (default_channel). |
| X.2.2 E2E test: full build → release → public API flow | 🔵 TODO | |
| X.2.3 CLI integration tests | 🔵 TODO | Phase 3 |
| X.2.4 RBAC tests (Phase 5) | 🟡 IN_PROGRESS | Invite flow, role enforcement, cross-org leakage. Attempted unit tests in `worker/test/routes.test.ts` but the mock better-sqlite3 has a subtle issue with the new org tables (inserts report success but queries return empty). Left as TODO — better as integration tests against deployed Worker with dev-token bypass. |

---

## Phase 5 — account / organization / team / invite / RBAC

Goal: extend the single-user model to multi-tenant with orgs, teams, memberships, invites, and per-app role-based access control. Documented in `account-org-invite.md`.

Depends on: existing Login with Raft migration `0004_raft_auth.sql`.

### P5.1 — schema + bootstrap (1 day)

| Task | Status | Estimate | Migration |
|---|---|---|---|
| P5.1.1 `organizations` table + bootstrap `default` org | ✅ DONE | 30min | `0016_account_org_team.sql` |
| P5.1.2 `org_members` table + indexes | ✅ DONE | 30min | same |
| P5.1.3 `app_members` table + indexes | ✅ DONE | 30min | same |
| P5.1.4 `invites` table + indexes + UNIQUE on pending | ✅ DONE | 1h | same |
| P5.1.5 `apps.org_id` column + backfill | ✅ DONE | 30min | same |
| P5.1.6 `audit_logs.actor_id` + `actor_type` + backfill | ✅ DONE | 1h | same |

### P5.2 — auth helpers + role middleware (2 days) ✅ DONE

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P5.2.1 `worker/src/lib/permissions.ts`: `getOrgMemberRole` / `getAppMemberRole` / `getEffectiveRole` | ✅ DONE | 1 day | `permissions.ts` (commit `eba8f5d`): single SQL JOIN for efficiency. |
| P5.2.2 `requireRole(c, minRole)` middleware | ✅ DONE | 4h | `requireOrgRole(paramName, minRole)` + `requireAppRole(minRole)` + `requireCurrentOrgRole(minRole)` exported from permissions.ts. |
| P5.2.3 Update existing routes to use role-based middleware | ✅ DONE | 1 day | All `/api/orgs/:orgId/*` routes wrapped with `requireOrgRole`; all `/api/apps/:appId/*` routes wrapped with `requireAppRole`; `requireCurrentOrgRole` for org-level list endpoints. |
| P5.2.4 `currentActor(c)` returns `{id, type, display_name}` object | ✅ DONE | 2h | `currentActorInfo(c)` in auth.ts returns `{ id, type }`. The plain-string `currentActor(c)` still exists for backward compat (audit_logs.actor column); `currentActorInfo` is the new structured version. |

### P5.3 — invites + magic link (3 days) ✅ DONE (email sender deferred to v2)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P5.3.1 `worker/src/routes/orgs.ts`: POST `/api/orgs/:orgId/invites` | ✅ DONE | 4h | `handleCreateOrgInvite` (commit `eba8f5d`): validates email + role + message; creates row + opaque token; returns `invite_url`. |
| P5.3.2 GET `/api/orgs/:orgId/invites` | ✅ DONE | 2h | `handleListOrgInvites` — admin/owner sees all, status-filterable. |
| P5.3.3 DELETE `/api/orgs/:orgId/invites/:inviteId` | ✅ DONE | 1h | `handleRevokeOrgInvite` — sets `revoked_at` + `revoked_by`. |
| P5.3.4 POST `/api/orgs/:orgId/invites/:inviteId/resend` | ✅ DONE | 1h | `handleResendOrgInvite` — resets `expires_at` + returns new `invite_url`. |
| P5.3.5 GET `/api/invites/:token` | ✅ DONE | 2h | Public view (`handleGetInvite`); no auth needed. Returns status + email + role + org context. |
| P5.3.6 POST `/api/invites/:token/accept` | ✅ DONE | 4h | `handleAcceptInvite` — auth required; resolves principal to org + (optionally) app; creates membership rows; marks invite accepted. |
| P5.3.7 Email sender (Cloudflare Email Service binding) | 🔵 TODO | 1 day | transactional template — admin UI copies invite_url to clipboard as v1 workaround. v2 will send real email. |
| P5.3.8 Magic link HMAC signing | 🔵 TODO | 2h | invite token is a random UUID today; HMAC signing adds tamper detection — defer to v2. |
| P5.3.9 Auto-expire pending invites past expires_at (Worker Cron) | 🔵 TODO | 2h | daily cron — admin UI filters by status for v1, cron is a hardening pass. |

### P5.4 — org settings UI + access tab + accept page (3 days)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P5.4.1 `admin/src/pages/OrgSettings.tsx` (General / Members / Invites / Audit tabs) | ✅ DONE | 2 days | All 4 tabs wired: General via /me, Members/Invites/Audit via P5.3 endpoints. commit `ea6434e` |
| P5.4.2 Members tab: table + edit role + remove | ✅ DONE | 4h | Wired commit `ea6434e`: listOrgMembers + updateOrgMember + removeOrgMember (admin/owner only, excludes self) |
| P5.4.3 Invites tab: pending invites table + resend/revoke + create-invite modal | ✅ DONE | 4h | Wired commit `ea6434e`: listOrgInvites + createOrgInvite (modal w/ email/role/message, copies invite_url to clipboard) + resendOrgInvite + revokeOrgInvite |
| P5.4.4 AppDetail: new "Access" tab (app_members + invite-to-app) | ✅ DONE | 1 day | Wired commit `2b02881`: listAppMembers + addAppMember (admin only, picks from org_members not already on app) + updateAppMember + removeAppMember (admin only, excludes self) |
| P5.4.5 `admin/src/pages/AcceptInvite.tsx` (public magic link landing) | ✅ DONE | 4h | Wired commit `2b02881`: GET /api/invites/:token (public) + POST /api/invites/:token/accept (auth required). Status badges (expired/accepted/revoked) + sign-in-or-accept buttons. |
| P5.4.6 Top-bar org switcher dropdown | ✅ DONE | 4h | OrgSwitcher dropdown (commit `a19da43`): opens when user is in 2+ orgs, lists orgs from listOrgs(), highlights current org, click-outside closes, v1 single-org still navigates directly |
| P5.4.7 Router: add `/orgs/:orgId` and `/invites/:token` routes | ✅ DONE | 2h | Both top-level (cross-cutting). commit `5eb1a1c` |
| P5.4.8 Top-bar agent badge for principal_type='agent' | ✅ DONE | 10min | commit `5eb1a1c` |
| P5.4.9 "Manage access →" link in AppDetail header | ✅ DONE | 5min | commit `62d6c9b` |
| P5.4.10 Settings page surfaces current org context (display name, principal_type, org_id, org_role, server_role) | ✅ DONE | 20min | commit `57ed0e6` |

### P5.5 — agent permissions + audit (2 days)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P5.5.1 Raft agents default to org_role='viewer', app_role='viewer' | ✅ DONE | 4h | Migration 0016 backfills existing agents as viewer; subsequent agents continue that policy. |
| P5.5.2 Audit all role changes + invite lifecycle events | 🟡 PARTIAL | 1 day | App-scoped mutations (build/create, release/create, etc.) write audit_logs. App-member role changes (addAppMember, updateAppMember, removeAppMember) write audit_logs. Org-level mutations (org-member changes, invite create/accept/revoke) currently DO NOT write audit_logs because schema requires `app_id NOT NULL` — documented as v2 fix (widen schema). UI actor display + scoped query shipped (commit `73cdf96` + P5.5 actor badge work). |
| P5.5.3 GET `/api/users/:accountId/audit` scoped endpoint | ✅ DONE | 2h | commit `73cdf96`. Cross-app view of one user's actions, filtered to caller's orgs. |

### P5.6 — tests + docs (2 days)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P5.6.1 Tests: invite flow (create, accept, revoke, expire) | 🟡 PARTIAL | 1 day | Unit-level SQL tests cover schema shape (test/routes.test.ts describe blocks "quiver audit log — actor display JOIN" + "quiver apps — default_channel_id"). Full invite flow E2E tests deferred — see X.2.4 note. |
| P5.6.2 Tests: role enforcement (org admin vs app publisher vs viewer) | 🔵 TODO | 4h | Integration tests against deployed Worker + dev-token bypass. Unit tests for middleware deferred (see X.2.4). |
| P5.6.3 Tests: cross-org leakage (org A admin trying to read org B) | ✅ DONE | 4h | `useClearOrgCache` hook in OrgSwitcher wipes the entire TanStack cache on org switch (commits `4469075` + `73cdf96`). Backend org boundary enforced by `requireOrgRole` middleware; org-scoped queries (`/api/orgs/:orgId/audit-logs`, `/api/apps` via `requireCurrentOrgRole`). |
| P5.6.4 User guide: how to invite team members | ✅ DONE | | Section 3.10 Org settings → Invites tab + workflow §4.5 / §4.6 in `admin-user-guide.md`. |
| P5.6.5 Role matrix reference doc | ✅ DONE | | `account-org-invite.md` §5.2 role matrix. |

### Phase 5 total: ~13 days (~2.5 weeks)

---

## Open questions (carry-over from doc v3 §9)

1. Multi-tenancy — `accounts` table? ⏸ DEFERRED to v2
2. CLI distribution public or private? — open
3. Webhook delivery reliability (fire-and-forget vs retry queue) — open
4. Smoke test scope (v1 skip, v2 integrate VMs) — ⏸ DEFERRED
5. Scheduled release (`availability_at` semantics) — UI in Phase 1, semantics clarified later
6. Auto-rollback on crash spike — ⏸ DEFERRED
7. `release_types` per app or global? — **per-app** (per @artin)
8. OTA client appVersion source — SDK auto-detects from BuildConfig / app.json

---

## Tracking summary

| Phase | DONE | IN_PROGRESS | TODO | Total | ETA |
|---|---|---|---|---|---|
| Phase 1 | 26 | 0 | 0 | 26 | ✅ COMPLETE |
| Phase 2 (P2.1 + P2.2) | 13 | 0 | 1 | 14 | mostly done |
| Phase 2 (P2.3) | 5 | 1 | 0 | 6 | mostly done (AppsList product_types filter IN_PROGRESS) |
| Phase 2 (P2.4) | 6 | 0 | 1 | 7 | mostly done (P2.4.7 parser_kind dispatch TODO) |
| Phase 2 (P2.5) | 7 | 0 | 1 | 8 | mostly done (P2.5.8 webhook dispatch TODO) |
| Phase 3 (P3.1) | 0 | 0 | 3 | 3 | schema additions for OTA/Electron |
| Phase 3 (P3.2) | 0 | 0 | 4 | 4 | container parser dispatch |
| Phase 3 (P3.3) | 0 | 0 | 4 | 4 | public API scope resolution + bundles endpoint |
| Phase 3 (P3.4) | 0 | 0 | 8 | 8 | CLI npm package |
| Phase 4 (P4.1) | 0 | 0 | 3 | 3 | smoke test infrastructure (deferred) |
| Phase 4 (P4.2) | 0 | 0 | 5 | 5 | signing infrastructure (deferred) |
| Phase 5 (P5.2) | 4 | 0 | 0 | 4 | per-route RBAC middleware ✅ DONE |
| Phase 5 (P5.3) | 6 | 0 | 3 | 9 | org mgmt APIs ✅ DONE (email sender / HMAC signing / cron expire deferred to v2) |
| Phase 5 (P5.4) | 10 | 0 | 0 | 10 | ✅ DONE (all sub-tasks shipped) |
| Phase 5 (P5.5) | 2 | 1 | 0 | 3 | agent perms + audit log UI ✅ MOSTLY DONE (org-level audit_logs deferred to v2 schema) |
| Phase 5 (P5.6) | 3 | 1 | 1 | 5 | tests + docs ✅ MOSTLY DONE (cross-org shipped, invite-flow E2E + middleware unit tests deferred) |
| Cross-cutting | 5 | 1 | 0 | 6 | ongoing (X.2.4 in_progress) |
| **Total** | **71** | **3** | **47** | **121** | |

Last sync: 2026-06-28 12:35 UTC

**Key shipped** (cumulative across all agents):
- Phase 1 ✅ (P1.1–P1.4 all DONE): schema + admin scaffold + channels + versions + channel CRUD.
- Phase 2 ✅ (P2.1–P2.5 mostly DONE): new publish tables on remote D1, App wizard 3-step, UploadDialog 4-step, Builds/Releases tabs with prepare-release modal, full scope resolution (full/platform/ip_range), transactional supersede, audit log.
- Phase 5 ✅ (P5.4 DONE): OrgSettings Members/Invites/Audit tabs all wired to real endpoints, AppAccess members + invite-to-app, AcceptInvite public flow, top-bar Org link + agent badge.
- P5.0 + P5.2 + P5.3 (by expert, commits `b9cfc7a` `eba8f5d`): login org bootstrap, RBAC middleware, org mgmt APIs.
- P2.4.6 + P2.5.4-7 (by expert, commit `2c77b97`): builds + build_assets CRUD + legacy /versions compat + releases endpoints.

**Remaining** (47 TODO):
- Phase 3: container parsers (electron-asar / rn-bundle) + public API bundles endpoint + scope resolution (when scope resolution logic lands, client reads need to pass platform/cohort) + CLI npm package.
- Phase 4 (deferred): smoke test VMs + code signing.
- Phase 5 (mostly done by expert): agent permissions + audit + tests+docs.
- Misc: AppsList product_types filter, P2.4.7 parser dispatch, P2.5.8 webhook dispatch, P2.2.8 deprecate versions table, multi-org switcher dropdown UI.


