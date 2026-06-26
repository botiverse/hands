# quiver Android Client Integration

A reference implementation showing Slock Android (or any Android app) how to
check for the latest APK version hosted on a quiver server and trigger a
download + install.

> ⚠️ This is reference code, not a published library. Drop the
> `io.quiver.update` package into your codebase and adapt the package
> name + the endpoint base URL to match your deployment.

## What quiver exposes

```
GET /public/apps/{slug}/latest?channel=production
→ 200 {
    "app":         { "slug": "slock-android", "platform": "android" },
    "version": {
      "id":              "...",
      "version_name":    "1.2.3",
      "version_code":    42,
      "package_name":    "com.bytemain.slock",
      "signature_sha256": "abcd…",
      "min_sdk":         24,
      "target_sdk":      34,
      "size_bytes":      12345678,
      "file_hash":       "deadbeef…",
      "enabled":         1,
      "created_at":      1719379200000
    },
    "download_url":  "https://r2…/apps/…/binary.apk?…",
    "expires_in":    3600
  }
→ 404 if app not found or no enabled version for that channel
```

The endpoint is **public** — no auth needed. `download_url` is a signed R2 URL
that expires in `expires_in` seconds.

## Files

| File | Purpose |
|---|---|
| `UpdateChecker.kt`            | Public API — high-level "check + download + install" entry point |
| `QuiverClient.kt`             | Internal HTTP client (OkHttp + kotlinx.serialization) |
| `models/Version.kt`           | Wire-model for `/public/apps/:slug/latest` response |
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