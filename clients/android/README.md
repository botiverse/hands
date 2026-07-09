# Quiver Android Updater

Android SDK for Quiver server-side update checks and APK installation.

## Coordinates

```kotlin
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
    implementation("build.hands:hands-android-updater:0.4.0")
}
```

## Usage

```kotlin
val checker = UpdateChecker(
    context = applicationContext,
    baseUrl = "https://quiver.oranix.io",
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
  gradle publish -PVERSION_NAME=0.1.0
```

In CI, use the `Publish Android SDK` workflow and a version such as `0.1.0`.
