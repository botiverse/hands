# Hands Android Client Integration

A reference implementation showing an Android app how to
check for the latest APK version hosted on a Hands server and trigger a
download + install.

> ⚠️ This is reference code, not a published library. Drop the
> `build.hands.update` package into your codebase and adapt the package
> name + the endpoint base URL to match your deployment.

## What Hands exposes

```
GET /public/v2/apps/{slug}/updates/check?channel=main&product_type=android-apk&current_version_code=42&platform=android&arch=arm64-v8a
→ 200 {
    "app":         { "slug": "myapp-android", "platform": "android" },
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
| `UpdateChecker.kt`            | Public API — persistent status, idempotent check/install, and installer reopen |
| `HandsUpdateTransaction.kt`   | Stable states/status/events and authority-bound transaction persistence |
| `HandsClient.kt`              | Internal HTTP client (OkHttp + kotlinx.serialization) |
| `models/Version.kt`           | Wire-model for `/public/v2/apps/:slug/updates/check` response |
| `models/App.kt`               | Same, app metadata |
| `installer/ApkInstaller.kt`   | DownloadManager query/enqueue + read-only FileProvider installer launch |
| `MainActivity.kt.example`     | Reference Activity wiring UpdateChecker |

## Permission

Add to `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>
```

The SDK AAR contributes a non-exported `${applicationId}.hands.fileprovider`
with read-only cache and app-scoped external Downloads roots. Do not add a
world-readable APK path. The full and delta flows both launch the package
installer through this provider with read access only.

## Resume-safe host flow

Create one `UpdateChecker` for the same package/origin/app/channel authority and
pass the app-selected BCP-47 language tag explicitly. On page/lifecycle resume,
call `status()` and map every `HandsUpdateState` value. Keep `Install` enabled
for `ready_to_install` and `installer_opened`; calling `install()` or
`reopenPendingInstaller()` reopens the same verified APK and never downloads it
again. Show download progress only for `downloading`, and start a new check only
from `idle`, `failed`, `stale`, or `installed`.

`installed` is reported only after PackageManager's installed version reaches
the exact target. A user returning from the system installer without accepting
installation therefore remains able to press Install again instead of becoming
stuck in a host-owned "Installing" snapshot.

## Required dependencies

```kotlin
// build.gradle.kts (app module)
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
```
