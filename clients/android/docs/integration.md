# quiver Android Client Integration

A reference implementation showing Slock Android (or any Android app) how to
check for the latest APK version hosted on a quiver server and trigger a
download + install.

> ⚠️ This is reference code, not a published library. Drop the
> `io.quiver.update` package into your codebase and adapt the package
> name + the endpoint base URL to match your deployment.

## What quiver exposes

```
GET /public/v2/apps/{slug}/updates/check?channel=main&product_type=android-apk&current_version_code=42&platform=android&arch=arm64-v8a
→ 200 {
    "app":         { "slug": "slock-android", "platform": "android" },
    "channel":     "main",
    "current_version_code": 42,
    "update_available": true,
    "latest": {
      "build_id":      "...",
      "version":       "1.2.3",
      "version_code":  43,
      "changelog":     "Bug fixes",
      "force_update":  false,
      "released_at":   1719379200000
    },
    "asset": {
      "platform":     "android",
      "arch":         "arm64-v8a",
      "variant":      null,
      "filetype":     "apk",
      "size_bytes":   12345678,
      "signature":    "abcd…",
      "download_url": "https://r2…/apps/…/binary.apk?…"
    },
    "expires_in":    3600
  }
→ 200 { "update_available": false, ... } if the installed version is current
→ 404 if app/channel/release/scope/compatible asset is not found
```

The endpoint is **public** — no auth needed. The server resolves release scope,
rollout, version comparison, and APK asset selection. `download_url` is a signed
R2 URL that expires in `expires_in` seconds.

## Files

| File | Purpose |
|---|---|
| `UpdateChecker.kt`            | Public API — high-level "check + download + install" entry point |
| `QuiverClient.kt`             | Internal HTTP client (OkHttp + kotlinx.serialization) |
| `models/Version.kt`           | Wire-model for `/public/v2/apps/:slug/updates/check` response |
| `models/App.kt`               | Same, app metadata |
| `installer/ApkInstaller.kt`   | DownloadManager + Intent.ACTION_INSTALL_PACKAGE |
| `MainActivity.kt.example`     | Reference Activity wiring UpdateChecker |

## Permission

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>
```

For Android 8+, you also need a FileProvider for `ACTION_VIEW` flows (not used
here — we use `ACTION_INSTALL_PACKAGE` directly via DownloadManager).

## Required dependencies

```kotlin
// build.gradle.kts (app module)
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
```
