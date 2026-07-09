# Android SDK inventory (`build.hands:hands-android-sdk`)

Source: `clients/android` (all Kotlin read 2026-07-09). minSdk 24, hand-rolled
(okhttp 4.12, kotlinx-serialization/coroutines) — no third-party crash SDK.
Native lib `handscrash` (CMake, arm64-v8a/armeabi-v7a/x86_64).

**Version drift (P1.6):** Gradle `0.1.0-SNAPSHOT` default vs README `0.4.0`
vs `HandsFeedback.SDK_VERSION = 0.9.0` (the value actually reported in
ticket metadata).

## Present

- **JVM crashes** — `HandsCrash.install()` chains the prior default handler;
  writes structured log + `.meta.json` to `<externalFilesDir>/crashes/`;
  no network in the dying process; uploaded on next launch; retention 5.
- **Native crashes** — signal handlers (ILL/TRAP/ABRT/BUS/FPE/SEGV) write an
  async-signal-safe `.qnc` record (signal, fault addr, raw PC frames,
  `/proc/self/maps`); PC→module-offset resolution Kotlin-side next launch.
  Custom minimal format, not minidump/breakpad.
- **Crash context (rich)** — device/OS/app version, per-install device id,
  all-threads stack dump, JVM heap + PSS, RAM/low-memory, FD count/targets,
  process uptime, logcat tail (200 lines/20 KB), optional `extraContext`
  lambda + `extras` map. Feedback adds locale/timezone/arch/emulator/screen/
  disk/battery/thermal/commit.
- **Feedback** — `HandsFeedback.submit()` multipart; ≤9 attachments; ≤10 MB
  inline, ≤200 MB via presigned R2 PUT. No built-in UI/auto-screenshot.
- **Device analytics** — `HandsAnalytics.reportDevice()`, 24h-throttled ping
  to `/public/v2/apps/{slug}/metrics`.
- **Update checking (flagship)** — `UpdateChecker.checkAndInstall()`:
  staged-rollout hash bucketing, force_update, changelog, DownloadManager +
  installer intent (`REQUEST_INSTALL_PACKAGES`).
- **Offline durability** — crashes disk-buffered, retried next launch.

## Absent (→ roadmap)

- ANR detection (P1.1); coroutine-exception integration
- Breadcrumbs (P0.3) — logcat tail is the only stand-in
- `captureException` handled errors (P0.2)
- Session start/end → crash-free rate (P0.1)
- All performance monitoring (P2.2: app-start + ANR rate only)
- Sampling / client rate limits; first-class user-id/tags API
- Mapping upload is CLI-side (`hands builds publish-android --mapping`), not
  SDK-side — acceptable, document it.

## Config surface

`Hands.install(context, baseUrl, appSlug, versionName?, versionCode?,
channel?, clientKey?, copyToClipboard, uploadOnLaunch, captureNativeCrashes,
reportDeviceAnalytics, extraContext?)`; `UpdateChecker` and `HandsFeedback`
constructed separately.
