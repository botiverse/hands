# Quiver CLI Reference — `@oranix/quiver-cli`

Status: **alpha + planned contract** (Phase 3 / Task X.1.6)
Companion to: `publish-architecture.md` §6, `public-api-reference.md`

> **Caveat (updated 2026-07-02)**: `@oranix/quiver-cli` is published on npm as
> a public alpha package. Installed commands include `login`, `logout`,
> `whoami`, `apps list/get`, `builds list/get`, and
> `builds publish-android`. Some sections below still describe the planned
> command taxonomy and are not implemented in the alpha binary yet.
>
> **Per @Codex-Kuikly-KMP专家's guidance**: I labeled this "X.1.6 — low-conflict finishing item" so we can stabilize the command taxonomy + auth/role boundary + error codes + compat strategy before starting the actual implementation. The doc itself is a target contract; do not treat command names or flag shapes as fixed until the npm package lands.

---

## 1. Overview

`@oranix/quiver-cli` is the official command-line client for the Quiver APK distribution platform. It mirrors the design of `todesktop` / `firebase` / `wrangler` — every command is both human-friendly and CI-scriptable.

**Primary use cases**:
- Push build artifacts from CI (GitHub Actions, GitLab CI, BuildKite) without writing curl/HTTP
- Inspect / release / rollback builds and releases from the terminal
- Stream operation logs + SSE events

**Status legend** (used in section headers):
- **Current** — command maps to a backend endpoint that exists today on the deployed Worker.
- **Planned** — command is designed but the npm package isn't built yet. Calls will hit the same backend endpoints that the admin UI uses once shipped.
- **Future** — depends on Phase 3 (public API scope), Phase 4 (smoke test), or Phase 5 (org mgmt) work.
- Manage channels, webhooks, product types, release types

**Where to install**:
- Per-project dev dependency (recommended): `npm install --save-dev @oranix/quiver-cli`
- Global (occasional use): `npm install -g @oranix/quiver-cli`
- One-off execution: `npm exec --package @oranix/quiver-cli@0.1.1 -- quiver --help`

**Distribution**: public npm package. The CLI talks to any Quiver Worker instance (public `quiver.oranix.io` or self-hosted).

---

## 2. Authentication — *Planned* (CLI binary doesn't exist yet; backend `Login with Raft` OAuth + session cookies do work today)

### 2.1 First-time login (interactive)

```
$ quiver login
? Quiver server URL: https://quiver.oranix.io
? Email: alice@example.com
? Access token: ****************************
✓ Authenticated as alice@example.com (server_role: admin)
Token saved to ~/.quiver/auth.json (mode 0600).
```

The access token is generated from the Quiver admin web UI: **Settings → Access Tokens → New Token**. (Token endpoint design deferred to Phase 5 RBAC work.)

### 2.2 CI mode (env vars)

```bash
export QUIVER_SERVER="https://quiver.oranix.io"
export QUIVER_EMAIL="ci-bot@example.com"
export QUIVER_TOKEN="..."

quiver builds list   # uses env vars, no prompt
```

In CI, prefer short-lived tokens (rotate quarterly). Store in your CI's secret manager, not in repo.

### 2.3 Logout / whoami

```
$ quiver logout
✓ Logged out alice@example.com. Token removed from ~/.quiver/auth.json.

$ quiver whoami
alice@example.com (server_role: admin)
server: https://quiver.oranix.io
```

---

## 3. Command overview — *Planned taxonomy* (admin UI already does all of this via the same backend endpoints)

| Command | Description |
|---|---|
| `quiver login` / `logout` / `whoami` | Authentication |
| `quiver apps list` / `get` / `create` / `archive` | App CRUD |
| `quiver channels list` / `get` / `create` / `update` / `delete` | Channel CRUD |
| `quiver product-types list` / `create` / `update` / `delete` | Product type CRUD |
| `quiver release-types list` / `create` / `update` / `delete` | Release type CRUD |
| `quiver builds list` / `get` / `push` / `update` / `delete` | Build CRUD + upload |
| `quiver build-assets list` / `add` / `delete` | Per-build asset CRUD |
| `quiver releases list` / `get` / `create` / `rollback` / `bump-rollout` / `force-update` / `cancel` | Release lifecycle |
| `quiver ops list` / `retry` / `delete` | Operation log |
| `quiver webhooks list` / `create` / `delete` | Webhook config |
| `quiver signing-creds list` / `add` / `delete` | Signing credentials (Phase 4) |

All commands support `--help` and `--json` (machine-readable output for scripting).

---

## 4. Apps — *Current* (endpoints live; CLI commands are HTTP-shaped wrappers around `GET/POST/PATCH/DELETE /api/apps`)

### 4.1 `quiver apps list`

```
$ quiver apps list
ID                                    SLUG                NAME         PLATFORM    ARCHIVED
20d2dc58-859e-4085-8438-d3d013f5b015  myapp-android       My App       android     no
...
```

```
$ quiver apps list --archived
ID                                    SLUG          NAME           ARCHIVED
a1b2c3d4-...                         old-app       Old App        yes (2025-08-12)
...
```

```
$ quiver apps list --json
[{"id":"20d2dc58-...","slug":"myapp-android","name":"My App",...}]
```

### 4.2 `quiver apps get`

```
$ quiver apps get --app myapp-android
ID:       20d2dc58-859e-4085-8438-d3d013f5b015
Slug:     myapp-android
Name:     My App
Platform: android
Description: ...
Archived: no
Created:  2026-06-12T08:14:23Z
```

### 4.3 `quiver apps create`

```
$ quiver apps create \
    --slug myapp-ios \
    --name "My App iOS" \
    --platform ios \
    --description "iOS companion app"
✓ App created: b1c2d3e4-... (slug: myapp-ios)
```

After creation, the wizard seeds default `product_types` (android-apk + electron-installer + rn-bundle), default `release_types` (stable/rc/beta/internal), and default `channels` (production/beta/internal). To customize, run `quiver product-types ...` and `quiver release-types ...`.

### 4.4 `quiver apps archive` / `unarchive`

```
$ quiver apps archive --app old-app
✓ Archived old-app (archived_at: 2026-06-28T00:00:00Z)
  Future uploads will be rejected.

$ quiver apps unarchive --app old-app
✓ Unarchived old-app. Future uploads allowed.
```

---

## 5. Channels — *Current* (same as Apps)

### 5.1 `quiver channels list`

```
$ quiver channels list --app myapp-android
ID        SLUG          NAME          BUNDLE_ID                       PASSWORD  PRODUCT_TYPES
7c067...  production    Production    -                               -         android-apk,electron-installer,rn-bundle
abcd1...  beta          Beta          com.example.myapp.beta          -         android-apk,rn-bundle
ef234...  internal      Internal      com.example.myapp.internal      required  android-apk
```

### 5.2 `quiver channels create`

```
$ quiver channels create \
    --app myapp-android \
    --slug staging \
    --name "Staging" \
    --bundle-id com.example.myapp.staging \
    --password "letmein" \
    --git-url "https://github.com/foo/bar/tree/staging" \
    --enabled-product-types "android-apk,rn-bundle"
✓ Channel created: 1234abcd-... (slug: staging)
```

### 5.3 `quiver channels update`

```
$ quiver channels update --app myapp-android --channel beta \
    --password "" \
    --enabled-product-types "android-apk,rn-bundle,electron-installer"
✓ Updated channel beta.
```

### 5.4 `quiver channels delete`

```
$ quiver channels delete --app myapp-android --channel old-channel
✓ Deleted channel old-channel.

$ quiver channels delete --app myapp-android --channel production
✗ Cannot delete channel with 3 version(s); move or delete them first.
```

---

## 6. Product types — *Current* (Phase 2.1 schema landed; endpoints live)

User-defined per app: what kinds of artifacts we ship.

### 6.1 `quiver product-types list`

```
$ quiver product-types list --app myapp-android
ID        NAME                  DISPLAY_NAME         PARSER         SUPPORTED_PLATFORMS
abc1...   android-apk           Android APK          apk-aapt       (N/A)
def2...   electron-installer    Electron desktop    electron-asar  darwin-arm64, darwin-x64, linux-x64, ...
ghi3...   rn-bundle             RN/Expo OTA bundle   rn-bundle      (N/A)
```

### 6.2 `quiver product-types create`

```
$ quiver product-types create --app myapp-android \
    --name firmware-esp32 \
    --display-name "ESP32 firmware" \
    --parser-kind "raw-binary" \
    --supported-platforms "esp32-s3,esp32-c3"
✓ Product type created.
```

---

## 7. Release types — *Current* (same as product types)

User-defined per app: how to label releases (stable / rc / beta / internal / ...).

### 7.1 `quiver release-types list`

```
$ quiver release-types list --app myapp-android
ID    NAME      DISPLAY_NAME   COLOR     DESCRIPTION
rt1   stable    Stable         #10b981   Production-ready
rt2   rc        RC             #3b82f6   Release candidate
rt3   beta      Beta           #f59e0b   Public beta
rt4   internal  Internal       #6b7280   Internal team only
```

### 7.2 `quiver release-types create`

```
$ quiver release-types create --app myapp-android \
    --name nightly \
    --display-name "Nightly" \
    --color "#a855f7" \
    --description "Built from main every night"
✓ Release type created.
```

---

## 8. Builds — *Current* (Phase 2.4.6 endpoints live in Worker; CLI binary pending)

A build = one uploaded artifact. Immutable. Can be re-released multiple times.

### 8.1 `quiver builds list`

```
$ quiver builds list --app myapp-android --limit 10
ID                                    CHANNEL      PRODUCT_TYPE       RELEASE_TYPE  VERSION     CODE  STATUS         CREATED
8fb0d8db-...                         production   android-apk        stable        1.2.3       42    succeeded      2 days ago
a1b2c3d4-...                         beta         android-apk        beta          1.3.0-beta  50    building       5 min ago
...
```

### 8.2 `quiver builds get`

```
$ quiver builds get --app myapp-android --build 8fb0d8db-...
ID:              8fb0d8db-d0df-4b56-83a6-ebc5b0414448
App:             myapp-android
Channel:         production
Product type:    android-apk
Release type:    stable
Version:         1.2.3 (code 42)
Status:          succeeded
Changelog:       ## What's new
                  - Fixed login bug
                  - Updated onboarding flow
Provenance:      {"git_commit":"abc1234","branch":"main","ci_url":"https://..."}
Parsed metadata: {"package_name":"com.example.myapp",...}

Assets:
  PLATFORM  ARCH  VARIANT  FILETYPE  R2_KEY                                              SIZE        SHA256
  android   -     -        apk       apps/20d2dc58-.../pending/...apk              23217680    d7b17c41...

Created:  2026-06-26T12:34:56Z
Completed: 2026-06-26T12:35:10Z
```

### 8.3 `quiver builds push`

The main "upload" command. Most flags are auto-detected from the file.

```
$ quiver build push ./app-release.apk \
    --app myapp-android \
    --channel production \
    --product-type android-apk \
    --release-type stable \
    --changelog-file ./CHANGELOG.md \
    --version-name 1.2.4 \
    --version-code 43 \
    --provenance-git-commit "def5678" \
    --provenance-git-branch "release/1.2.4" \
    --provenance-ci-url "https://github.com/foo/bar/actions/runs/123" \
    --provenance-source "ci"
```

```
$ quiver build push ./release.zip \
    --app myapp-electron \
    --channel production \
    --product-type electron-installer \
    --release-type stable \
    --version-name 1.2.3 \
    --async \
    --webhook "https://ci.example.com/hooks/quiver"
✓ Build queued: e6f04b61-fed4-4504-b51b-7ff139d26a65 (async)
  Watch with: quiver builds get --app myapp-electron --build e6f04b61-...
  Webhook will fire on completion.
```

For Electron, point at a directory or a zip containing multiple installer files; CLI parses manifest and figures out platforms.

### 8.4 `quiver builds update`

```
$ quiver builds update --app myapp-android --build 8fb0d8db-... \
    --changelog "## What's new\n- Fixed bug"
✓ Updated build.
```

Only `changelog`, `provenance_json`, `should_force_update`, `availability_at` can be changed after upload (version metadata is immutable).

### 8.5 `quiver builds delete`

```
$ quiver builds delete --app myapp-android --build 8fb0d8db-...
✓ Deleted build.

$ quiver builds delete --app myapp-android --build 8fb0d8db-...
✗ Cannot delete build: 2 release(s) still reference it.
```

---

## 9. Build assets — *Current* (same as builds)

Per-(platform, arch, variant, filetype) binaries attached to a build.

### 9.1 `quiver build-assets list`

```
$ quiver build-assets list --app myapp-electron --build e6f04b61-...
ID       PLATFORM     ARCH     VARIANT   FILETYPE    SIZE         SHA256
...      darwin       arm64    -          dmg         89123456     a1b2...
...      darwin       x64      -          dmg         90123456     c3d4...
...      linux        x64      -          deb         76543210     e5f6...
...      win32        x64      -          exe         82345678     g7h8...
```

### 9.2 `quiver build-assets add`

```
$ quiver build-assets add --app myapp-electron --build e6f04b61-... \
    --platform darwin --arch arm64 --filetype dmg \
    --file ./MyApp-1.2.3-arm64.dmg
✓ Asset added. SHA256: a1b2...
```

The file is uploaded to R2 automatically; CLI computes size + SHA256 + signs if cert is configured.

### 9.3 `quiver build-assets delete`

```
$ quiver build-assets delete --app myapp-electron --build e6f04b61-... --asset abc123
✓ Asset deleted.
```

---

## 10. Releases — *Current* (Phase 2.5.4-7 endpoints live; full / platform / ip_range scopes implemented; cohort deferred to P5.5)

A release = a build that has been promoted to "live" with a scope. Mutable.

### 10.1 `quiver releases list`

```
$ quiver releases list --app myapp-android --limit 20
ID        BUILD       CHANNEL      PRODUCT     RELEASE  STATUS       IS_FULL  ROLLOUT  CREATED
...       8fb0d8db..  production   android-apk  stable    active       yes      100%     2 days ago
...       a1b2c3d4..  beta         android-apk  beta      active       yes      30%      5 min ago
...       0987fedc..  production   android-apk  stable    superseded   yes      100%     1 week ago
```

### 10.2 `quiver releases get`

```
$ quiver releases get --app myapp-android --release 8fb0d8db-...
ID:            ...
Build:         8fb0d8db-d0df-4b56-83a6-ebc5b0414448 (1.2.3 code 42)
Channel:       production
Product type:  android-apk
Release type:  stable
Status:        active
Is full:       yes
Changelog:     ...
Provenance:    ...
Force update:  no
Rollout:       100%
Scopes:
  TYPE     VALUE
  full     all
```

### 10.3 `quiver releases create`

The big one. Promotes a build to live with scope. **Atomic transaction**: old `active` releases on the same `(channel, product_type, release_type)` lane are marked `superseded` pointing at the new release id.

```
$ quiver releases create \
    --app myapp-android \
    --build 8fb0d8db-... \
    --channel production \
    --product-type android-apk \
    --release-type stable \
    --scope full

✓ Release created: 1234abcd-...
  Superseded release 5678efgh-... (1.2.3) → status: superseded.
```

**Platform-scoped release**:
```
$ quiver releases create \
    --app myapp-electron \
    --build e6f04b61-... \
    --channel production \
    --product-type electron-installer \
    --release-type stable \
    --scope platform \
    --platforms "darwin-arm64,darwin-x64" \
    --rollout-cohort 50 \
    --force-update
```

**IP-scoped release**:
```
$ quiver releases create \
    --app myapp-android \
    --build a1b2c3d4-... \
    --channel production \
    --product-type android-apk \
    --release-type beta \
    --scope ip \
    --ip-ranges "10.0.0.0/8,192.168.0.0/16" \
    --rollout-cohort 100
```

**User cohort** (Phase 5+):
```
$ quiver releases create ... \
    --scope cohort \
    --cohort "beta-testers-2026q2"
```

### 10.4 `quiver releases rollback`

Create a new release pointing to an older build. Marks current `active` as `superseded`.

```
$ quiver releases rollback \
    --app myapp-android \
    --channel production \
    --product-type android-apk \
    --release-type stable \
    --to-build 7521a659-7cbc-4990-8433-755061069dba \
    --reason "1.2.4 critical bug in checkout flow"
✓ Rolled back to build 7521a659-... (1.2.3)
  Superseded release ... → status: superseded.
```

### 10.5 `quiver releases bump-rollout`

```
$ quiver releases bump-rollout --app myapp-android --release 1234abcd-... \
    --to 50
✓ Bumped rollout_cohort_count from 30% to 50%.

# Or increment by delta
$ quiver releases bump-rollout ... --by 25
✓ Bumped rollout_cohort_count from 50% to 75%.
```

### 10.6 `quiver releases force-update`

```
$ quiver releases force-update --app myapp-android --release 1234abcd-... \
    --enable
✓ should_force_update: true (clients must install, no skip)

$ quiver releases force-update ... --disable
✓ should_force_update: false.
```

### 10.7 `quiver releases cancel`

Marks a release as cancelled before it goes live. (After going live, use `rollback` instead.)

```
$ quiver releases cancel --app myapp-android --release 1234abcd-... \
    --reason "failed validation"
✓ Release cancelled.
```

---

## 11. Operations (parse / upload / publish log) — *Current* (operation_logs table + GET /api/apps/:id/operations + POST /retry + DELETE; SSE stream at /operations/stream)

Every async task the admin UI triggers is recorded in `operation_logs`. SSE streams updates to the browser. The CLI can list + replay + delete operations.

### 11.1 `quiver ops list`

```
$ quiver ops list --app myapp-android --limit 20
ID                  KIND      STATUS       PROGRESS  RETRY  ERROR
op-1a2b3c           parse     success      1.00      0      -
op-d4e5f6           upload    success      1.00      0      -
op-7890ab           publish   failed       1.00      0      D1_ERROR: ...
op-cdef01           publish   in_progress  0.30      0      -
```

### 11.2 `quiver ops retry`

```
$ quiver ops retry --app myapp-android --op op-7890ab
✓ Op retried (retry_count: 1).

$ quiver ops retry --app myapp-android --op op-111111
✗ op-111111 is parse kind; retry not supported, re-trigger from admin UI.
```

### 11.3 `quiver ops delete`

```
$ quiver ops delete --app myapp-android --op op-7890ab
✓ Op deleted.
```

---

## 12. Webhooks — *Planned* (admin UI has placeholder UI; backend not yet implemented; CI recipes below assume webhook fires from a stub — real dispatch is P5.5/P5.6)

Quiver can dispatch HTTP webhooks for release lifecycle events (configurable per app).

### 12.1 `quiver webhooks list`

```
$ quiver webhooks list --app myapp-android
ID    URL                            EVENTS                            SECRET
w1    https://ci.example.com/hook    release:new,release:superseded  ********
```

### 12.2 `quiver webhooks create`

```
$ quiver webhooks create --app myapp-android \
    --url https://ci.example.com/hooks/quiver \
    --events "release:new,release:superseded,release:rolled-back" \
    --secret "shared-hmac-secret"
✓ Webhook created.
```

Payload example:
```json
{
  "event": "release:new",
  "delivery_id": "uuid",
  "app": { "id": "...", "slug": "myapp-android" },
  "release": {
    "id": "...", "build_id": "...", "channel": "production",
    "product_type": "android-apk", "release_type": "stable",
    "version": "1.2.4", "version_code": 43,
    "scope": { "type": "full", "value": "all" },
    "changelog": "...",
    "should_force_update": false,
    "rollout_cohort_count": 100
  },
  "delivered_at": "2026-06-28T12:34:56Z"
}
```

---

## 13. CI integration recipes — *Current endpoint shape, planned CLI wrapping* (recipes below show the curl + jq sequence the CLI will execute)

### 13.1 GitHub Actions

```yaml
# .github/workflows/release.yml
name: Build and publish
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run build
      - run: |
          npx @oranix/quiver-cli build push ./release.apk \
            --app myapp-android \
            --channel production \
            --product-type android-apk \
            --release-type stable \
            --changelog-file ./CHANGELOG.md \
            --provenance-git-commit ${{ github.sha }} \
            --provenance-git-branch ${{ github.ref_name }} \
            --provenance-ci-url ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }} \
            --provenance-source "ci"
        env:
          QUIVER_SERVER: ${{ secrets.QUIVER_SERVER }}
          QUIVER_EMAIL: ${{ secrets.QUIVER_EMAIL }}
          QUIVER_TOKEN: ${{ secrets.QUIVER_TOKEN }}
      - run: |
          npx @oranix/quiver-cli releases create \
            --app myapp-android \
            --build $(quiver builds list --app myapp-android --limit 1 --json | jq -r '.[0].id') \
            --channel production \
            --product-type android-apk \
            --release-type stable \
            --scope full \
            --force-update
```

### 13.2 GitLab CI

```yaml
build_and_release:
  stage: deploy
  image: node:22
  script:
    - npm ci
    - npm run build
    - |
      npx @oranix/quiver-cli build push ./release.apk \
        --app myapp-android \
        --channel production \
        --product-type android-apk \
        --release-type stable \
        --changelog-file ./CHANGELOG.md \
        --async \
        --webhook "$CI_PIPELINE_URL"
    - |
      sleep 30  # wait for async build
      npx @oranix/quiver-cli releases create \
        --app myapp-android \
        --build $(quiver builds list --app myapp-android --limit 1 --json | jq -r '.[0].id') \
        --channel production \
        --product-type android-apk \
        --release-type stable \
        --scope full
  environment:
    name: production
```

---

## 14. Output formats — *Planned* (all commands will support `--json` for scripting; admin UI today does NOT expose --json but the underlying API endpoints return JSON)

All commands support `--json` for machine-readable output. Default is human-readable table.

```bash
$ quiver apps list --json | jq '.[0].slug'
"myapp-android"

$ quiver builds list --json | jq '.[] | select(.status=="succeeded") | .id'
"8fb0d8db-d0df-4b56-83a6-ebc5b0414448"
```

For continuous monitoring, `--watch` re-polls every 2 seconds until the operation completes:

```bash
$ quiver builds get --app myapp-electron --build e6f04b61-... --watch
[10:23:45] status: building  progress: 0.00
[10:24:12] status: building  progress: 0.45
[10:24:18] status: smoke_testing
[10:24:51] status: succeeded
✓ Build ready.
```

---

## 15. Exit codes — *Planned* (CLI will define a stable exit code table; admin UI doesn't have one)

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic failure |
| 2 | Invalid arguments (bad flag, missing required) |
| 3 | Authentication failure (token expired or invalid) |
| 4 | Permission denied (RBAC — Phase 5) |
| 5 | Not found (404 from server) |
| 6 | Conflict (409 — e.g. delete with refs, duplicate slug) |
| 7 | Server error (5xx) |
| 8 | Network error (couldn't reach server) |
| 9 | Build smoke-test failed |
| 10 | Operation timed out |

Use in CI:
```bash
if ! quiver release create ...; then
  case $? in
    3) quiver login ;;
    6) echo "version already exists, use --force" ;;
    *) exit 1 ;;
  esac
fi
```

---

## 16. Environment variables — *Planned* (backend already supports `QUIVER_SERVER` / `QUIVER_TOKEN` via `dev-token` Bearer; CLI will add `QUIVER_EMAIL`)

| Variable | Description |
|---|---|
| `QUIVER_SERVER` | Server URL (e.g. `https://quiver.oranix.io`) |
| `QUIVER_EMAIL` | Email for token lookup (or service account email) |
| `QUIVER_TOKEN` | Access token |
| `QUIVER_CONFIG_DIR` | Override config dir (default `~/.quiver`) |
| `QUIVER_LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default `info`) |
| `QUIVER_NO_COLOR` | Disable colored output |
| `QUIVER_API_TIMEOUT_MS` | HTTP timeout in ms (default 30000) |
| `QUIVER_RETRIES` | Number of retries on 5xx (default 2) |

---

## 17. Config file — *Planned* (admin UI does not have a CLI-equivalent config; `QUIVER_*` env vars work today)

Location: `~/.quiver/config.json`

```json
{
  "server": "https://quiver.oranix.io",
  "email": "alice@example.com",
  "token_hash": "...",
  "log_level": "info",
  "api_timeout_ms": 30000,
  "retries": 2
}
```

Token is hashed + stored at `~/.quiver/auth.json` with mode 0600. The CLI never holds the raw token in memory longer than needed to sign each request.

---

## 18. Implementation status (as of 2026-07-02)

This doc is the design target plus alpha reference for npm package
`@oranix/quiver-cli`. The CLI binary exists and is public on npm, but not every
planned command in this document is implemented yet.

**Phases**:

- **Phase 2.1 + P2.2 (schema + backfill)** — ✅ DONE (commit `c6322ab`): product_types, release_types, channels, build_assets, releases, release_scopes tables on remote D1. 1 app + 1 legacy versions row backfilled. Builds table has parity with versions on `should_force_update` / `availability_at` / `provenance_json`.
- **Phase 2.4.6 + P2.5.4-7 (backend)** — ✅ DONE (commit `2c77b97` by @Codex-Kuikly-KMP专家): builds + build_assets + releases + release_scopes CRUD with transactional supersede + audit + legacy /versions compat shim. **The CLI can talk to these endpoints today** via `curl + Authorization: Bearer $QUIVER_TOKEN`.
- **Phase 3.4 (CLI npm package)** — 🟡 ALPHA: `packages/cli/` is published as public npm package `@oranix/quiver-cli@0.1.1`. Current binary covers auth, app/build listing, Android release publishing via `quiver builds publish-android`, and release share management via `quiver releases`. Ops/webhooks commands remain planned.
- **Phase 3.3 (public API scope)** — 🔵 TODO: P3.3 endpoints (`/public/apps/:slug/bundles`, scope resolution on `/latest`) will get CLI commands like `quiver bundles list` / `quiver releases scope`. The doc will get a new section then.

**Install**:
```
npm install --save-dev @oranix/quiver-cli
# or
npm install -g @oranix/quiver-cli
# or one-off
npm exec --package @oranix/quiver-cli@0.1.1 -- quiver --help
```

---

## 19. References

- [`publish-architecture.md`](./publish-architecture.md) §6 — original CLI design
- [`public-api-reference.md`](./public-api-reference.md) — public endpoints the CLI reuses (latest / bundles)
- [`admin-user-guide.md`](./admin-user-guide.md) — admin UI counterpart
- [`publish-tasks.md`](./publish-tasks.md) — P3.4 CLI implementation task
- [`account-org-invite.md`](./account-org-invite.md) §5.2 — role matrix that gates CLI commands
- ToDesktop CLI (inspiration): https://www.todesktop.com/electron/docs/libraries/cli
- bytemain/hot-updater CLI (inspiration): https://github.com/bytemain/hot-updater
- wrangler (general CLI patterns): https://developers.cloudflare.com/workers/wrangler/

## 20. Stability + compat strategy

Per the public-api-reference compat policy, the CLI's command names + flag shapes may evolve before the 1.0 release. The CLI will use **semantic versioning**:
- **0.x.y (current)** — breaking changes allowed between minor versions. CI scripts should pin a version (e.g. `npm install --save-dev @oranix/quiver-cli@^0.4.0`).
- **1.0.0** — first stable release. Subsequent minor versions are backward-compatible; major versions may break (with 6-month deprecation).
- **Server compat** — the CLI requires Worker version >= a minimum (will be enforced at login). If you point the CLI at an older Worker, login fails with a clear version-mismatch error rather than silent misbehavior.

## 21. Test + release process

Every CLI release should be:
1. Tagged in `quiver` (CLI repo) on green CI (typecheck, unit tests against a mock Worker, snapshot tests for command output)
2. Published to npm under the `@oranix/quiver-cli` scope (public)
3. Cross-tested against the latest 3 Worker releases (rolling compat window)
4. Released notes highlight any new commands or breaking changes

For now (Phase 3.4 prep): the command taxonomy in §3 is the contract the implementation will be tested against. Changing a flag name or default behavior is a doc update first, code second.
