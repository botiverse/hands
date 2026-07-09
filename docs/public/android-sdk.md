# Android SDK

`build.hands:hands-android-sdk` is the Android SDK for Hands. It handles
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
    implementation("build.hands:hands-android-sdk:0.9.0")
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
    baseUrl = BuildConfig.HANDS_BASE_URL,
    appSlug = BuildConfig.HANDS_APP_SLUG,
    installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = BuildConfig.HANDS_CHANNEL,
    arch = Build.SUPPORTED_ABIS.firstOrNull(),
)

// suspending; returns the response even when no update is available
val response = checker.checkAndInstall()
```

The SDK sends a stable per-install id (`X-Hands-Device-Id`, from
`HandsDeviceId`; the server still accepts the legacy `X-Quiver-Device-Id`) so
the server can bucket the device for **staged rollouts**
— a release published at 25% only installs on the matching fraction of
devices, and each device keeps its bucket as you raise the percentage.

To check without installing (e.g. to render your own "update available" UI),
call `HandsClient(baseUrl).checkForUpdate(...)` and act on the result.

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
automatically.

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
