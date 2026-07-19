# Hands Android Updater

Android SDK for Hands server-side update checks and APK installation.

`Hands.install(...)` also enables crash capture, daily device analytics, and
release-health session tracking by default. Session start/end/crash events are
queued on-device and retried after network or process failures; set
`trackSessions = false` only when the host app intentionally opts out.

## Coordinates

Two ways to consume the SDK. **JitPack needs no token** — prefer it unless you
already have GitHub Packages set up. (GitHub Packages' Maven registry requires a
`read:packages` token for every request, even though the package is public.)

### JitPack (no token)

```kotlin
repositories {
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation("com.github.botiverse:hands:android-sdk-v0.11.0")
}
```

### GitHub Packages (needs a `read:packages` token)

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
    implementation("build.hands:hands-android-sdk:0.11.0")
}
```

## Usage

```kotlin
val checker = UpdateChecker(
    context = applicationContext,
    baseUrl = "https://hands.build",
    appSlug = "myapp-android",
    installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
    channel = "main",
    arch = "arm64-v8a",
)

val result = checker.checkAndInstall()
if (!result.update_available) {
    // Already current.
}
```

The SDK calls:

```text
GET /public/v2/apps/{slug}/updates/check
```

The server resolves release scope, rollout, version comparison, and APK asset selection.

## Native symbols (for crash symbolication)

The AAR ships a stripped `libhandscrash.so`. Release pipelines that report
native crashes to Hands need the matching unstripped library, published as the
`native-symbols` Maven classifier on the same version (GitHub Packages):

```text
https://maven.pkg.github.com/botiverse/hands/build/hands/hands-android-sdk/<version>/hands-android-sdk-<version>-native-symbols.zip
```

The zip contains `<abi>/libhandscrash.so` (unstripped, with `.debug_info`) for
`arm64-v8a`, `armeabi-v7a`, `x86_64`, plus a `manifest.json` with the per-ABI
Build ID and SHA-256. Verify each Build ID against the `.so` inside your APK
before uploading the zip to Hands (`hands builds publish-android --symbols`);
treat a missing or mismatched classifier as a release blocker. Published since
`0.11.1`.

The classifier is also served by JitPack, but **AAR and classifier must come
from the same channel**: JitPack rebuilds from source, so its Build IDs differ
from the GitHub Packages build of the same tag. Never mix a JitPack AAR with a
GitHub Packages classifier (or vice versa) — the Build ID check exists exactly
to catch that.

## Release

Push a tag `android-sdk-v<version>` (e.g. `android-sdk-v0.11.0`). That publishes to
GitHub Packages (`build.hands:hands-android-sdk:<version>`, including the
`native-symbols` classifier) and, on the first
request, builds the same version on JitPack
(`com.github.botiverse:hands:android-sdk-v<version>`) — so both channels stay in
sync from one tag. Or run the `Publish Android SDK` workflow manually.
