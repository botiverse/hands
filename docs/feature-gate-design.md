# Feature gate ("feature flags") — design

A general, reusable **server-side feature gate**. A flag is **fail-safe OFF**:
it is disabled unless a matching row explicitly enables it. Flags are evaluated
per request, so a flag can target a single device (or cohort, or platform, or a
percentage of devices) before an app-wide rollout.

The first consumer is **delta-update offers** — so we can enable delta downloads
for one test device, validate end-to-end, then widen the rollout.

## Model

Table `feature_flags` (migration `0042_feature_flags.sql`):

| column             | type    | meaning                                                  |
| ------------------ | ------- | -------------------------------------------------------- |
| `id`               | TEXT PK | row id                                                   |
| `app_id`           | TEXT    | nullable; `NULL` = **global default** for the key        |
| `key`              | TEXT    | flag name, e.g. `delta_updates`                          |
| `default_enabled`  | INTEGER | 0/1 — the fallback when no targeting rule matches        |
| `rollout_percent`  | INTEGER | 0..100 — stable per-device percentage rollout            |
| `allow_device_ids` | TEXT    | JSON array of device ids that are force-ON               |
| `deny_device_ids`  | TEXT    | JSON array of device ids that are force-OFF              |
| `allow_cohorts`    | TEXT    | JSON array of cohorts that are force-ON                  |
| `platforms`        | TEXT    | JSON array; empty = all platforms, else an allow-list    |
| `updated_at`       | INTEGER | last write (ms)                                          |
| `updated_by`       | TEXT    | actor that last wrote                                    |

`UNIQUE(app_id, key)`. A per-app row overrides the global (`app_id IS NULL`) row.

The migration seeds one `delta_updates` row per app from the existing
`apps.delta_updates_enabled` column, so behaviour before/after the migration is
identical.

## Evaluation precedence

`isFeatureEnabled(db, key, { appId, deviceId?, cohort?, platform? })`
(`worker/src/lib/feature_flags.ts`):

1. Load the row for `(app_id = appId, key)`. If none, load the global row
   (`app_id IS NULL, key`). If still none → **false** (fail-safe OFF).
2. Evaluate the row — **first match wins**:
   1. `deviceId ∈ deny_device_ids` → **false**
   2. `deviceId ∈ allow_device_ids` → **true**
   3. `cohort ∈ allow_cohorts` → **true**
   4. `platforms` non-empty and `platform` not listed (or unknown) → **false**
   5. `rollout_percent > 0` **and** we have a `deviceId`: stable bucket
      `fnv1a32(key + ':' + deviceId) % 100 < rollout_percent` → **true**
      (`>= 100` → always true). With no `deviceId`, rollout is skipped.
   6. else → `default_enabled === 1`

The rollout hash mirrors `rolloutBucket()` in `routes/public_v2.ts` (same FNV-1a
32-bit hash), so a device keeps a stable bucket as the percentage climbs.

The JSON array columns are parsed defensively (any parse error → `[]`), so a
malformed row degrades to "no targeting" rather than throwing. `evaluateFlag()`
is pure/synchronous and unit-testable in isolation.

## Delta: generation vs. offer split

Delta has **two** gates, deliberately separate:

- **Generation** (`routes/delta.ts`, `routes/releases.ts`) stays gated by
  `apps.delta_updates_enabled`. Generation happens at publish time and has **no
  device context**, so a per-device flag makes no sense there.
- **Offer** (`routes/public_v2.ts` `findDeltaPatch`) is gated by the
  `delta_updates` feature flag. This is per request, so it *does* have a device
  id + platform, enabling targeted rollout. When the gate is off, the update
  response simply omits the `patch` field and the client downloads the full APK.

So you can keep generating patches for an app (column ON) while only *offering*
them to your allow-listed test device (flag `allow_device_ids = [deviceId]`).

## Admin API

- `GET /api/apps/:appId/feature-flags/:key` (viewer) — returns the flag row, or
  a defaults object (`default_enabled: 0`, empty arrays) when none exists.
- `PUT /api/apps/:appId/feature-flags/:key` (admin) — upserts. Body (all
  optional; a partial PUT preserves untouched fields):
  ```json
  {
    "default_enabled": true,
    "rollout_percent": 25,
    "allow_device_ids": ["device-123"],
    "deny_device_ids": [],
    "allow_cohorts": [],
    "platforms": ["android"]
  }
  ```
  `rollout_percent` must be an integer 0..100; the array fields must be arrays of
  strings — otherwise `400`. Writes `updated_at` + `updated_by` and an
  `app.feature_flag.update` audit log.

## Recipe: enable delta for one test device

1. Keep generating patches for the app (leave `apps.delta_updates_enabled = 1`
   so publish produces delta assets).
2. Point the flag at just your device:
   ```
   PUT /api/apps/<appId>/feature-flags/delta_updates
   { "default_enabled": false, "allow_device_ids": ["<deviceId>"] }
   ```
   Only requests carrying `X-Hands-Device-Id: <deviceId>` (or `?device_id=`) get
   the `patch` field; every other device gets the full APK.
3. Validate the delta apply on that device, then widen: bump `rollout_percent`
   (e.g. `25`, then `100`) or set `default_enabled: true`.
