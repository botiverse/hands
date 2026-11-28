# Hands Android Updater

Android SDK for Hands server-side update checks and APK installation.

`Hands.install(...)` also enables crash capture, daily device analytics, and
release-health session tracking by default. Session start/end/crash events are
queued on-device and retried after network or process failures; set
`trackSessions = false` only when the host app intentionally opts out.

## Coordinates

The canonical `build.hands:hands-android-sdk` publication is public on Raft
Artifacts and needs no download token. JitPack remains available as a
source-build fallback. GitHub Packages requires a `read:packages` token for
every request even though the package is public.

### Raft Artifacts (preferred, no token)

```kotlin
repositories {
    maven { url = uri("https://maven.artifacts.botiverse.dev") }
}

dependencies {
    implementation("build.hands:hands-android-sdk:0.15.0")
}
```

### JitPack (no token)

```kotlin
repositories {
    maven { url = uri("https://jitpack.io") }
}

dependencies {
    implementation("com.github.botiverse:hands:android-sdk-v0.15.0")
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
    implementation("build.hands:hands-android-sdk:0.15.0")
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
    // Explicit host-selected locale; the SDK never guesses the system locale.
    languageTag = "zh-CN",
    eventListener = HandsUpdateEventListener { event ->
        // Persist in the host's diagnostics/feedback log if desired.
        hostUpdateLog.append(event)
    },
)

// Idempotent command: starts a check only from idle/failed/stale/installed,
// waits during active work, and reopens the same verified APK when ready.
val status = checker.install()
when (status.state) {
    HandsUpdateState.DOWNLOADING -> showDownloading()
    HandsUpdateState.READY_TO_INSTALL,
    HandsUpdateState.INSTALLER_OPENED -> showInstallEnabled()
    HandsUpdateState.INSTALLED -> showDone()
    else -> render(status)
}
```

Call `checker.status()` whenever the update page or process resumes. It
reconciles the persisted transaction against PackageManager, DownloadManager,
and the SDK-owned APK file. `checker.reopenPendingInstaller()` opens the same
verified file without another network request. Missing/unsafe files, target
drift, exact version mismatch, hash mismatch (when the server supplied one), or
signer/package mismatch fail closed as `stale`/`failed` with a stable
`errorCode`.

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

### Preparing an update in the background

`checker.prepare()` (0.15.1+) does the same check, patch or download and
verification as `install()`, but stops at `ready_to_install` without opening the
system installer. Use it for background pre-download, for example only on
unmetered Wi-Fi (the host decides when to call it). When the person chooses to
update, call `checker.reopenPendingInstaller()` (or `install()`) to open the
installer for the same verified APK. If the person taps install while a prepared
full download is still running, the installer opens when it finishes. A full
download still shows DownloadManager's notification, and a patch interrupted by
process death is recovered by `status()` as usual. Java hosts use
`prepareAsync`.

If the update check fails (offline, Hands unreachable) while a verified APK
is ready, `install()` reopens that APK instead of doing nothing.

The download notification is titled with the app's label and version. The
first `status()` call in a process removes finished SDK downloads whose
version is already installed, which also clears the system's lingering
"downloaded" notification. The completion receiver is registered on the
application context whichever context the checker was given.

The persisted transaction is bound to package, Hands origin, app slug,
channel, product, platform, and architecture. It stores target/build/asset
identity, DownloadManager id, and an app-scoped path; it never stores the signed
download URL or an auth secret. Structured `HandsUpdateEvent` records cover
check, patch download/apply/validation/fallback, full download, content URI,
installer open/reopen, resume state changes, failures, and cleanup so hosts can
include the chain in Hands feedback rather than relying on Logcat alone.

Delta patches only rebuild the new APK if the device recompresses every entry
exactly as the server did. Android 12 and newer ship a different zlib, so
before `0.14.4` deltas on those devices failed their SHA-256 check
(`patch_fallback` / `sha256_mismatch`) and fell back to the full APK. Since
`0.14.4` the SDK recompresses with its own copy of stock zlib 1.3.1, built
into `libhandscrash.so`. Before downloading a patch it checks that this copy
gives the expected output; if it does not, or the native library cannot load,
it emits `patch_fallback` with `deflater_incompatible` and downloads the full
APK.

Since `0.15.0` the SDK also applies xz-compressed patches
(`archive-patcher-v1+xz`, about 30% smaller than gzip) and declares the
algorithms it supports in `X-Hands-Delta-Algorithms`; Hands then offers the
smallest supported patch. Older SDKs send no header and keep receiving gzip
patches. A patch whose xz header cannot be read emits `patch_fallback` with
`patch_decompress_failed`, and any algorithm the SDK does not know falls back
to the full APK.

Since `0.16.0` the SDK also applies `archive-patcher-zucchini-v1+xz` patches:
the same archive-patcher container, but the delta between the uncompressed
APK contents is a Zucchini patch (Chromium's patcher, which understands DEX and
native code) instead of bsdiff. For a typical app update this patch is about
40% smaller than the xz patch. The applier is compiled into
`libhandscrash.so`; the SDK declares the algorithm only when that library
loads. Applying needs about four to five times the APK size of free space in the cache
directory and maps the files into memory rather than the Java heap. Any
failure, including a corrupt patch, emits `patch_fallback` with
`patch_apply_failed` and downloads the full APK.

`0.15.0` also recovers from a process killed while a patch downloads or
applies: the next status read or install treats the left-over `patching`
transaction as interrupted (`stale`, `patch_interrupted`), deletes the
partial patch and APK from the cache, and the next install starts over.
Before, the update stayed on `patching` until the 30-minute patch timeout.

`languageTag` is an explicit BCP-47 tag. Valid values are sent as both
`X-Hands-Lang` and `Accept-Language`; missing or malformed values send neither
header, and unsupported values retain the server's English fallback.

The SDK calls:

```text
GET /public/v2/apps/{slug}/updates/check
```

The server resolves release scope, rollout, version comparison, and APK asset selection.

### Java hosts

Every suspending call has a callback twin that delivers on the main thread:
`checkAsync`, `installAsync`, `prepareAsync`, `statusAsync`, `reopenPendingInstallerAsync`,
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

Since `0.12.4`, the 64-bit crash library uses 16 KB-compatible ELF `PT_LOAD`
alignment. CI checks both the packaged AAR and the matching unstripped symbols
archive so a 4 KB-only native binary cannot be published silently.

The classifier is also served by JitPack, but **AAR and classifier must come
from the same channel**: JitPack rebuilds from source, so its Build IDs differ
from the GitHub Packages build of the same tag. Never mix a JitPack AAR with a
GitHub Packages classifier (or vice versa) — the Build ID check exists exactly
to catch that.

## Release

Push a tag `android-sdk-v<version>` (e.g. `android-sdk-v0.12.4`). That publishes to
GitHub Packages (`build.hands:hands-android-sdk:<version>`, including the
`native-symbols` classifier) and, on the first
request, builds the same version on JitPack
(`com.github.botiverse:hands:android-sdk-v<version>`) — so both channels stay in
sync from one tag. Or run the `Publish Android SDK` workflow manually.
