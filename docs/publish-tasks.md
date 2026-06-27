# Quiver Publish Architecture — Implementation Spec & Tasks

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

### P1.4 — Admin UI: remaining Phase 1 fields 🟡 IN_PROGRESS

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P1.4.1 UploadDialog step 3: `should_force_update` checkbox | 🔵 TODO | 15min | per-version flag, stored in `versions.should_force_update` (additive column) |
| P1.4.2 UploadDialog step 3: `availability_at` datetime picker | 🔵 TODO | 30min | nullable, scheduled publish |
| P1.4.3 UploadDialog step 3: `provenance_json` auto-fill + editable | 🔵 TODO | 1h | git_commit / ci_url / branch / source — auto from build env if available |
| P1.4.4 Migrations: `versions.should_force_update`, `versions.availability_at`, `versions.provenance_json` | 🔵 TODO | 30min | `0007_versions_publish_fields.sql` |
| P1.4.5 Publishing dashboard: show changelog column | 🔵 TODO | 30min | `admin/src/pages/Publishing.tsx` |
| P1.4.6 Publishing dashboard: `enabled` toggle button | 🔵 TODO | 30min | wire to `PATCH /api/apps/:appId/versions/:vid` |
| P1.4.7 Publishing dashboard: `Force update` toggle | 🔵 TODO | 30min | wire to `should_force_update` field |
| P1.4.8 Channel CRUD UI: edit password / bundle_id / git_url | 🔵 TODO | 2h | new page or inline edit in AppDetail channels tab |

### Phase 1 total: ~6-7 hours work remaining

---

## Phase 2 — multi-platform + build/release split

Goal: introduce `product_types`, `release_types`, `build_assets`, `releases`, `release_scopes`. Backfill from existing `versions`. App creation wizard (3-step).

### P2.1 — Database schema: new tables

| Task | Status | Estimate | Migration |
|---|---|---|---|
| P2.1.1 `product_types` table + indexes | 🔵 TODO | 30min | `0008_product_types.sql` |
| P2.1.2 `release_types` table + seed defaults | 🔵 TODO | 30min | `0008_product_types.sql` |
| P2.1.3 `build_assets` table | 🔵 TODO | 30min | `0009_build_assets.sql` |
| P2.1.4 `releases` table + indexes | 🔵 TODO | 30min | `0010_releases.sql` |
| P2.1.5 `release_scopes` table + indexes | 🔵 TODO | 30min | `0010_releases.sql` |

### P2.2 — Backfill from existing `versions`

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.2.1 Seed default `product_types` (android-apk, electron-installer, rn-bundle, etc.) per existing app | 🔵 TODO | 1h | on migration apply |
| P2.2.2 Seed default `release_types` (stable/rc/beta/internal) per existing app | 🔵 TODO | 30min | |
| P2.2.3 Seed default channels (production/beta/internal) per existing app | 🔵 TODO | 1h | with bundle_id defaults |
| P2.2.4 Backfill each `versions` row → `builds` + `build_assets` | 🔵 TODO | 1h | platform='android', filetype='apk' |
| P2.2.5 Backfill each `versions` row → `releases` + `release_scopes` (full) | 🔵 TODO | 1h | status='active', is_full=1 |
| P2.2.6 Deprecate `versions` table (rename to `_versions_legacy`) | 🔵 TODO | 30min | Phase 2 final migration |

### P2.3 — App creation wizard (3 steps)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.3.1 Wizard shell component (multi-step modal with stepper) | 🔵 TODO | 3h | shared component for any multi-step wizard |
| P2.3.2 Step 1: Basics (name / slug / description) | 🔵 TODO | 30min | port existing CreateAppDialog |
| P2.3.3 Step 2: Product types checklist + per-product supported_platforms sub-picker | 🔵 TODO | 2h | Sentry-style wizard inspiration |
| P2.3.4 Step 3: Release types review (seeded defaults, add/remove) | 🔵 TODO | 1h | |
| P2.3.5 Wizard save: insert app + product_types + release_types + channels in transaction | 🔵 TODO | 1h | |
| P2.3.6 AppsList update: filter by default product_types | 🔵 TODO | 30min | |

### P2.4 — UploadDialog 5-step wizard (channel-first)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.4.1 Step 1: Channel + product_type + release_type dropdowns + context preview | 🔵 TODO | 2h | current UploadDialog hardcoded to APK |
| P2.4.2 Step 2: Version name + code (auto-suggested) | 🔵 TODO | 30min | |
| P2.4.3 Step 3: Files per-platform matrix (Electron: N file pickers; APK: 1; bundle: 1) | 🔵 TODO | 4h | most complex piece |
| P2.4.4 Step 4: Release details (changelog / should_force_update / availability / provenance) | 🔵 TODO | 2h | |
| P2.4.5 Step 5: Review + push | 🔵 TODO | 1h | wire to /api/builds + /api/builds/:id/assets |
| P2.4.6 Backend: `POST /api/builds` (insert builds + build_assets) | 🔵 TODO | 3h | replaces /api/parse-apk + /api/apps/:id/upload |
| P2.4.7 Backend: parse container with parser_kind dispatch (apk-aapt / electron-asar / rn-bundle) | 🔵 TODO | 4h | container currently only knows apk-aapt |

### P2.5 — Builds tab + Releases tab + Prepare release modal

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P2.5.1 Builds tab (table view, status badge, Prepare release button) | 🔵 TODO | 3h | |
| P2.5.2 Releases tab (table view, scope column, status, actions) | 🔵 TODO | 3h | |
| P2.5.3 Prepare release modal (validation checks + scope radio + cohort slider) | 🔵 TODO | 3h | ToDesktop's validation checks inspiration |
| P2.5.4 Backend: `POST /api/releases` (promote build → release with scope) | 🔵 TODO | 3h | with scope resolution logic |
| P2.5.5 Backend: `POST /api/releases/:id/rollback` | 🔵 TODO | 2h | creates new release pointing to older build |
| P2.5.6 Backend: `POST /api/releases/:id/bump-rollout` | 🔵 TODO | 1h | increments `rollout_cohort_count` |
| P2.5.7 Backend: `POST /api/releases/:id/force-update` toggle | 🔵 TODO | 1h | flips `should_force_update` |
| P2.5.8 Backend: webhook dispatch on release lifecycle events | 🔵 TODO | 3h | webhooks table + delivery worker |

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
| P3.3.2 Scope resolution logic on `/public/.../latest` (full / platform / ip_range / cohort) | 🔵 TODO | 4h | |
| P3.3.3 IP range → user matching (Cloudflare `cf-connecting-ip`) | 🔵 TODO | 2h | |
| P3.3.4 User cohort matching (cookie / auth) | 🔵 TODO | 4h | needs auth |

### P3.4 — CLI (`@oranix/quiver-cli`)

| Task | Status | Estimate | Notes |
|---|---|---|---|
| P3.4.1 npm package scaffold | 🔵 TODO | 2h | `packages/cli/` or separate repo |
| P3.4.2 `quiver login` (token save + verify) | 🔵 TODO | 4h | |
| P3.4.3 `quiver build push` (zip + multipart upload + parse + sign) | 🔵 TODO | 1 day | most complex command |
| P3.4.4 `quiver builds` (list + inspect) | 🔵 TODO | 4h | |
| P3.4.5 `quiver release create` (full / platform / ip / cohort scopes) | 🔵 TODO | 1 day | |
| P3.4.6 `quiver release rollback` | 🔵 TODO | 4h | |
| P3.4.7 `quiver whoami / ops / channels / webhooks` | 🔵 TODO | 1 day | |
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
| X.1.2 `publish-tasks.md` (this file) | 🟡 IN_PROGRESS | tracks all work |
| X.1.3 Admin user guide | 🔵 TODO | |
| X.1.4 Public API reference | 🔵 TODO | |
| X.1.5 CLI reference | 🔵 TODO | Phase 3 |

### X.2 — Testing

| Task | Status | Notes |
|---|---|---|
| X.2.1 Unit tests for handlers (currently 11 passing) | 🟡 IN_PROGRESS | need to grow as schema grows |
| X.2.2 E2E test: full build → release → public API flow | 🔵 TODO | |
| X.2.3 CLI integration tests | 🔵 TODO | Phase 3 |

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
| Phase 1 | 16 | 1 (this doc) | 8 | 25 | ~7 hours remaining |
| Phase 2 | 0 | 0 | 25 | 25 | ~50 hours |
| Phase 3 | 0 | 0 | 14 | 14 | ~3 weeks |
| Phase 4 | 0 | 0 | 7 | 7 | ~6 weeks |
| Cross-cutting | 1 | 1 | 4 | 6 | ongoing |
| **Total** | **17** | **2** | **58** | **77** | |

Last sync: 2026-06-28 01:50 UTC