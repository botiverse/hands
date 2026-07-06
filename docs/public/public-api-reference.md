# Public API Reference

Quiver's public API lets apps check for updates, download release artifacts, submit feedback, and view share/history pages without a Quiver admin session.

Use the admin API or CLI for publishing. Use the public API from clients.

## Base URL

```text
https://quiver.oranix.io
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
| `lang` | No | Preferred changelog language, such as `zh-CN` or `en`. Also read from `X-Quiver-Lang` or `Accept-Language`. |
| `device_id` | No | Stable per-install identifier. Also read from `X-Quiver-Device-Id`. Required to participate in staged rollouts. |

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
    "force_update": false,
    "released_at": 1783162273735
  },
  "asset": {
    "platform": "android",
    "arch": "arm64-v8a",
    "filetype": "apk",
    "size_bytes": 29192396,
    "download_url": "https://quiver.oranix.io/public/r2/…"
  },
  "scoped": { "scope_type": "full", "scope_value": "all", "release_id": "…", "rollout_cohort_count": null }
}
```

`changelog` is localized: releases may carry per-language notes and the
server returns the best match for the requested language (exact tag →
language prefix → `en` → first available).

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

## Submit Feedback

```http
POST /public/v2/apps/:appSlug/feedback
Content-Type: multipart/form-data
X-Quiver-Client-Key: qk_...
```

Requires the app's **client key** (Sentry-DSN model: it identifies the app,
it is not a user secret). Pass it in the `X-Quiver-Client-Key` header (or a
`client_key` query parameter); missing or mismatched keys get `401`. Admins
find and rotate the key in the app's Settings tab or via
`GET /api/apps/:id/client-key` / `POST /api/apps/:id/rotate-client-key`.

| Field | Required | Description |
|---|---|---|
| `message` | Yes | Feedback text (max 10,000 chars). |
| `kind` | No | `feedback` (default), `bug`, or `crash`. |
| `contact` | No | Reply-to handle (email, Raft name, …). |
| `metadata` | No | JSON string: `version_name`, `version_code`, `channel`, `device_id`, `device_model`, `os_version`, `arch`, `locale`, plus custom keys. Crash tickets add `crash_exception_class` / `crash_top_frame` (grouping signature) and, for native crashes, `crash_native_frames` — an array of `{ index, offset, soname, build_id }` that the server symbolicates against the build's `native-symbols` asset. |
| `attachments` | No | Up to 3 files, 10 MB each (screenshots, logs). |

Returns `201` with `{ "id": "<ticket id>", "status": "open" }`. Rate limit:
10 submissions per hour per app + client IP. Tickets appear in the admin
Feedback tab; a `feedback:new` webhook fires for subscribed endpoints (crash
tickets can additionally trigger `crash:new_group` / `crash:spike`). The
Android SDK's `QuiverFeedback.submit(...)` wraps this endpoint and attaches
device metadata automatically.

## Device Register (telemetry)

```http
POST /public/v2/apps/:appSlug/devices
Content-Type: application/json
X-Quiver-Client-Key: qk_...
X-Quiver-Device-Id: <stable per-install uuid>
```

A lightweight launch ping (client throttles to ≤1/day/device) that powers
active-device and version-distribution analytics. Body is a JSON metadata
object (`version_name`, `version_code`, `channel`, `platform`, `arch`,
`os_version`, `device_model`, `locale`). The server upserts one row per
`(app, device id)` — no PII; the device id is a random per-install UUID.
Requires the app **client key** (same as feedback). Returns `202`.

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
| `500` | Server error. Retry later or contact the Quiver operator. |

## Compatibility

Public update checks are read-only and do not require authentication. Admin and publishing APIs require Quiver auth or an app-scoped deploy token.
