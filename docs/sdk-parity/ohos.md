# OHOS SDK inventory (`@botiverse/hands`)

Source: `clients/ohos/hands` (all ArkTS read 2026-07-09).

**Version drift (P1.6):** `oh-package.json5` `0.2.0` vs reported
`QUIVER_SDK_VERSION = 0.1.0` — tickets claim 0.1.0 regardless of package
bump.

Positioning note: this SDK is a feedback + crash-ticket client mirroring the
Android classes; crashes are delivered as feedback tickets (`kind=crash`).

## Present

- **ArkTS/JS crashes** — `errorManager.on('error')` uncaught-error capture;
  store-then-send (`filesDir/crashes`, retention 5, upload next launch,
  deferred 3 s).
- **Crash/feedback context** — device (manufacturer/model/brand/marketName/
  deviceType), OS/API, bundle version, arch, locale, timezone, screen, disk,
  battery, per-install device id.
- **Feedback** — multipart tickets, ≤9 attachments; ≤10 MB inline; presigned
  R2 PUT above that, **hard cap 50 MB** (whole file read into ArrayBuffer —
  OOM risk, lower than the 200 MB Android/iOS support).
- **Device analytics** — 24h-throttled `/metrics` ping.

## Absent (→ roadmap)

- **Native crash capture — none** (no `faultLogger`/`hiAppEvent`) (P1.3)
- Symbolication entirely — raw ArkTS stack text only, no sourcemaps
- Breadcrumbs (P0.3); `captureException` (P0.2); sessions (P0.1)
- Performance monitoring (P2.2)
- **Update checking — none** (prefs store is even named `quiver_update`,
  but no check API exists)
- Log capture; retry/backoff (failed feedback submit just throws); sampling
- Streaming attachment upload (fix the 50 MB / OOM limitation)

## Config surface

`Hands.install(config, context?)` — `HandsConfig = { baseUrl, appSlug,
channel, clientKey }`. Everything else hardcoded (no hooks, no toggles).
