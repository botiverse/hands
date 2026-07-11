# Hands Android Updater

Android SDK for Hands server-side update checks and APK installation.

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
    implementation("com.github.botiverse:hands:android-sdk-v0.10.2")
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
    implementation("build.hands:hands-android-sdk:0.10.2")
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

## Publish

Publish to GitHub Packages:

```bash
cd clients/android
GITHUB_ACTOR=<github-user> GITHUB_TOKEN=<token-with-packages-write> \
  gradle publish -PVERSION_NAME=0.10.2
```

In CI, push a tag `android-sdk-v<version>` (e.g. `android-sdk-v0.10.2`) — that
publishes to GitHub Packages and, on first request, builds the same version on
JitPack (`com.github.botiverse:hands:android-sdk-v<version>`). Or run the
`Publish Android SDK` workflow manually with a version input.
