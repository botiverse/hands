# Android SDK

`io.quiver:quiver-android-updater` is the Android SDK for Quiver. It handles
in-app update checks and installation, staged-rollout device bucketing,
feedback submission, and crash reporting.

## Install

The SDK is published to GitHub Packages.

```kotlin
// settings.gradle.kts or the module repositories block
repositories {
    maven {
        url = uri("https://maven.pkg.github.com/oranix-io/quiver")
        credentials {
            username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_ACTOR")
            password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
        }
    }
}

dependencies {
    implementation("io.quiver:quiver-android-updater:0.9.0")
}
```

Configuration (`BuildConfig` fields are a convenient place to keep these):

| Value | Example |
|---|---|
| Base URL | `https://quiver.oranix.io` |
| App slug | `raft-android` |
| Channel | `main` / `preview` / `nightly` / `debug` |

## Update checks and installation

`UpdateChecker` hits the public update-check endpoint, compares
`versionCode`, and (optionally) downloads + installs the APK.

```kotlin
val checker = UpdateChecker(
    context = applicationContext,
    baseUrl = BuildConfig.QUIVER_BASE_URL,
    appSlug = BuildConfig.QUIVER_APP_SLUG,
    installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.QUIVER_CHANNEL,
    arch = Build.SUPPORTED_ABIS.firstOrNull(),
)

// suspending; returns the response even when no update is available
val response = checker.checkAndInstall()
```

The SDK sends a stable per-install id (`X-Quiver-Device-Id`, from
`QuiverDeviceId`) so the server can bucket the device for **staged rollouts**
— a release published at 25% only installs on the matching fraction of
devices, and each device keeps its bucket as you raise the percentage.

To check without installing (e.g. to render your own "update available" UI),
call `QuiverClient(baseUrl).checkForUpdate(...)` and act on the result.

## Feedback

`QuiverFeedback` submits user feedback (with attachments) to the Quiver
ticket system; it auto-attaches app/device metadata and the device id.

```kotlin
val ticketId = QuiverFeedback(
    context = applicationContext,
    baseUrl = BuildConfig.QUIVER_BASE_URL,
    appSlug = BuildConfig.QUIVER_APP_SLUG,
    versionName = BuildConfig.VERSION_NAME,
    versionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.QUIVER_CHANNEL,
    clientKey = BuildConfig.QUIVER_CLIENT_KEY,   // app Settings → Client key
).submit(
    message = "Feed doesn't refresh after login.",
    kind = "bug",                       // "feedback" | "bug" | "crash"
    contact = "user@example.com",       // optional
    attachments = listOf(screenshot),   // up to 9 files, 200 MB each (large files upload directly to storage via presigned URLs)
)
```

Tickets appear in the app's **Feedback** tab and are triageable from the
admin console or the CLI (`quiver feedback ...`).

## Crash reporting

`Quiver.install(...)` captures uncaught JVM exceptions and NDK/native
crashes and uploads them as `kind=crash` tickets, grouped by signature and
symbolicated in the console.

```kotlin
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Quiver.install(
            context = this,
            baseUrl = BuildConfig.QUIVER_BASE_URL,
            appSlug = BuildConfig.QUIVER_APP_SLUG,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE.toLong(),
            channel = BuildConfig.QUIVER_CHANNEL,
            clientKey = BuildConfig.QUIVER_CLIENT_KEY,
            // optional: attach app-specific context (recent logs, etc.)
            extraContext = { myDiagnostics.recentText() },
        )
    }
}
```

To get readable (deobfuscated) stacks in the console, publish the release
with its R8/ProGuard `mapping.txt` (and, for NDK crashes, the unstripped
`.so` archive) — Quiver symbolicates crash reports for that `versionCode`
automatically.

## Device analytics

`Quiver.install(...)` already sends a lightweight launch/install metrics ping (throttled
to ≤1/day/install) that powers the console's active-device and
version-distribution views — no separate call needed. This is not a true
online heartbeat. No PII: only the random per-install device id and build/OS
metadata. Pass
`reportDeviceAnalytics = false` to `Quiver.install` to opt out.

## Notes

- All network calls are suspend functions; call them off the main thread.
- The device id is a random UUID in SharedPreferences, not a hardware id; it
  resets on reinstall/clear-data, which is fine for rollout cohorting.
- The client key (`qk_…`) authenticates feedback/crash submissions. It ships
  inside the APK (Sentry-DSN model — app identifier, not a user secret); get
  it from the app's Settings tab and put it in `BuildConfig`.
