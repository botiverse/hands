# Hands Publish Architecture — Android (now) + Electron / OTA (later)

> **Status: historical design document (frozen).** Written during the
> 2026-06 build-out; several sections describe plans that shipped
> differently. For current behavior see `docs/public/` (served at
> `/docs`), `docs/release-runbook.md`, and the code. Kept for design
> rationale and history. (Banner added 2026-07-04.)

Status: **draft v3, after @artin's decisions on 4 design questions** (task #5, @Pi-Worker2)
Author: @Pi-Worker2, 2026-06-28
Scope: long-lived schema + admin UX + CLI for builds / releases / channels / product_types.

---

## 1. Decisions in v3

@artin reviewed v2 and answered 4 design questions. Decisions:

| Question | Answer |
|---|---|
| Build / Release 拆不拆？ | **拆** |
| Scope release (full / platform / IP) 要不要做？ | **要做** |
| Sub-app inheritance vs channels？ | **同一个东西** —— channels 承载继承语义 |
| CLI 要不要做？ | **要** |

v3 builds on these decisions. Re-read all of ToDesktop's docs (building / signing / releasing / cli / runtime / development-staging / migrate-electron-builder / debian-apt / webhooks / mac-app-store / api) to inform this.

## 2. Goals

Hands ships and updates software for multiple product types:

| Product type | Update mechanism | Sample format |
|---|---|---|
| `android-apk` | Full APK download | `app-release.apk` |
| `android-aab` | Play Store dynamic delivery | `app-release.aab` |
| `ios-ipa` | TestFlight / direct install | `MyApp.ipa` |
| `electron-installer` | Squirrel auto-update via platform binary | `MyApp-1.2.3-arm64.dmg` |
| `rn-bundle` | JS bundle hot-reload (hot-updater) | `bundle.zip` |
| `cli-binary` | Self-update binary | `mycli-1.2.3-linux-x64.tar.gz` |

User-defined per app: each app picks which product_types it supports at creation time (Sentry-style wizard).

## 3. Core model — 7 tables

### 3.1 Entity-relationship overview

```
accounts                    -- (or orgs/hands — multi-tenancy; see §6)
└── signing_credentials     -- Mac/Windows certs (account-level, inherited)

apps
├── product_types           -- user-defined: what we ship
├── release_types           -- user-defined: stable/rc/beta/nightly/...
└── channels                -- deployment lane (production, beta, dev) — carries inheritance semantics
    └── builds              -- immutable compile/upload artifact
        └── build_assets    -- per-(platform, arch, variant, filetype) binaries
        └── releases        -- promote build to "live" with scope (full/platform/IP)
            └── release_scopes -- individual scope records (each platform / IP range)
```

A **Channel** in Hands = ToDesktop's "main app + sub-apps + channels" combined. Each channel is a deployment environment that carries:
- App identity (inherited from app)
- Bundle ID override (per channel, e.g. `com.example.myapp.dev` for dev channel)
- Code signing credentials (inherited from account)
- Build artifacts configuration (which product_types × platforms are enabled)
- Optional password gate

Channels inherit from the app's signing credentials (account-level), so you don't re-upload certificates per channel.

### 3.2 `apps` — top-level product

```
apps
  id              TEXT PRIMARY KEY
  slug            TEXT NOT NULL UNIQUE
  name            TEXT NOT NULL
  description     TEXT
  archived        INTEGER NOT NULL DEFAULT 0
  archived_at     INTEGER
  created_at      INTEGER NOT NULL
  updated_at      INTEGER NOT NULL
```

### 3.3 `product_types` — what we ship

User-defined per app. Created during app creation wizard or added later.

```
product_types
  id                          TEXT PRIMARY KEY
  app_id                      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  name                        TEXT NOT NULL         -- 'android-apk' | 'electron-installer' | 'rn-bundle' | ...
  display_name                TEXT NOT NULL
  description                 TEXT
  parser_kind                 TEXT NOT NULL         -- 'apk-aapt' | 'electron-asar' | 'rn-bundle' | 'ipa-info' | 'unknown'
  supported_platforms_json    TEXT NOT NULL DEFAULT '[]'  -- empty for apks; e.g. ["darwin-arm64","darwin-x64",...] for electron
  default_assets_json         TEXT NOT NULL DEFAULT '[]'  -- e.g. [{"platform":"darwin-arm64","filetype":"dmg"},...]
  schema_json                 TEXT NOT NULL DEFAULT '{}'  -- parser hints: requires_native_codes, requires_electron_version, etc.
  parent_product_type_id     TEXT REFERENCES product_types(id) ON DELETE SET NULL  -- for hierarchical types (apt-repository ⊂ electron-installer)
  created_at                  INTEGER NOT NULL
  UNIQUE (app_id, name)
```

**Defaults seeded at app creation**:
- `android-apk` (parser: apk-aapt)
- `android-aab` (parser: aapt)
- `ios-ipa` (parser: ipa-info)
- `electron-installer` (parser: electron-asar)
- `rn-bundle` (parser: rn-bundle)
- `cli-binary` (parser: unknown)

User can add custom product_types (e.g. `firmware-esp32`, `vscode-extension`, `docker-image`, ...) or hide the defaults they don't need.

### 3.4 `release_types` — release treatment labels

User-defined per app. Seeded with sensible defaults.

```
release_types
  id              TEXT PRIMARY KEY
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  name            TEXT NOT NULL         -- 'stable' | 'beta' | 'rc' | 'internal' | 'nightly' | ...
  display_name    TEXT NOT NULL
  color           TEXT                  -- hex color for UI badges
  description     TEXT
  created_at      INTEGER NOT NULL
  UNIQUE (app_id, name)
```

**Default release_types** (seeded at app creation, user can edit/remove):
- `stable` (#10b981 green) — Production-ready
- `rc` (#3b82f6 blue) — Release candidate
- `beta` (#f59e0b orange) — Public beta
- `internal` (#6b7280 gray) — Internal team only

### 3.5 `channels` — deployment lane + inheritance

```
channels
  id                  TEXT PRIMARY KEY
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  slug                TEXT NOT NULL         -- 'production' | 'beta' | 'dev' | 'nightly' | ...
  name                TEXT NOT NULL
  bundle_id           TEXT                  -- e.g. 'com.example.myapp' (prod) vs 'com.example.myapp.beta'
  password            TEXT                  -- optional gate on download
  git_url             TEXT                  -- source URL this channel tracks
  enabled_product_types_json TEXT NOT NULL DEFAULT '[]'  -- which product_types this channel serves (subset of app's)
  inherits_signing_from_account INTEGER NOT NULL DEFAULT 1  -- 0 = use channel-specific override
  metadata_json       TEXT NOT NULL DEFAULT '{}'
  created_at          INTEGER NOT NULL
  updated_at          INTEGER NOT NULL
  UNIQUE (app_id, slug)
```

**Default channels seeded** at app creation:
- `production` (bundle_id = `<default>`, password = none)
- `beta` (bundle_id = `<default>.beta`, password = optional)
- `internal` (bundle_id = `<default>.internal`, password = required)

Channel = "deployment environment". A channel:
- Can have its own bundle_id (for parallel install against production)
- Can have its own password (gated downloads)
- Inherits signing credentials from account (no per-channel cert upload)
- Lists which product_types are enabled (e.g. beta channel might enable `android-apk` + `rn-bundle` but not `electron-installer`)

### 3.6 `signing_credentials` — code signing certs (account-level)

```
signing_credentials
  id              TEXT PRIMARY KEY
  -- owner is the account (top-level), not per-app or per-channel
  owner_type      TEXT NOT NULL DEFAULT 'account'   -- 'account' (future: 'org', 'team')
  owner_id        TEXT                              -- account ID (or org ID)
  platform        TEXT NOT NULL                     -- 'macos' | 'windows' | 'android' | ...
  kind            TEXT NOT NULL                     -- 'developer-id-app' | 'developer-id-installer' | 'mas-dev' | 'mas-dist' | 'mas-installer' | 'hsm-ev' | 'azure-artifact-signing' | 'apk-v1-v2-v3' | ...
  label           TEXT NOT NULL                     -- user-friendly name
  encrypted_blob  BLOB NOT NULL                     -- encrypted .p12 file (AES-256-GCM with KMS-derived key)
  metadata_json   TEXT NOT NULL DEFAULT '{}'        -- issuer_id, key_id, azure_tenant_id, azure_client_id, etc.
  expires_at      INTEGER
  created_at      INTEGER NOT NULL
  INDEX (owner_type, owner_id, platform)
```

Inherited by all apps + channels. Used during build step for code signing.

### 3.7 `builds` — immutable compile/upload artifact

**Decoupled from release**. A build is uploaded first, validated, optionally smoke-tested, then promoted to a release.

```
builds
  id                      TEXT PRIMARY KEY
  app_id                  TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  channel_id              TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE
  product_type            TEXT NOT NULL                     -- FK to product_types(app_id, name) composite
  release_type            TEXT NOT NULL                     -- FK to release_types(app_id, name) composite
  version_name            TEXT NOT NULL                     -- e.g. "1.2.3"
  version_code            INTEGER NOT NULL                 -- monotonic per (app, product_type, channel, release_type)
  changelog               TEXT                              -- markdown
  source                  TEXT NOT NULL                     -- 'cli' | 'web' | 'ci'
  status                  TEXT NOT NULL                     -- 'pending' | 'building' | 'succeeded' | 'failed' | 'smoke_testing' | 'smoke_test_passed' | 'smoke_test_failed'
  build_metadata_json     TEXT NOT NULL DEFAULT '{}'        -- build-time: ci_url, git_commit, build_duration_ms, builder_host, ...
  parsed_metadata_json    TEXT NOT NULL DEFAULT '{}'        -- from parser: package_name, signature_sha256, min_sdk, native_codes, ...
  created_at              INTEGER NOT NULL
  updated_at              INTEGER NOT NULL
  completed_at            INTEGER
  UNIQUE (app_id, product_type, channel_id, release_type, version_code)
  INDEX (app_id, channel_id, product_type, status, created_at DESC)
  INDEX (status, created_at DESC)
```

**Why split from releases**: same build can be re-released multiple times with different scopes (full / platform-only / IP-only). Build stays immutable forever; release is mutable.

### 3.8 `build_assets` — per-(platform, arch, variant, filetype) binaries

A build has N assets, one per supported (platform, arch, variant, filetype) combination.

```
build_assets
  id                  TEXT PRIMARY KEY
  build_id            TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE
  platform            TEXT NOT NULL    -- 'android' | 'darwin' | 'win32' | 'linux' | 'ios' | ...
  arch                TEXT             -- 'arm64' | 'x64' | 'x86' | 'universal' | NULL (for android)
  variant             TEXT             -- 'user' (no-admin installer) | 'mas' (Mac App Store) | 'pkg' | NULL
  filetype            TEXT NOT NULL    -- 'apk' | 'aab' | 'exe' | 'msi' | 'dmg' | 'pkg' | 'deb' | 'rpm' | 'appimage' | 'zip' | 'tar.gz' | 'bundle' (rn) | ...
  r2_key              TEXT NOT NULL
  file_hash           TEXT NOT NULL    -- sha256
  size_bytes          INTEGER NOT NULL
  signature           TEXT             -- platform-specific: apk-signer hex, codesign hash, etc.
  signing_credential_id TEXT REFERENCES signing_credentials(id)  -- which cert was used (nullable if unsigned)
  metadata_json       TEXT NOT NULL DEFAULT '{}'  -- product-type-specific
  download_count      INTEGER NOT NULL DEFAULT 0
  created_at          INTEGER NOT NULL
  UNIQUE (build_id, platform, arch, variant, filetype)
  INDEX (build_id)
```

**4-dimensional asset matrix** (per ToDesktop):
- `platform` ∈ {android, darwin, win32, linux, ios}
- `arch` ∈ {arm64, x64, x86, universal, NULL}
- `variant` ∈ {user, mas, pkg, NULL}
- `filetype` ∈ {apk, aab, ipa, exe, msi, dmg, pkg, deb, rpm, appimage, zip, tar.gz, bundle, ...}

Example Electron 1.2.3 build assets:
```
darwin-arm64-NULL-dmg
darwin-x64-NULL-dmg
darwin-arm64-mas-pkg
darwin-universal-NULL-dmg
linux-x64-NULL-deb
linux-x64-NULL-rpm
linux-x64-NULL-appimage
linux-arm64-NULL-deb
win32-x64-NULL-exe
win32-x64-user-exe
win32-arm64-NULL-msi
```

### 3.9 `releases` — promote build to "live" with scope

A release is **a build that's been promoted**. It can have multiple scope records (full + partial overrides).

```
releases
  id                      TEXT PRIMARY KEY
  app_id                  TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  build_id                TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE
  channel_id              TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE
  product_type            TEXT NOT NULL         -- denormalized from build for query speed
  release_type            TEXT NOT NULL         -- denormalized from build
  status                  TEXT NOT NULL         -- 'draft' | 'active' | 'superseded' | 'cancelled'
  is_full                 INTEGER NOT NULL     -- 1 if this release covers all users; 0 if scoped
  superseded_by_release_id TEXT REFERENCES releases(id)
  rollout_cohort_count    INTEGER              -- null = 100%, otherwise staged %
  rollout_target_cohorts_json TEXT NOT NULL DEFAULT '[]'
  availability_at         INTEGER              -- scheduled publish
  should_force_update     INTEGER NOT NULL DEFAULT 0
  changelog               TEXT                 -- denormalized from build
  provenance_json         TEXT NOT NULL DEFAULT '{}'
  created_by              TEXT NOT NULL         -- 'admin@...'
  created_at              INTEGER NOT NULL
  INDEX (app_id, channel_id, product_type, release_type, status, created_at DESC)
  INDEX (build_id)
  INDEX (status, created_at DESC)
```

A release goes through status:
- `draft` — editable release metadata and scopes; not returned by public update checks and does not supersede active releases.
- `active` — currently live for this (channel, product_type, release_type).
- `superseded` — newer release was published on the same lane.
- `cancelled` — soft-deleted / cancelled release; build rows and assets remain in storage.

### 3.10 `release_scopes` — partial release overrides

A release can be partial (only some users get it). Each scope record defines one slice.

```
release_scopes
  id              TEXT PRIMARY KEY
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE
  scope_type      TEXT NOT NULL         -- 'full' | 'platform' | 'ip_range' | 'user_cohort'
  scope_value     TEXT NOT NULL         -- 'all' | 'darwin,linux' (CSV for platform) | '10.0.0.0/8' (CIDR) | 'cohort-uuid' (cohort ID)
  created_at      INTEGER NOT NULL
  INDEX (release_id)
```

**Examples**:
- Full release: `scope_type='full', scope_value='all'`
- Mac-only release: `scope_type='platform', scope_value='darwin-arm64,darwin-x64,darwin-universal'`
- IP-scoped release: `scope_type='ip_range', scope_value='10.0.0.0/8'` (corp VPN)
- Cohort release: `scope_type='user_cohort', scope_value='beta-testers'`

A release can have **multiple scope records** (e.g. full + a single IP override for one power user). When user requests an update, server picks the most specific scope that matches them.

**Resolution priority**: ip_range > user_cohort > platform > full. If no scope matches → user gets the most recent active release for their (channel, product_type, release_type).

## 4. Operations lifecycle

### 4.1 Build flow (CLI or Web)

```
1. User uploads build artifact(s) via CLI or Web
   CLI: hands build push ./release.zip --channel production --product-type electron-installer --release-type stable --version 1.2.3 --changelog ./CHANGELOG.md
   Web: UploadDialog 5-step wizard

2. Server:
   a. Validate auth + permissions
   b. Insert builds row (status='pending')
   c. Insert build_assets rows (one per uploaded file)
   d. Update status='building'
   e. Container parses each asset (aapt for apk, asar extract for electron, etc.)
   f. Validate version_code monotonicity
   g. Code-sign each asset using inherited signing_credentials
   h. Upload to R2
   i. Update status='succeeded' (or 'failed' with error)
   j. Emit SSE event to admin UI (toast notification)

3. Admin sees build in dashboard with status badge:
   [Pending] → [Building...] → [✓ Ready] / [✗ Failed]
```

### 4.2 Smoke test (optional, before release)

ToDesktop runs builds on actual Win/Mac/Linux VMs, captures screenshots + auto-update tests. Hands v1 will skip this; v2 can integrate with container-based macOS VMs (complex) or just CI-based smoke tests.

### 4.3 Release flow (promote build to live)

```
1. Admin opens build → "Prepare release" button
2. Modal shows validation checks:
   - Build status is 'succeeded' ✓
   - Version is higher/lower than previous release ✓
   - Signing credentials valid ✓
   - No active release with same version_code ✓

3. Admin picks release scope (radio buttons):
   - [Full release] — all users on this (channel, product_type, release_type)
   - [Platform release] — checkboxes: darwin-arm64, darwin-x64, ..., win32-x64
   - [IP range release] — text input CIDR list

4. Optional: rollout_cohort_count slider (0-100)
   Optional: availability_at datetime (schedule for later)
   Optional: should_force_update checkbox

5. Click "Save draft" or "Publish now"
6. Server:
   a. Insert releases row (status='draft')
   b. Insert release_scopes row(s)
   c. If publishing now, set the release to `active`
   d. If publishing now, mark previous release(s) on same (channel, product_type, release_type) as 'superseded' (link via superseded_by_release_id)
   e. If publishing now, emit SSE event "release:new"
   f. If publishing now, fire webhook (if configured)
```

### 4.4 Rollback

Admin picks any historical release on the same (channel, product_type, release_type) → "Roll back to this version" → inserts new release with `status='active'` pointing to the older build, marks current as `superseded`.

## 5. Public client API

### 5.1 Full binary latest (Android APK, iOS IPA, Electron installer)

```
GET /public/apps/:slug/latest?channel=production&product_type=android-apk
→ 200 {
    "build": {
      "version": "1.2.3",
      "version_code": 42,
      "release_type": "stable",
      "changelog": "...",
      "released_at": 1782560000000
    },
    "assets": [
      { "platform": "android", "arch": null, "variant": null, "filetype": "apk",
        "download_url": "/api/r2/...", "size_bytes": 23217680, "signature": "..." }
    ]
  }
```

Server resolves:
1. Find active release on (channel, product_type) for the user's release_type (or all if not specified)
2. Pick the most specific scope that matches this request (ip_range > user_cohort > platform > full)
3. Return matching release + assets

For Electron with scope=full:
```json
{
  "build": { "version": "1.2.3", ... },
  "assets": [
    { "platform": "darwin", "arch": "arm64", "filetype": "dmg", "download_url": "...", "size_bytes": 89123456 },
    { "platform": "darwin", "arch": "x64",   "filetype": "dmg", "download_url": "...", "size_bytes": 90123456 },
    { "platform": "linux",  "arch": "x64",   "filetype": "deb", "download_url": "...", "size_bytes": 76543210 },
    { "platform": "win32",  "arch": "x64",   "filetype": "exe", "download_url": "...", "size_bytes": 82345678 }
  ]
}
```

For Electron with scope=platform(darwin-only):
```json
{
  "build": { "version": "1.2.3", "scoped": "darwin-only", ... },
  "assets": [
    { "platform": "darwin", "arch": "arm64", "filetype": "dmg", "download_url": "...", "size_bytes": 89123456 },
    { "platform": "darwin", "arch": "x64",   "filetype": "dmg", "download_url": "...", "size_bytes": 90123456 }
  ],
  "fallback_release": {  // optional: if darwin user came from win32, show this so they don't auto-update to an older version
    "version": "1.2.2", "platform": "win32", ...
  }
}
```

### 5.2 OTA bundles (rn-bundle)

```
GET /public/apps/:slug/bundles?channel=production&product_type=rn-bundle&app_version=1.2.3
→ 200 [{
    "version": "1.2.4-bundle.1",
    "target_app_version": ">=1.2.0 <2.0.0",
    "file_hash": "sha256:...",
    "should_force_update": false,
    "download_url": "..."
  }, ...]
```

Returns **all** enabled bundles matching the client's `app_version` semver range. Client picks the newest.

### 5.3 Channels list

```
GET /public/apps/:slug/channels
→ 200 { "channels": [
    { "slug": "production", "name": "Production", "product_types": ["android-apk", "electron-installer"] },
    { "slug": "beta", "name": "Beta", "product_types": ["android-apk", "rn-bundle"], "password_required": false }
  ] }
```

### 5.4 Scope resolution — the v2 public API contract

**Status (v1):** scope resolution is **not yet wired into the public API**. The current `GET /public/apps/:slug/latest` reads from the legacy `versions` table (no scope filtering). The `releases` + `release_scopes` tables exist and the admin CRUD is in place, but the public lookup still picks the highest `version_code` for the channel. This section documents the v2 contract that P3.3 will implement.

**Why a separate spec:** scope resolution is the load-bearing piece that lets us ship staged rollouts, beta cohorts, IP-restricted releases, and platform-specific fallbacks without breaking clients. The schema is ready (`release_scopes.scope_type` / `scope_value`); the spec below locks down the SQL ordering, request-shape, and response shape so P3.3 can drop it in without an API redesign.

**Scope types** (`release_scopes.scope_type`):

| scope_type | scope_value format | Match rule |
|------------|-------------------|------------|
| `full`     | `all`             | always matches |
| `platform` | CSV of platform-arch tuples, e.g. `darwin-arm64,darwin-x64,darwin-universal,win32-x64` | matches if client's `User-Agent` (Electron) or `Build.MANUFACTURER+MODEL` / `Build.SUPPORTED_ABIS` (Android) matches any value |
| `ip_range` | CIDR, e.g. `10.0.0.0/8`, `203.0.113.0/24` | matches if client IP (Worker `request.cf?.clientIp`) is in the CIDR |
| `user_cohort` | cohort UUID, e.g. `a1b2c3d4-...` | matches if client sends `X-Hands-Cohort: <uuid>` header (legacy `X-Quiver-Cohort` still accepted) AND that cohort is in the release's scopes |

**Resolution priority** (highest specificity first):

```
1. ip_range      -- explicit corporate / VPN / beta-tester networks
2. user_cohort   -- opt-in power-user cohort (header-driven)
3. platform      -- only-this-OS releases (Mac-only, Windows-only)
4. full          -- catch-all for everyone
```

The server picks the **most specific matching scope**. If two releases match at the same priority level, the one with the highest `created_at` wins. If no scope matches → fall back to the most recent active `full` release on `(channel, product_type)`; if there is none → 404.

**Request shape** (additive; v1 clients ignore new params, v2 server uses them):

```
GET /public/v2/apps/:slug/latest
  ?channel=production
  &product_type=android-apk
  &client_platform=android-arm64-v8a
  &client_version=1.2.3
  &cohort=a1b2c3d4-...     # optional, sent only if app passed it explicitly

Headers (v2 client; legacy X-Quiver-* still accepted):
  X-Hands-Client-Platform: android-arm64-v8a    # required for platform-scoped releases
  X-Hands-Cohort: a1b2c3d4-...                   # optional, for cohort-scoped releases

Server-side (always available):
  request.cf?.clientIp   # for ip_range scope matching
```

**Resolution algorithm** (SQL pseudocode):

```sql
-- Step 1: collect candidate releases on (channel, product_type) in the last 30 days
WITH candidates AS (
  SELECT r.id, r.build_id, r.channel_id, r.product_type, r.release_type,
         r.should_force_update, r.created_at
  FROM releases r
  WHERE r.app_id  = $app_id
    AND r.channel_id = $channel_id
    AND r.product_type = $product_type
    AND r.status = 'active'
    AND r.created_at > $now - 30*24*3600*1000
),
scopes AS (
  SELECT release_id, scope_type, scope_value
  FROM release_scopes
  WHERE release_id IN (SELECT id FROM candidates)
),
matches AS (
  SELECT c.id, c.created_at,
    -- priority: ip_range=4, user_cohort=3, platform=2, full=1
    MAX(CASE s.scope_type
          WHEN 'ip_range'    THEN 4
          WHEN 'user_cohort' THEN 3
          WHEN 'platform'    THEN 2
          WHEN 'full'        THEN 1
        END) AS priority
  FROM candidates c
  JOIN scopes s ON s.release_id = c.id
  WHERE
    (s.scope_type = 'full')
    OR (s.scope_type = 'platform'    AND $client_platform = ANY(string_split(s.scope_value, ',')))
    OR (s.scope_type = 'ip_range'    AND $client_ip << s.scope_value)            -- CIDR contains
    OR (s.scope_type = 'user_cohort' AND $cohort = s.scope_value)
  GROUP BY c.id
)
SELECT c.*
FROM matches c
ORDER BY c.priority DESC, c.created_at DESC
LIMIT 1;
```

**Response shape** (v2):

```json
{
  "build": {
    "version": "1.2.3",
    "version_code": 42,
    "release_type": "stable",
    "changelog": "...",
    "released_at": 1782560000000
  },
  "assets": [
    { "platform": "android", "arch": "arm64-v8a", "filetype": "apk",
      "download_url": "/api/r2/...", "size_bytes": 23217680, "signature": "..." }
  ],
  "scoped": {                                  // NEW in v2
    "scope_type": "platform",                   // which scope won
    "scope_value": "android-arm64-v8a,android-armeabi-v7a",
    "release_id": "..."
  },
  "fallback_release": {                        // NEW in v2; only present if a less-specific
    "build": { "version": "1.2.2", ... },       //   release also matches this client and
    "assets": [...]                             //   they came from the older one
  }
}
```

**`fallback_release`** lets the client warn the user ("You were on 1.2.2 from Windows; the Mac team is now on 1.2.3 — would you like to switch?") without forcing a downgrade. Skipped entirely when the matched release is already a `full` scope.

**Edge cases the contract locks in:**

1. **Empty `cohort` header + cohort-scoped release**: no match (server treats `cohort IS NULL` as mismatch, never as `''`).
2. **Multiple matches at the same priority**: `created_at DESC` wins. Ties broken by `release_id` (UUID lex order) for determinism.
3. **`full` is the only match**: `priority=1`; behaves like v1 (any active release on the channel).
4. **No release matches**: 404 with body `{"error": "no active release for this client"}`. v1 clients that ignored scope will see this and should fall back to their bundled copy.
5. **Release cancelled (`status='cancelled'`)** mid-request: never returned. Server filters by `status='active'` in Step 1.
6. **Rollback creates a new release**: original release moves to `superseded`; new release inherits the original's scopes (unless `POST /api/apps/:appId/releases/:id/rollback` overrides). Server returns the new one.
7. **`ip_range` matching** is server-trusted: we use `cf.clientIp` only, never the client `X-Forwarded-For`. v2 client must NOT send `X-Forwarded-For`; server strips it if present.
8. **Cross-product-type scope**: scopes are per-release, but releases are per-`product_type`. A `platform` scope on an Android release cannot accidentally match an Electron client because the platform strings are disjoint.

**Backward compatibility:** v2 endpoint is additive (`/public/v2/...`); v1 endpoint stays operational and returns its current shape. Clients migrate by changing base URL.

**Implementation owner:** P3.3 (public API scope resolution). The SQL above is the contract; the Hono handler is mechanical (params → bind → query → respond). Tests in `worker/test/routes.test.ts` under a new `describe("scope resolution — v2 public API")` block.

## 6. CLI — `hands-cli`

Public npm package. The current alpha covers Hands login, app/build inspection,
and Android release publishing; planned commands continue to mirror the
`todesktop` CLI shape.

### 6.1 Install

```
npm install --save-dev @botiverse/hands-cli
# or global
npm install -g @botiverse/hands-cli
# or one-off
npm exec --package @botiverse/hands-cli@0.1.0 -- hands --help
```

### 6.2 Auth

```
hands login                         # browser-assisted login, saved to ~/.config/quiver/auth.json
QUIVER_AUTH_TOKEN=... hands whoami  # CI / agent mode: bearer token env var
```

### 6.3 Commands

```
# Build & push (upload-only mode — no code-sign or smoke test)
hands build push ./release.zip \
  --app myapp-android \
  --channel production \
  --product-type electron-installer \
  --release-type stable \
  --version-name 1.2.3 \
  --version-code 42 \
  --changelog ./CHANGELOG.md

# Build with full pipeline (parse → sign → upload to R2)
hands build push ./release.zip --sign --async --webhook https://ci.example.com/hook

# List recent builds
hands builds --app myapp-android --limit 20

# Release a build (promote to live)
hands release create --build <buildId>
hands release create --build <buildId> --scope platform --platforms darwin-arm64,darwin-x64
hands release create --build <buildId> --scope ip --cidrs 10.0.0.0/8,192.168.0.0/16
hands release create --build <buildId> --full --force   # skip interactive confirmation
hands release create --latest                              # release most recent build

# List releases
hands releases --app myapp-android --channel production --limit 20

# Rollback
hands release rollback --release <releaseId> --reason "Critical bug in 1.2.3"

# Operations (parse / upload / publish ops logs)
hands ops list --app myapp-android
hands ops retry --op <opId>
hands ops delete --op <opId>

# Channels
hands channels list --app myapp-android
hands channels create --app myapp-android --slug beta --name Beta --bundle-id com.example.myapp.beta

# Product types
hands product-types list --app myapp-android

# Webhooks
hands webhooks list
hands webhooks create --url https://ci.example.com/hands-hook --events release:new,release:superseded
```

### 6.4 CI integration

```
# package.json
{
  "scripts": {
    "release": "npm run compile && hands build push ./release.zip --async --webhook https://ci/hands && hands release create --latest --force"
  }
}
```

## 7. Admin UX

### 7.1 Sentry-style App creation wizard (3 steps)

**Step 1: Basics**
```
App name: [My App        ]
Slug:     [myapp         ] (auto-generated from name, editable)
Description: [                          ]
```

**Step 2: Product types (checkbox list)**
```
What do you want to ship? (check all that apply)
[ x ] Android APK                (parser: apk-aapt)
[   ] Android AAB                (parser: aapt)
[   ] iOS IPA                    (parser: ipa-info)
[ x ] Electron desktop app       (parser: electron-asar)
        ↳ Supported platforms (sub-checklist):
            [ x ] macOS  (darwin-arm64, darwin-x64)
            [ x ] Linux  (linux-x64, linux-arm64)
            [ x ] Windows (win32-x64, win32-arm64)
[   ] React Native OTA bundle    (parser: rn-bundle)
[   ] CLI tool                   (parser: unknown)
[ + Add custom product type ]
```

**Step 3: Release types (review defaults, customize)**
```
How do you label releases?
[ x ] stable   (green)   "Production-ready"
[ x ] rc       (blue)    "Release candidate"
[ x ] beta     (orange)  "Public beta"
[ x ] internal (gray)    "Internal team only"
[ + Add custom release type ]
```

On Save:
1. Insert apps row
2. Insert product_types rows (each checked) with `supported_platforms_json` from sub-picker
3. Insert release_types rows (each checked, with seed defaults)
4. Insert channels rows (production + beta + internal by default)
5. Show toast + redirect to AppDetail

### 7.2 AppDetail — 5 tabs

```
URL: /apps/:appId
Tabs: Overview | Builds | Releases | Channels | Settings
```

**Overview**:
- Latest release per (channel, product_type, release_type) — at-a-glance grid
- Active build count, download counts (chart)
- Recent ops from operation_logs (with retry/delete)

**Builds** (table):
| Version | Channel | Product | Release Type | Status | Assets | Actions |
|---|---|---|---|---|---|---|
| 1.2.3 (42) | production | electron-installer | stable | ✓ succeeded | 6 platforms | Prepare release · Delete |
| 1.2.3 (42) | beta | android-apk | beta | ✓ succeeded | 1 (apk) | Prepare release · Delete |
| 1.2.4 (43) | production | android-apk | stable | ⏳ building | 1/1 | Cancel |
| 1.2.4-rc.1 (43) | beta | electron-installer | rc | ✗ smoke_test_failed | 6/6 | Logs · Retry · Delete |

**Releases** (table):
| Released | Version | Channel | Product | Type | Scope | Status | Actions |
|---|---|---|---|---|---|---|---|
| 2026-06-25 | 1.2.3 | production | electron | stable | full | active | Bump rollout · Force update · Roll back |
| 2026-06-20 | 1.2.4-rc | production | electron | rc | platform: darwin | active | Promote to stable · Cancel |
| 2026-06-15 | 1.2.2 | production | electron | stable | full | superseded | Roll back to this |
| 2026-06-10 | 1.2.1 | production | electron | stable | ip: 10.0.0.0/8 | superseded | Delete |

**Channels** (table):
| Slug | Name | Bundle ID | Password | Product types | Actions |
|---|---|---|---|---|---|
| production | Production | com.example.myapp | — | apk, electron | Edit · Delete |
| beta | Beta | com.example.myapp.beta | — | apk, rn-bundle | Edit · Delete |
| internal | Internal | com.example.myapp.internal | required | apk | Edit · Delete |

**Settings**:
- Code signing credentials (with "Add Mac cert" / "Add Windows cert" / "Add Android cert" buttons → upload wizard)
- Webhooks (list + add)
- Archive app (toggle archived flag)

### 7.3 UploadWizard — 5 steps (per build, not release)

**Step 1: Target**
```
Channel:       [production          ▾]  required
Product type:  [electron-installer ▾]  required (filtered to app's enabled_product_types per channel)
Release type:  [stable              ▾]  required (filtered to app's release_types)
Show context: latest build on (channel, product_type, release_type)
```

**Step 2: Version**
```
Version name:  [1.2.4    ]  required (semver-ish; auto-suggested from latest)
Version code:  [44       ]  required (auto-incremented; editable)
```

**Step 3: Files (per-platform matrix)**
```
If product_type == 'electron-installer':
  [ macOS  ]
    darwin-arm64:    [drag .dmg here]
    darwin-x64:      [drag .dmg here]
  [ Linux  ]
    linux-x64:       [drag .AppImage or .deb or .rpm here]
    linux-arm64:     [drag .deb here]
  [ Windows]
    win32-x64:       [drag .exe here]
    win32-x64-user:  [drag .exe (no-admin) here]
    win32-arm64:     [drag .msi here]
If product_type == 'android-apk':
  Single file: [drag .apk here]
If product_type == 'rn-bundle':
  Single file: [drag .zip bundle here]
```

**Step 4: Release details**
```
Changelog:           [textarea, markdown]
Should force update: [ ] (only for electron/bundle)
Availability:        [now    ▾]  (datetime picker for scheduled)
Provenance:          (auto-filled from CI/git if available; editable)
```

**Step 5: Confirm + push**
```
Summary card of all choices + per-asset preview
[Cancel]  [Push build →]
```

After push, build sits in `succeeded` state in the Builds tab. User then opens it → "Prepare release" → scope modal.

### 7.4 Prepare Release modal (separate from UploadWizard)

```
[Build 1.2.4 (44) — electron-installer / production / stable]

✓ Build status: succeeded
✓ Version is higher than previous release (1.2.3 = 42)
✓ Code signing credentials valid for: darwin-arm64, darwin-x64, linux-x64, win32-x64, win32-arm64
✓ No active release with same version_code

Release scope:
( ) Full release           — all users on this (channel, product_type, release_type)
(•) Platform release       — selected platforms only
      [ x ] darwin-arm64   [ x ] darwin-x64   [   ] darwin-universal
      [ x ] linux-x64      [ x ] linux-arm64
      [ x ] win32-x64      [ x ] win32-arm64
( ) IP range release       — corp VPN users only
      CIDR list: [                          ]
      [comma-separated, e.g. 10.0.0.0/8,192.168.0.0/16]

Rollout:
  Initial cohort: [ 10%  ▒▒▒░░░░░░░ ] 0–100 slider (default 100 = full)
  [ ] Force update

Availability:
  [Now ▾]   (datetime picker for scheduled)

[Cancel]  [Release]
```

## 8. Schema migration plan (revised for v3)

**Phase 1 (Android only, additive, non-breaking)**:
- Migration 0004: add `apps.archived`, `apps.archived_at`, `apps.description`. Add `channels.password`, `channels.git_url`, `channels.bundle_id`, `channels.enabled_product_types_json`, `channels.metadata_json`. Add `builds` table (just scaffold, no usage yet). Add `signing_credentials` table (scaffold).
- No admin UI changes. ~1 hour.

**Phase 2 (multi-platform + build/release split)**:
- Migration 0005: create `product_types` + `release_types` tables. Backfill defaults per existing app. Backfill `release_types` with `stable/rc/beta/internal`.
- Migration 0006: create `builds` + `build_assets` tables. Backfill: for each existing `versions` row, create one `builds` row + one `build_assets` row (platform='android', arch=NULL, variant=NULL, filetype='apk').
- Migration 0007: create `releases` + `release_scopes` tables. Backfill: each existing version → `releases` row (status='active', is_full=1, scope='full') + `release_scopes` row.
- Migration 0008: deprecate `versions` (rename to `_versions_legacy`, keep for read-only audit). Future: drop after admin UI migrated.
- Admin UI: App wizard + UploadDialog 5-step + Builds/Releases/Channels tabs. ~10 hours total.

**Phase 3 (OTA + Electron + CLI)**:
- Migration 0009: add `build_assets.target_app_version`, `build_assets.fingerprint_hash`. Add `releases.metadata` (per-release custom fields).
- Container: add `electron-asar` + `rn-bundle` parsers.
- API: add `/public/apps/:slug/bundles` endpoint. Add `release_scopes` resolution logic.
- CLI: public alpha `@botiverse/hands-cli@0.1.0` is published to npm; remaining
  planned commands continue incrementally.
- ~1-2 weeks.

Each phase is shippable independently.

## 9. Open questions

1. **Multi-tenancy** — `accounts` table? orgs? teams? v1: single-account model, defer multi-tenant. Affects `signing_credentials.owner_id` (currently `account`).

2. **CLI distribution** — resolved 2026-07-02: `@botiverse/hands-cli` is public on
   npm. Default server is the public Hands Worker, and self-hosted Workers can
   be selected with `--api` / `QUIVER_API`.

3. **Webhook delivery reliability** — fire-and-forget or retry-with-backoff? hot-updater doesn't have webhooks. ToDesktop has them but doesn't document reliability. Recommendation: in-D1 queue + Worker Cron trigger (every 5 min) to retry failed webhook deliveries. v2 concern.

4. **Smoke test** — ToDesktop's biggest differentiator. v1 skip. v2 maybe integrate with cloud-hosted macOS/Windows VMs (MacStadium, AWS G5 instances). Container-based smoke test for Electron is hard (needs real GUI). For APK we can use existing container to install + start activity + take screenshot.

5. **Scheduled release** (`availability_at`) — cron-based or just show "live at <datetime>" + auto-promote? Recommendation: admin manually clicks "release" at the time; `availability_at` is informational only for v1.

6. **Auto-rollback on crash spike** — ToDesktop doesn't have this. Sentry has "revert to last good release" via metrics. Out of scope for v1.

7. **`release_types` per app or global?** — Per-app matches the user's instinct ("创建产品，然后选支持的平台"). Defaults seeded per app, user customizes. Recommendation: per-app.

8. **How do we get the user's `appVersion` for bundle targeting on OTA clients?** — Client SDK reads from `BuildConfig.VERSION_NAME` for Android / `electron.app.getVersion()` for Electron / `app.json` for RN. Standard. SDK can compute this automatically.

## 10. References

- **ToDesktop docs** (read in full for v3): https://www.todesktop.com/electron/docs/
- **ArekSredzki/electron-release-server** (Flavor/Channel/Asset/Platform split): https://github.com/ArekSredzki/electron-release-server
- **Zealot** (apk/ipa/exe/dmg full-binary distribution): https://zealot.ews.im/docs/
- **bytemain/hot-updater** (OTA JS bundle distribution): https://github.com/bytemain/hot-updater
- **Sentry** (project + platform picker wizard UX inspiration): https://docs.sentry.io/product/sentry-basics/integrate-frontend/create-new-project/
- **Cursor** (download URL matrix: darwin-arm64, linux-x64, win32-x64-user, ...): https://cursor.com/download

## 11. Implementation order (post-approval)

1. Phase 1 schema migration (additive only). Deploy. ~1 hour.
2. Phase 1 admin UI: archive toggle, changelog, provenance, rollout fields on existing UploadDialog + Publishing. Deploy. ~3 hours.
3. Phase 2 schema migrations 5-8 (new tables, backfill). Deploy. ~2 hours.
4. App creation wizard (3 steps). Deploy. ~3 hours.
5. Build/Release split in admin UI (Builds tab + Releases tab + Prepare release modal). Deploy. ~6 hours.
6. Phase 3 schema + container parsers + bundles endpoint. ~1-2 weeks.
7. CLI (`@botiverse/hands-cli`). ~1 week.

Each step independently shippable.
