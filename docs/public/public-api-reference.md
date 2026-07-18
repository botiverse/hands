# Public API Reference

> **Interactive API explorer:** the full request/response schemas live in
> the OpenAPI spec — browse and try them at [/api-docs](/api-docs)
> ([openapi.json](/openapi.json)).

Hands's public API lets apps check for updates, download release artifacts, submit feedback, and view share/history pages without a Hands admin session.

Use the admin API or CLI for publishing. Use the public API from clients.

## Base URL

```text
https://hands.build
```

Self-hosted deployments should use their own origin.

## Check for Updates

```http
GET /public/v2/apps/:appSlug/updates/check?channel=main&product_type=android-apk&current_version_code=1000000&platform=android&arch=arm64-v8a&filetype=apk
```

### Query Parameters

| Name | Required | Description |
|---|---|---|
| `channel` | No | Release channel, such as `main` (default), `preview`, `nightly`, or `debug`. |
| `current_version_code` | Yes | Installed client version code. |
| `product_type` | No | Product type, such as `android-apk`. |
| `platform` | No | Client platform, such as `android`. |
| `arch` | No | Client architecture, such as `arm64-v8a`. |
| `filetype` | No | Desired installable file type. Defaults to `apk`. |
| `lang` | No | Preferred changelog language, such as `zh-CN` or `en`. Also read from `X-Hands-Lang` or `Accept-Language`. |
| `device_id` | No | Stable per-install identifier. Also read from `X-Hands-Device-Id`. Required to participate in staged rollouts. |

### Staged rollouts

Releases can be published to a percentage of devices. The server buckets
clients by hashing `(release_id, device_id)`, so a device keeps its bucket
while the percentage climbs. Clients that send no device id only ever see
fully rolled-out releases; gated-out clients fall through to the previous
active release. The Android SDK sends the header automatically.

### Update Available

```json
{
  "update_available": true,
  "app": { "slug": "raft-android", "platform": "android" },
  "channel": "main",
  "current_version_code": 1000000,
  "latest": {
    "build_id": "…",
    "version": "1.0.1",
    "version_code": 1000100,
    "changelog": "Bug fixes and improvements",
    "release_notes": {
      "en": "Bug fixes and improvements",
      "zh-CN": "修复问题并优化体验"
    },
    "force_update": false,
    "released_at": 1783162273735
  },
  "asset": {
    "platform": "android",
    "arch": "arm64-v8a",
    "filetype": "apk",
    "size_bytes": 29192396,
    "download_url": "https://hands.build/public/r2/…"
  },
  "scoped": { "scope_type": "full", "scope_value": "all", "release_id": "…", "rollout_cohort_count": null }
}
```

`changelog` is localized: releases may carry per-language notes and the
server returns the best match for the requested language (exact tag →
language prefix → `en` → first available). `release_notes` is the structured
per-language object for consumers that need all available languages without
parsing the legacy `changelog` string.

### No Update

```json
{ "update_available": false, "current_version_code": 1000100, "latest_version_code": 1000100 }
```

## Latest Release

```http
GET /public/v2/apps/:appSlug/latest?channel=main&product_type=android-apk
```

Returns the latest compatible installable release for the channel,
independent of the client's installed version. Accepts the same `lang` and
`device_id` inputs as the update check.

## Release Notes JSON

```http
GET /public/v2/apps/:appSlug/release-notes?version_code=1000100&lang=zh-CN
```

Returns public release notes as JSON for clients that should not parse the
HTML `/notes/:appSlug` page. The app must have public history enabled.
`version_code` is optional; when present, the response includes that version
and older non-cancelled versions. Draft notes are returned only when the draft
matches the requested `version_code`, which supports preview flows before
publish.

```json
{
  "app": { "slug": "raft-android", "name": "Raft Android", "platform": "android" },
  "requested_version_code": 1000100,
  "lang": "zh-CN",
  "releases": [
    {
      "release_id": "…",
      "status": "active",
      "channel": "main",
      "version": "1.0.1",
      "version_code": 1000100,
      "released_at": 1783162273735,
      "changelog": "修复问题并优化体验",
      "release_notes": {
        "en": "Bug fixes and improvements",
        "zh-CN": "修复问题并优化体验"
      }
    }
  ]
}
```

Authenticated release APIs also expose `release.release_notes` on
`GET /api/apps/:appId/releases/:releaseId` and release list rows. Publishers
can write structured notes with `release_notes`:

```http
PATCH /api/apps/:appId/releases/:releaseId
Content-Type: application/json

{
  "release_notes": {
    "en": "Bug fixes and improvements",
    "zh-CN": "修复问题并优化体验"
  }
}
```

`changelog` remains the localized display string. `release_notes` is the
canonical structured object for consumers that need every language.

## Electron Generic Provider

Electron apps using `electron-updater` can point the generic provider at
Hands:

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://hands.build/electron/:appSlug/:channel"
});
```

The app then requests electron-builder's standard files directly:

```http
GET /electron/:appSlug/:channel/latest.yml
GET /electron/:appSlug/:channel/latest-mac.yml
GET /electron/:appSlug/:channel/latest-linux.yml
GET /electron/:appSlug/:channel/:installerFile
GET /electron/:appSlug/:channel/:installerFile.blockmap
```

Hands serves these from the active `electron-installer` release on that
channel. Hands intentionally hosts electron-builder's generated files
as-is: upload `latest*.yml`, installers, and `.blockmap` files as build
assets. Use `artifact_kind = electron-metadata` for `latest*.yml`; use the
original filename in `variant` or `metadata_json.filename` so relative URLs
inside the yml resolve unchanged.

Example asset conventions:

| File | `platform` | `arch` | `filetype` | `artifact_kind` |
|---|---|---|---|---|
| `latest.yml` | `win32` | `x64` or null | `yml` | `electron-metadata` |
| `latest-mac.yml` | `darwin` | `arm64` or `x64` | `yml` | `electron-metadata` |
| `latest-linux.yml` | `linux` | `x64` or `arm64` | `yml` | `electron-metadata` |
| `Raft Setup 1.2.3.exe` | `win32` | `x64` | `exe` | `installable` |
| `Raft Setup 1.2.3.exe.blockmap` | `win32` | `x64` | `blockmap` | `electron-blockmap` |

### Tauri updater

Tauri v2 applications can configure this dynamic updater endpoint:

```text
GET /tauri/:appSlug/:channel/:target/:arch/:currentVersion
```

`target` is `darwin`, `windows`, or `linux`; `arch` follows Tauri's updater
values such as `aarch64` and `x86_64`. The endpoint returns `204 No Content`
when the active `tauri-updater` release is not newer. Otherwise it returns the
Tauri updater JSON fields `version`, `url`, `signature`, and optional release
notes/date. The artifact URL is immutable and belongs to the same active Hands
release. Signature verification is performed by Tauri using the public key
embedded in the application; Hands never receives the signing private key.

macOS updates still require signed app artifacts. Hands only hosts the
already-built and signed files; it does not sign Electron applications.

## Submit Feedback

```http
POST /public/v2/apps/:appSlug/feedback
Content-Type: multipart/form-data
X-Hands-Client-Key: qk_...
```

Requires the app's **client key** (Sentry-DSN model: it identifies the app,
it is not a user secret). Pass it in the `X-Hands-Client-Key` header (or a
`client_key` query parameter); missing or mismatched keys get `401`. The legacy
`X-Quiver-Client-Key` header is still accepted for backward compatibility. Admins
find and rotate the key in the app's Settings tab or via
`GET /api/apps/:id/client-key` / `POST /api/apps/:id/rotate-client-key`.

| Field | Required | Description |
|---|---|---|
| `message` | Yes | Feedback text (max 10,000 chars). |
| `kind` | No | `feedback` (default), `bug`, or `crash`. |
| `contact` | No | Reply-to handle (email, Raft name, …). |
| `metadata` | No | JSON string: `version_name`, `version_code`, `channel`, `device_id`, `device_model`, `os_version`, `arch`, `locale`, plus custom keys. Crash tickets add `crash_exception_class` / `crash_top_frame` (grouping signature) and, for native crashes, `crash_native_frames` — an array of `{ index, offset, soname, build_id }` that the server symbolicates against the build's `native-symbols` asset. |
| `attachments` | No | Inline files (multipart), up to 10 MB each, ≤9 total. |
| `presigned` | No | JSON array of `{ r2_key, filename, content_type, size }` for files already uploaded via the presign flow (below). |

Returns `201` with the full ticket UUID in `id`, plus a copyable `reference`
and `ticket_url`, for example `{ "id": "<ticket UUID>", "status": "open",
"reference": "raft-android · 1.0.4 (1000400) · ticket <ticket UUID>",
"ticket_url": "https://app.hands.build/apps/<appId>/feedback/<ticket UUID>" }`.
Rate limit: 10 submissions per hour per app + client IP. Tickets appear in
the admin Feedback tab; a `feedback:new` webhook fires for subscribed
endpoints (crash tickets can additionally trigger `crash:new_group` /
`crash:spike`). The Android SDK's `HandsFeedback.submit(...)` wraps this
endpoint and attaches device metadata automatically.

## Metrics Ingest

```http
POST /public/v2/apps/:appSlug/metrics
Content-Type: application/json
X-Hands-Client-Key: qk_...
X-Hands-Device-Id: <stable per-install uuid>
```

A lightweight launch/install ping (client throttles to ≤1/day/device) that powers
active-device and version-distribution analytics. Body is a JSON metadata
object (`version_name`, `version_code`, `channel`, `platform`, `arch`,
`os_version`, `device_model`, `locale`). The server upserts one row per
`(app, device id)` — no PII; the device id is a random per-install UUID.
Requires the app **client key** (same as feedback). Returns `202`. Legacy SDKs
may still post the same payload to `/public/v2/apps/:appSlug/devices`; new SDKs
should use `/metrics`.

Authenticated admins and agents can read the aggregated version view at
`GET /api/apps/:id/analytics/versions?window_days=30`. It joins these metrics
pings with release update-check counters, feedback/crash tickets, and artifact
download counters to report per-version metrics such as `active_devices`,
`total_devices`, `update_current_count`, `update_offered_count`,
`feedback_count`, `crash_count`, and `download_count`. `window_minutes` is
available for recent-report windows, but the SDK ping is throttled and should
not be treated as true online presence.

## Presigned attachment upload (large files)

For attachments too large for an inline multipart submit (up to **200 MB**),
request a direct-to-R2 upload URL, PUT the bytes to it, then submit the
ticket referencing the uploaded object.

```http
POST /public/v2/apps/:appSlug/feedback/presign
Content-Type: application/json
X-Hands-Client-Key: qk_...
```

Body: `{ "files": [{ "filename": "...", "content_type": "...", "size": <bytes> }] }`
(≤9 files). Returns `{ "uploads": [{ attachment_id, r2_key, upload_url, expires_at }] }`.

1. `PUT` each file's bytes to its `upload_url` with the same `Content-Type`.
2. Submit feedback with a `presigned` form field = JSON array of
   `{ r2_key, filename, content_type, size }` for the uploaded files.

Returns `501` if direct upload isn't configured on the server. Total
attachments (inline + presigned) may not exceed 9.

## Share Pages

- `GET /share/:token` — public download page for one release (view/download
  stats, QR code on desktop, localized changelog). Optionally
  password-protected: the page shows an unlock form; `POST /share/:token/unlock`
  sets a short-lived cookie scoped to that share.
- `GET /share/:token/download` — the artifact download (302 to a signed URL).
- `GET /share/:token/icon` — the app icon for that release's build (falls
  back to the app-level icon).

Share links are created from the admin Shares tab, the CLI, or the API, and
can be renewed, revoked, and password-protected after creation.

## Version History

When enabled per app (Settings → Public version history):

- `GET /apps/:appSlug/history` — public page listing published versions with
  localized changelogs, sizes, and downloads.
- `GET /apps/:appSlug/history/:releaseId/download` — per-version download
  (302 to a signed URL).

Disabled apps return `404`.

## App Icon

```http
GET /public/apps/:appSlug/icon
```

Serves the app icon. Per-build icons are extracted automatically from
uploaded APKs (aapt); an app-level icon can also be uploaded from the admin
Settings page as a fallback.

## Download URLs

`download_url` values are signed, time-limited URLs. Clients should use them promptly and request a fresh update check if the URL expires.

The response includes a readable download filename through `Content-Disposition` when the artifact is fetched.

## Client Behavior

Recommended client flow:

1. Send the installed `versionCode`, configured channel, system language, and the SDK's persistent device id.
2. If `update_available` is false, do nothing.
3. If true, show release information or begin the update flow.
4. Download the artifact from `asset.download_url`.
5. Verify size/hash if the client update framework supports it.
6. Install or hand off to the platform installer.

## Errors

| Status | Meaning |
|---|---|
| `400` | Missing or invalid request parameters. |
| `404` | App, channel, release, or compatible artifact was not found. |
| `410` | Signed download URL expired. |
| `401` | Missing/invalid client key (feedback submissions). |
| `429` | Rate limited (feedback submissions). |
| `500` | Server error. Retry later or contact the Hands operator. |

## Compatibility

Public update checks are read-only and do not require authentication. Admin and publishing APIs require Hands auth or an app-scoped deploy token.
