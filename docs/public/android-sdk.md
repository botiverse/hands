---
title: "Android SDK"
description: "In-app update checks, staged rollouts, feedback, and crash reporting for Android."
category: "SDKs & API"
order: 10
---

# Android SDK

`build.hands:hands-android-sdk` is the Android SDK for Hands. It handles
in-app update checks and installation, staged-rollout device bucketing,
feedback submission, and crash reporting.

## Install

Consume the SDK from **JitPack (no token)** or from **GitHub Packages (needs a
`read:packages` token)** — the GitHub Packages Maven registry requires a token on
every request even for public packages, so JitPack is the simpler choice.

### JitPack — no token

```kotlin
// settings.gradle.kts or the module repositories block
repositories {
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation("com.github.botiverse:hands:android-sdk-v0.14.2")
}
```

### GitHub Packages — needs a `read:packages` token

```kotlin
repositories {
    maven {
        url = uri("https://maven.pkg.github.com/botiverse/hands")
        credentials {
            username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_ACTOR")
            password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
        }
    }
}

dependencies {
    implementation("build.hands:hands-android-sdk:0.14.2")
}
```

Configuration (`BuildConfig` fields are a convenient place to keep these):

| Value | Example |
|---|---|
| Base URL | `https://hands.build` |
| App slug | `raft-android` |
| Channel | `main` / `preview` / `nightly` / `debug` |

## Update checks and installation

`UpdateChecker` hits the public update-check endpoint, compares
`versionCode`, and (optionally) downloads + installs the APK.

```kotlin
val checker = UpdateChecker(
    context = applicationContext,
    baseUrl = BuildConfig.HANDS_BASE_URL,
    appSlug = BuildConfig.HANDS_APP_SLUG,
    installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.HANDS_CHANNEL,
    arch = Build.SUPPORTED_ABIS.firstOrNull(),
    // Pass the app-selected locale; the SDK never guesses system locale.
    languageTag = currentAppLanguageTag,
    eventListener = HandsUpdateEventListener(updateDiagnostics::append),
)

// Idempotent: checks only from a restartable state, waits for active work,
// and reopens the same verified APK after returning from the system installer.
val status = checker.install()
```

Call `checker.status()` on update-page/lifecycle resume and map the stable
lower-case states: `idle`, `checking`, `patching`, `downloading`,
`ready_to_install`, `installer_opened`, `failed`, `stale`, and `installed`.
`installed` is reached only after PackageManager observes the exact target
version. If the user returns without accepting the system installer, the state
remains installable; `reopenPendingInstaller()` reopens the same APK without a
duplicate download.

### Checking without installing

`checker.check()` asks Hands for an offer without starting anything. The
returned `HandsUpdateCheck.offer` has `versionName`, `versionCode`,
`releaseNotes` (the release's notes for the requested language, falling back
to English and then to the plain changelog), `downloadSizeBytes` (the patch
size when this device can apply the offered patch, else the full APK),
`fullSizeBytes`, `forceUpdate` and `releasedAt`; `status` is the current
transaction. Show the offer, then call `install()`. While an update is in
progress, `HandsUpdateStatus.releaseNotes` and `targetVersionName` keep the
same notes and version, so a page reopened later needs no new request.

```kotlin
val check = checker.check()
check.offer?.let { offer ->
    showUpdate(offer.versionName, offer.releaseNotes, offer.downloadSizeBytes)
}
```

### Progress, install permission and offline install

`checker.statusUpdates()` is a `Flow<HandsUpdateStatus>` for an update page.
It starts with the reconciled status, then follows every change made by any
`UpdateChecker` for the same app and channel. While a full APK downloads
(`downloading`) or a patch downloads (`patching`) it re-reads the status every
500 ms, so `status.progress` advances: `downloadedBytes`, `totalBytes` (null
when unknown), `percent`, and `paused` with a `pauseReason` such as
`waiting_for_network`. `status.targetVersionName` names the version being
installed.

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        checker.statusUpdates().collect { status ->
            when {
                status.errorCode == INSTALL_PERMISSION_REQUIRED -> showAllowInstallsPrompt()
                status.progress != null -> showProgress(status.progress)
                else -> render(status)
            }
        }
    }
}
```

When Android does not let the app install packages ("Install unknown apps"
is off), a verified download stays `ready_to_install` with `errorCode =
install_permission_required` instead of opening an installer that would be
blocked. Explain to the person that Android may restart the app after the
setting changes, start `checker.installPermissionSettingsIntent()`, and call
`checker.reopenPendingInstaller()` when the app is back in the foreground.
`checker.canInstallUpdates()` reports the current permission.

If the update check fails (offline, Hands unreachable) while a verified APK
is ready, `install()` reopens that APK instead of doing nothing.

The download notification is titled with the app's label and version. The
first `status()` call in a process removes finished SDK downloads whose
version is already installed, which also clears the system's lingering
"downloaded" notification. The completion receiver is registered on the
application context whichever context the checker was given.

The SDK persists a package/origin/app/channel/product/platform/architecture
bound transaction containing target/build/asset identity, DownloadManager id,
and the expected app-scoped file. It deliberately does not persist signed
download URLs or auth material. Resume reconciliation checks installed version,
DownloadManager, path ownership, file size, SHA-256 when supplied, exact APK
package/target version, and signing certificates. Missing, changed, or unsafe
inputs fail closed as `stale`/`failed` with a stable `errorCode`.

`HandsUpdateEventListener` receives structured check, delta download/apply/
validation/fallback, full-download, content-URI, installer, reconciliation,
failure, and cleanup events for inclusion in host feedback diagnostics; Logcat
is not the only telemetry path. Valid explicit BCP-47 `languageTag` values are
sent as `X-Hands-Lang` and `Accept-Language`. Missing/malformed values send
neither header, while unsupported languages retain the server's English
fallback. Events/status include requested and resolved language tags.

The `0.12.4` and newer AARs use 16 KB-compatible ELF `PT_LOAD` alignment for
the 64-bit native crash library. Publication verifies the AAR and its matching
unstripped native-symbols archive before either artifact is released.

The SDK sends a stable per-install id (`X-Hands-Device-Id`, from
`HandsDeviceId`; the server still accepts the legacy `X-Quiver-Device-Id`) so
the server can bucket the device for **staged rollouts**
— a release published at 25% only installs on the matching fraction of
devices, and each device keeps its bucket as you raise the percentage.

The SDK reports the first value from `Build.SUPPORTED_ABIS`. Hands prefers an
ABI-specific APK when one is published and otherwise falls back to a generic
universal APK (`arch: null`).

To check without installing (e.g. to render your own "update available" UI),
call `HandsClient(baseUrl).checkForUpdate(..., languageTag = ...)` and act on
the result.

### Java hosts

Every suspending call has a callback twin that delivers on the main thread:
`checkAsync`, `installAsync`, `statusAsync`, `reopenPendingInstallerAsync`,
and `observeStatus(listener)` for `statusUpdates()`. Each returns a
`Closeable`; close it to cancel (closing `installAsync` stops waiting, not the
update). The constructor has Java overloads for its defaulted parameters.

```java
UpdateChecker checker = new UpdateChecker(context, "https://hands.build", "my-app", BuildConfig.VERSION_CODE, "main");
checker.checkAsync((check, error) -> {
    if (check != null && check.getOffer() != null) showUpdate(check.getOffer());
});
Closeable watching = checker.observeStatus(status -> render(status));
```

## Feedback

`HandsFeedback` submits user feedback (with attachments) to the Hands
ticket system; it auto-attaches app/device metadata and the device id.

```kotlin
val ticketId = HandsFeedback(
    context = applicationContext,
    baseUrl = BuildConfig.HANDS_BASE_URL,
    appSlug = BuildConfig.HANDS_APP_SLUG,
    versionName = BuildConfig.VERSION_NAME,
    versionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.HANDS_CHANNEL,
    clientKey = BuildConfig.HANDS_CLIENT_KEY,   // app Settings → Client key
).submit(
    message = "Feed doesn't refresh after login.",
    kind = "bug",                       // "feedback" | "bug" | "crash"
    contact = "user@example.com",       // optional
    attachments = listOf(screenshot),   // up to 9 files, 200 MB each (large files upload directly to storage via presigned URLs)
)
```

Tickets appear in the app's **Feedback** tab and are triageable from the
admin console or the CLI (`hands feedback ...`).

## Crash reporting

`Hands.install(...)` captures uncaught JVM exceptions and NDK/native
crashes and uploads them as `kind=crash` tickets, grouped by signature and
symbolicated in the console.

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Hands.install(
            context = this,
            baseUrl = BuildConfig.HANDS_BASE_URL,
            appSlug = BuildConfig.HANDS_APP_SLUG,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            channel = BuildConfig.HANDS_CHANNEL,
            clientKey = BuildConfig.HANDS_CLIENT_KEY,
            // optional: attach app-specific context (recent logs, etc.)
            extraContext = { myDiagnostics.recentText() },
        )
    }
}
```

To get readable (deobfuscated) stacks in the console, publish the release
with its R8/ProGuard `mapping.txt` (and, for NDK crashes, the unstripped
`.so` archive) — Hands symbolicates crash reports for that `versionCode`
automatically. Once a Java/Kotlin crash is deobfuscated, Hands regroups it by the
deobfuscated exception class and first frame (skipping throw helpers such as
`throwIllegalArgumentException`), so one bug stays in one group across builds;
crash alerts for those builds wait for this before announcing a group. QNC2 native reports preserve the crashing thread's PC/LR/SP,
registers, thread identity, and loaded-image ELF BuildIds. Symbolication is
strictly fail-closed: the crash frame's BuildId must exactly match an ELF in
the uploaded archive; Hands never guesses by version or filename. On Android
11+ the SDK also attaches the matching `ApplicationExitInfo` trace and exit
description when the OS retained them, providing the sanctioned
tombstone/abort-message equivalent without reading `/data/tombstones`. The
match requires the recorded process id, native-crash reason, and a narrow
timestamp window; retained evidence is assigned one-to-one and persisted for
deterministic retry rather than guessed from the nearest package exit.

### One ticket per crashed process

Since `0.13.2`, every native crash record carries the crashed process's
`HandsNativeCrash.processEventId` (a random UUID per process) and
`processStartAt` (epoch ms), and is uploaded with that id as its
`submission_id`. An app that also files its own report for the same process
exit (for example from `ApplicationExitInfo`) should store both values with its
launch record and send its report under the same id:

```kotlin
// at launch
launchLog.save(pid = Process.myPid(), eventId = HandsNativeCrash.processEventId,
               startedAt = HandsNativeCrash.processStartAt)

// later, reporting that process's exit
HandsFeedback(context, baseUrl, appSlug, clientKey = key).submitReport(
    message = "Process exited: ${exit.reason}",
    kind = "crash",
    extras = exitFields,
    submissionId = launch.eventId,
)
```

Whichever report arrives second is merged into the first ticket: the native
record decides the crash type and grouping signature, the exit report's fields
are kept alongside, and values that disagree are preserved under the ticket's
`crash_merge` metadata. A ticket auto-closed as a background system kill
reopens when the native record shows it was a real crash.

Since `0.14.2`, `HandsNativeCrash.install(context)` also records the
process's version name and code, so a native crash ticket names the build that
crashed even when a newer install uploads it. Records left by a process that
ran an older SDK have no build; their ticket's version stays empty (Hands fills
it from the app's exit report when that report is merged in).

`HandsNativeCrash.uploadPending(...)` returns one `NativeCrashUpload` per
record: `UPLOADED` (with `ticketId`), `MERGED` (`ticketId` is null for
anonymous clients), `FAILED_WILL_RETRY` (the record is kept), or `DISCARDED`
(unreadable or over the retention limit). Each carries `pid`,
`processStartAt`, `processEventId`, `crashAt`, and the matched
`exitTimestamp`; records written before 0.13.2 have no process id or start
time.

### ANRs

Since `0.13.0`, on Android 11+ (API 30) the SDK also reports ANRs
(Application Not Responding kills). The system kills the process from outside,
so nothing runs in-process; on the next launch the SDK reads
`ApplicationExitInfo` entries with `REASON_ANR` and submits selected entries as
`kind=crash` tickets with `crash_type=anr`. The system ANR thread dump is
attached (and R8-retraced like a Java crash log). The ticket is grouped as
`ANR@<first app frame on the main thread>`, so the same freeze clusters
across builds and never merges with a Java exception on the same frame. The
console's Crashes page can filter by type (Exceptions / Native / ANRs).

A persisted watermark advances after the server accepts a ticket, so a failed
upload retries on the next launch. A permanent client rejection is skipped; an
accepted response lost before the watermark advances can result in a duplicate.
The first launch with this SDK looks back 7 days, and at most 3 of the newest
ANRs are sent per launch; older exits beyond the cap are skipped when the
watermark advances. Pass `captureAnrs = false` to `Hands.install(...)` to opt
out. Below API 30 this is a no-op.

On Android 11+, when ANR capture is enabled, `HandsCrash.install` records the
installed package's version in Android's 128-byte process-state summary. Call
`Hands.install` early in the reporting process. For coverage before content
providers start, or in a process that does not run the uploader, call
`HandsCrash.stampAnrBuild` as early as `Application.attachBaseContext`:

```kotlin
override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    HandsCrash.stampAnrBuild(base)
}
```

This early call only writes the process summary; it does not install a crash
handler or start an uploader. Run the uploader from one process only: Android's
process-local preference caches do not provide cross-process coordination, and
multiple uploaders can duplicate reports. An ANR before stamping, or in a
process that never stamps, may have no version. Each ticket reads its own exit
record; old, missing, invalid or overwritten summaries leave the build unknown
rather than using the uploading install's version. If a version name does not
fit, Hands records the exact version code only; it never submits a truncated
name. Normal-length `raft-build:1` summaries from Raft's temporary reporter are
understood as well. This does not change previously filed tickets.

Android exposes **one shared summary slot per process**. A later caller can
replace the Hands stamp, and Hands would replace an earlier caller's summary.
Apps already using the slot should disable stamping before either the early
stamp call or Hands installation in each process (ANR reporting remains enabled):

```kotlin
HandsCrash.setAnrBuildStampingEnabled(false)
Hands.install(/* ... */)
```

Do not enable the SDK ANR uploader and a separate app ANR reporter at the same
time. The existing Hands watermark remains in use. Coordinate any handoff:
independently persisted reporter watermarks and a lost server response can
still cause duplicate tickets after a restart; this is not exactly-once delivery.
`channel`, manifest build commit, and device metadata are read by the uploading
process, not restored from the historical exit; they are not evidence of the
ANR's original build.

## Release health

`Hands.install(...)` tracks foreground sessions automatically. A session ends
after the app has remained in the background for 30 seconds; a quick activity
or configuration transition stays within the same session. Start/end/crash
events are committed on-device before delivery and retried after a network or
process failure.

The app overview uses these events to show crash-free sessions and crash-free
devices by version and channel. Pass `trackSessions = false` to
`Hands.install` only when the host app intentionally opts out of release-health
telemetry.

## Deferring uploads

An app that must not send anything until it knows reporting is allowed (for
example a privacy mode set by the user's server) still installs at launch, so
crashes are captured, and turns the launch-time network off:

```kotlin
Hands.install(
    context = this,
    baseUrl = "https://hands.build",
    appSlug = "my-app",
    uploadOnLaunch = false,         // keep crash and ANR reports on the device
    reportDeviceAnalytics = false,  // no launch ping
    trackSessions = false,          // release-health sessions send as they happen
)
```

Once reporting is allowed, upload from a background thread with the same
arguments:

```kotlin
HandsCrash.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)
HandsAnr.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)      // 0.13.3+, suspend
HandsNativeCrash.uploadPending(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey) // suspend
HandsAnalytics.reportDevice(context, baseUrl, appSlug, versionName, versionCode, channel, clientKey)    // suspend
```

Reports wait on the device under the usual retention limits (the five most
recent JVM crashes; ANRs from the system exit history, seven days back on
first use).

## Device analytics

`Hands.install(...)` already sends a lightweight launch/install metrics ping (throttled
to ≤1/day/install) that powers the console's active-device and
version-distribution views — no separate call needed. This is not a true
online heartbeat. No PII: only the random per-install device id and build/OS
metadata. Pass
`reportDeviceAnalytics = false` to `Hands.install` to opt out.

## Notes

- All network calls are suspend functions; call them off the main thread.
- The device id is a random UUID in SharedPreferences, not a hardware id; it
  resets on reinstall/clear-data, which is fine for rollout cohorting.
- The client key (`qk_…`) authenticates feedback/crash submissions. It ships
  inside the APK (Sentry-DSN model — app identifier, not a user secret); get
  it from the app's Settings tab and put it in `BuildConfig`.
