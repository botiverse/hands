# Quiver Public API Reference

Status: **draft v2** (X.1.5 — cross-cutting docs; reflects current public contract as of 2026-06-30)

Base URL: `https://quiver.oranix.io`

---

## 1. Overview

The Quiver public API is the unauthenticated, client-facing surface used by
downstream consumers (Android clients, Electron auto-updaters, OTA bundle
fetchers, etc.) to discover the latest version of a given app and download
the signed binary.

All `/public/*` and `/api/invites/:token` (GET) endpoints:
- Are **unauthenticated** (no session cookie / no Bearer / no CF Access JWT).
- Are served by the **same Worker** as the admin endpoints — the Worker
  routes them to `app.get("/public/...", ...)` (not `admin.get`) so the
  per-route RBAC middleware (added in P5.2) is bypassed.
- CORS: same-origin allowed by default. Cross-origin: configure CORS on
  the Worker (currently permissive for `quiver.oranix.io`).
- Cache-Control: currently `no-store`; clients should not assume
  long-TTL caching without explicit `ETag` support (deferred to v2).
- Errors: returned as JSON `{ "error": "..." }` with appropriate
  HTTP status code (400 / 401 / 403 / 404 / 500). Body is **always** JSON.

The v2 public API reads from `builds` / `releases` / `release_scopes` and
performs server-side scope resolution (full / platform / ip_range / cohort).
The legacy `/public/apps/:slug/latest` path is wired to the same release-backed
resolver so clients and SDKs use one release model.

---

## 2. Endpoints

### 2.1 `GET /public/v2/apps/:slug/updates/check`

SDK-friendly update check. The server resolves the best active release for the
client, compares the caller's current version code, selects one compatible
asset, and returns a flat update/no-update decision.

**Auth**: none.

**Path params**:
- `slug` (required) — app slug, for example `myapp-android`.

**Query params**:
- `current_version_code` (required) — versionCode installed on the client.
- `channel` (optional, default `production`) — channel slug.
- `product_type` (optional, default for Android SDK is `android-apk`).
- `platform` (optional) — platform or platform+arch tuple, e.g. `android` or `android-arm64-v8a`.
- `arch` (optional) — architecture used for asset selection, e.g. `arm64-v8a`.
- `filetype` (optional, default `apk`) — requested asset file type.

**Headers**:
- `X-Quiver-Client-Platform` — header alternative to `platform`; also used for platform-scoped release matching.
- `X-Quiver-Client-Arch` — header alternative to `arch`.
- `X-Quiver-Cohort` — optional cohort token for `user_cohort` scopes.

**Update available** (200):
```json
{
  "update_available": true,
  "app": { "slug": "myapp-android", "platform": "android" },
  "channel": "main",
  "current_version_code": 42,
  "latest": {
    "build_id": "...",
    "version": "1.2.4",
    "version_code": 43,
    "changelog": "Bug fixes",
    "force_update": false,
    "released_at": 1782560000000
  },
  "asset": {
    "platform": "android",
    "arch": "arm64-v8a",
    "variant": null,
    "filetype": "apk",
    "size_bytes": 23217680,
    "signature": "d7b17c41...",
    "download_url": "/api/r2/apps%2F20d2dc58-...%2Fpending%2F...apk?expires=1782563600"
  },
  "scoped": { "scope_type": "full", "scope_value": "all", "release_id": "..." },
  "expires_in": 3600
}
```

**No update** (200):
```json
{
  "update_available": false,
  "app": { "slug": "myapp-android", "platform": "android" },
  "channel": "main",
  "current_version_code": 43,
  "latest_version_code": 43,
  "scoped": { "scope_type": "full", "scope_value": "all", "release_id": "..." },
  "checked_at": 1782560000000
}
```

**Errors**:
- `400` `{ "error": "current_version_code must be a non-negative number" }`
- `404` app/channel/release/scope/compatible asset not found
- `500` matched release data is inconsistent

### 2.2 `GET /public/v2/apps/:slug/latest`

General release resolution endpoint. Returns one matched release plus all
compatible assets for debugging and non-SDK clients. Prefer
`/updates/check` for Android SDK flows.

### 2.3 `GET /public/apps/:slug/latest`

Alias for the release-backed latest resolver used by
`GET /public/v2/apps/:slug/latest`.

**Auth**: none.

**Path params**:
- `slug` (required) — the app's human-readable slug (e.g. `myapp-android`).

**Query params**:
- `channel` (optional, default `production`) — the channel slug
  (e.g. `production`, `beta`, `internal`).
- `platform` (optional, P3.3 only) — for per-platform filtering when
  scoped releases land. Currently ignored.

**Success response** (200):
```json
{
  "app": { "slug": "myapp-android", "platform": "android" },
  "version": {
    "id": "...",
    "version_name": "1.2.3",
    "version_code": 42,
    "package_name": "com.example.myapp",
    "signature_sha256": "d7b17c41...",
    "min_sdk": 21,
    "target_sdk": 34,
    "size_bytes": 23217680,
    "file_hash": "...",
    "r2_key": "apps/20d2dc58-.../pending/...apk",
    "enabled": 1,
    "created_at": 1782560000000
  },
  "download_url": "/api/r2/apps%2F20d2dc58-...%2Fpending%2F...apk?expires=1782563600",
  "expires_in": 3600
}
```

**Errors**:
- `404` `{ "error": "app 'xyz' not found" }` — app slug doesn't exist
- `404` `{ "error": "no enabled version for channel 'beta'" }` — no enabled version for that channel
- `500` `{ "error": "internal server error", "detail": "..." }` — server error (e.g. R2 signature failure)

**Notes**:
- `download_url` is a relative URL to a Worker proxy endpoint
  (`/api/r2/<key>?expires=<unix>`). Client should `DownloadManager.download()`
  (Android) or `net.download()` (Electron) with the URL + an auth-less
  HTTP client. The Worker returns a redirect to the actual R2 URL
  (or streams the bytes directly).
- `expires_in` is the TTL in seconds. `expires` query param in
  `download_url` is the unix timestamp of expiry.
- Worker signs the URL on every request (no client-side signing).

### 2.4 `GET /public/apps/:slug/channels`

List the channels available for an app.

**Auth**: none.

**Path params**:
- `slug` (required)

**Success response** (200):
```json
{
  "app": "myapp-android",
  "channels": [
    { "slug": "production", "name": "Production" },
    { "slug": "beta", "name": "Beta" },
    { "slug": "internal", "name": "Internal" }
  ]
}
```

**Errors**:
- `404` `{ "error": "app 'xyz' not found" }`

**Notes**:
- Includes all channels (regardless of password gate). The password
  gate is enforced on **download**, not on listing.
- Does NOT include disabled (archived) apps.
- Channel `slug` is what clients pass to `?channel=...` on the latest
  endpoint.

### 2.5 `GET /api/invites/:token`

Get the details of an invite (no auth required). Public because the
recipient may not yet be logged in.

**Auth**: none.

**Path params**:
- `token` (required) — the invite UUID (sent in the invite URL).

**Success response** (200):
```json
{
  "id": "uuid",
  "org_id": "uuid",
  "app_id": "uuid | null",
  "email": "bob@acme.com",
  "role": "member",
  "status": "pending",
  "message": "Welcome to the team!",
  "created_at": 1782560000000,
  "expires_at": 1783164800000,
  "invited_by_display_name": "Alice Chen",
  "org_name": "Acme Corp",
  "app_name": "My App Android | null"
}
```

**Errors**:
- `404` `{ "error": "..." }` — invite not found, or already accepted/revoked
  (returns 404 to avoid leaking which is which; treat 404 as "no longer
  valid")

**Notes**:
- The `token` IS the invite id (UUID). They are the same value.
- Does not return the raw `token` (it would be redundant).

### 2.6 `POST /api/invites/:token/accept`

Accept an invite. Auth required (must be logged in as some Raft principal).

**Auth**: required (Raft session cookie or CF Access JWT). Returns 401
JSON if not authenticated.

**Path params**:
- `token` (required)

**Body**: none (the token IS the body — accepting is by URL only)

**Success response** (200):
```json
{ "ok": true, "app_id": "uuid | null", "org_id": "uuid" }
```

**Errors**:
- `401` `{ "error": "unauthorized" }` — not logged in
- `404` `{ "error": "..." }` — invite not found
- `410` `{ "error": "expired" }` — invite past expires_at
- `409` `{ "error": "already accepted" }` — invite was already accepted
- `409` `{ "error": "revoked" }` — invite was revoked

**Side effects**:
- Creates/upserts `org_members` row for the current account
  (or upgrades their org_role if the invite has a specific role).
- If `app_id` is non-null, also creates/upserts `app_members` with the
  invite's `role`.
- Updates `invites.status='accepted'`, `accepted_at=now`, `accepted_by=account_id`.

### 2.7 `GET /api/r2/:key` (download proxy)

Internal proxy endpoint used by `download_url` above. Not a true public
API but exposed for client downloads.

**Auth**: none (the `expires` query param is the only auth — clients
must obtain a fresh URL via the `latest` endpoint).

**Path params**:
- `key` (URL-encoded R2 key)

**Query params**:
- `expires` (required) — unix timestamp; requests with `Date.now()/1000 >
  expires` get 403.

**Behavior**:
- Returns 302 redirect to the actual R2 signed URL.
- Alternatively (in dev / Worker-first mode) streams the bytes directly
  with `Content-Type` from the object's metadata.

**Errors**:
- `403` `{ "error": "expired" }` — URL expired
- `404` `{ "error": "not found" }` — key not in R2

---

## 3. Common client patterns

### 3.1 Android (Java/Kotlin) — check for updates

```kotlin
// Pseudocode
val response = httpClient.get(
    "https://quiver.oranix.io/public/v2/apps/$slug/updates/check" +
        "?channel=main&product_type=android-apk&current_version_code=$currentInstalledVersionCode" +
        "&platform=android&arch=arm64-v8a"
)
val check = response.body<JsonObject>()

if (check.getBoolean("update_available")) {
    val asset = check.getJsonObject("asset")!!
    val downloadUrl = asset.getString("download_url")!!
    // Start DownloadManager with downloadUrl
    downloadManager.enqueue(Request(Uri.parse(downloadUrl)))
}
```

### 3.2 Electron — auto-update

```js
const r = await fetch(`https://quiver.oranix.io/public/apps/my-electron/latest?channel=production`);
const { version, download_url } = await r.json();
if (semver.gt(version.version_name, currentVersion)) {
  autoUpdater.onUpdateAvailable = () => autoUpdater.download(download_url);
}
```

### 3.3 OTA bundle fetcher (RN / Expo)

For P3.3 (when bundles endpoint ships):
```ts
// GET /public/apps/:slug/bundles?channel=production&app_version=1.2.3
// → array of bundles matching target_app_version
```

---

## 4. Error codes

| HTTP | Meaning | When |
|---|---|---|
| 200 | OK | success |
| 400 | Bad request | malformed path / missing required query |
| 401 | Unauthorized | auth required (e.g. `acceptInvite`) but not logged in |
| 403 | Forbidden | signed URL expired, or role check failed (admin endpoints — not used in public) |
| 404 | Not found | app slug / channel / invite token doesn't exist; or invite already accepted/revoked |
| 409 | Conflict | (admin only) duplicate pending invite, delete with refs, last owner demotion, etc. |
| 410 | Gone | (admin) — reserved, currently returns 404 instead |
| 429 | Too many requests | (P3.3+) rate limiting — not implemented yet |
| 500 | Internal server error | R2 signing failure, D1 down, etc. Always returns JSON with `error` + `detail` |

**All error bodies are JSON**:
```json
{ "error": "human-readable message", "detail": "optional stack trace / context" }
```

For 5xx errors, `detail` may include sensitive information — don't log
it on the client side.

---

## 5. Versioning + deprecation

v1 has no API versioning. All endpoints are at `/public/...` or
`/api/invites/...`. When breaking changes are needed:
- v2 will use `/public/v2/...` (path versioning)
- v1 endpoints will be deprecated with `Sunset: <date>` HTTP header
  + `Deprecation: <date>` per RFC 8594
- Minimum 6-month overlap window

Until then: treat the public API as a "stability frozen at deployment
time" interface — the admin UI is the only first-class client and is
versioned together with the server.

---

## 6. Auth boundary

The public API is **separate from the admin API**. Key differences:

| | Public | Admin |
|---|---|---|
| Auth | None (Raft invite for accept) | Raft session cookie OR dev Bearer |
| RBAC | N/A (no per-row filter) | per-route role middleware (P5.2) |
| Routes | `app.get("/public/...")` | `admin.get/post/patch/delete("/api/...")` |
| CORS | open by default | restricted to first-party origins |
| Data | read-only | read + write |
| Rate limit | (P3.3+) | (P3.3+) |

`GET /api/invites/:token` is the one edge case — it's mounted under
`app` (public) but the response includes a PII-ish `email` field.
We rely on the UUID being unguessable (32 bytes) for security.
`POST /api/invites/:token/accept` is mounted under `app` too (since
the recipient may not be admin) but requires auth.

---

## 7. Performance + limits

- **Caching**: client SHOULD cache the `latest` response for 5 minutes
  (per the v1 SLA). Worker doesn't add explicit `Cache-Control` headers
  yet (P3.3+).
- **Rate limiting**: not implemented in v1. The Worker is on Cloudflare
  with platform-default limits (~100k req/day free tier). Per-client
  throttling is the client's responsibility.
- **Payload size**: `latest` is ~500 bytes JSON + a 1KB signed URL.
  `channels` is ~200 bytes. Trivial.
- **Concurrency**: no client-side limit. The Worker can handle ~1000
  concurrent D1 queries (subject to platform limits).

---

## 8. Open questions (deferred to P3.3)

- How do scoped releases (full / platform / ip_range / cohort) interact
  with the public `latest` endpoint? Current implementation reads from
  `versions` (no scope). P3.3 will switch to `releases` and add a
  `?platform=darwin-arm64&ip=...&cohort=...` query string for client
  metadata.
- Should the public `download_url` be a true R2 signed URL (S3 v4
  presigner with Cloudflare R2 access keys) instead of a Worker proxy?
  P4.2 work; P3.3 sticks with the proxy.
- Should we expose a `GET /public/apps/:slug/versions?limit=10` for
  client-side changelog rendering? P3.3 candidate.
- Should we add an OpenAPI 3.1 spec? P3.3 candidate (auto-generated from
  the Hono route definitions via `hono/zod-openapi`).

---

## 9. Related docs

- `publish-architecture.md` §5 — full API design (incl. Phase 3+ scope
  resolution)
- `cli-reference.md` — `@oranix/quiver-cli` (admin-side, not public)
- `admin-user-guide.md` — admin UI guide (companion to this doc)
- `account-org-invite.md` — RBAC + invite design that backs the public
  accept flow
- Worker routes source: `worker/src/routes/public.ts`,
  `worker/src/routes/orgs.ts` (handleGetInvite / handleAcceptInvite),
  `worker/src/index.ts` (route map)
