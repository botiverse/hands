# OHOS SDK inventory (`@botiverse/hands`)

Source: `clients/ohos/hands` (ArkTS and release contract read 2026-07-30).

The package and runtime `hands_sdk` metadata share one `0.3.3` release
constant, covered by a host-side parity test.

Positioning note: this SDK is a feedback + crash-ticket client mirroring the
Android classes; crashes are delivered as feedback tickets (`kind=crash`).

## Present

- **ArkTS/JS crashes** — `errorManager.on('error')` uncaught-error capture;
  store-then-send (`filesDir/crashes`, retention 5, upload next launch,
  deferred 3 s).
- **Native crash / freeze capture** — system `hiAppEvent` `APP_CRASH` and
  `APP_FREEZE` watcher, including bounded reads of the full FaultLogger file
  for server symbolication. Existing crash directories are accepted, events
  are isolated per item, and filenames are collision-resistant.
- **Handled errors + breadcrumbs** — `Hands.captureException` and a bounded
  `Hands.addBreadcrumb` ring.
- **Crash/feedback context** — device (manufacturer/model/brand/marketName/
  deviceType), OS/API, bundle version, arch, locale, timezone, screen, disk,
  battery, per-install device id.
- **Feedback** — multipart tickets, ≤9 attachments; ≤10 MB inline; presigned
  R2 PUT above that, **hard cap 50 MB** (whole file read into ArrayBuffer —
  OOM risk, lower than the 200 MB Android/iOS support).
- **Device analytics** — 24h-throttled `/metrics` ping.

## Absent (→ roadmap)

- ArkTS sourcemap symbolication and full session tracking
- Performance monitoring (P2.2)
- **Update checking — none** (prefs store is even named `quiver_update`,
  but no check API exists)
- Log capture; retry/backoff (failed feedback submit just throws); sampling
- Streaming attachment upload (fix the 50 MB / OOM limitation)

## Config surface

`Hands.install(config, context?)` — `HandsConfig = { baseUrl, appSlug,
channel, clientKey }`. Pass the `UIAbilityContext` to enable device analytics,
crash observers, system-fault intake, and pending-crash upload.
