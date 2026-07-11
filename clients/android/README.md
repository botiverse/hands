# Hands Android Updater

Android SDK for Hands server-side update checks and APK installation.

## Coordinates

Pulled from JitPack — no token, no registry credentials.

```kotlin
repositories {
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation("com.github.botiverse:hands:android-sdk-v0.10.2")
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

## Release

Push a tag `android-sdk-v<version>` (e.g. `android-sdk-v0.10.2`). JitPack builds
that tag on the first request for it, so consumers can immediately pull
`com.github.botiverse:hands:android-sdk-v<version>` — no publish step or token
needed.
