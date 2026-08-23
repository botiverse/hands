# Symbolication matrix (internal design, task #80)

Contract (agreed 2026-07-05): **client SDKs only capture crash records and
register artifacts; every form of symbolication is a server-side pipeline.**
This doc fixes, per platform, what the client uploads, what build artifact
must be registered, and how the server resolves symbols — so "we collect
symbols.zip" never again passes for "we symbolicate".

Status legend: ✅ shipped · 🔨 next · 📐 designed only · ⏸ deferred until the
lane exists.

| Lane | Client uploads | Build asset | Server pipeline | Status |
|---|---|---|---|---|
| Android Java/R8 | stack text (kind=crash ticket, `crash_*` signature fields) | `proguard-mapping` (mapping.txt) | container `retrace` → internal ticket comment | ✅ |
| Android native (NDK) | QNC2 crash-thread context + `metadata.crash_native_frames`: `[{ index, offset, soname, build_id, source }]`, registers/thread/image table, raw QNC record, and API 30+ `ApplicationExitInfo` trace when available | `native-symbols` (zip of unstripped `.so`) | ✅ container `/symbolicate-native`: index all ABI candidates → require exact per-frame BuildId (`readelf -n`) → `llvm-symbolizer`; missing/unreadable/mismatched BuildId fails closed with no basename fallback | source ✅ · successor runtime validation 🔨 |
| iOS | crash record with a **binary images section** (image UUID + load address + slide) and frame addresses — `backtrace_symbols` text alone is NOT symbolicatable | `dsym` (zip of dSYM bundles) | container: `symbolic` by image UUID + address-slide; no mac/atos dependency | 📐 (SDK prerequisite: images section) |
| Electron / Crashpad | minidump POSTed by Electron's built-in `crashReporter` to `POST /public/v2/apps/:slug/minidump` (`upload_file_minidump` + Sentry-electron-style annotations) | `breakpad-symbols` (zip of `dump_syms` `.sym`) | ✅ container `/symbolicate-minidump`: rebuild Breakpad tree from each `.sym` MODULE header → `minidump-stackwalk --json` → internal ticket comment (no symbols ⇒ module+offset + upload tip) | server ✅ · SDK ✅ (`@botiverse/hands-electron`, main+renderer) |

## Decisions

0. **Android `native-symbols` provenance (2026-07-18, shipped in SDK 0.11.1+).**
   App pipelines must not repackage the `.so` bytes from their own build
   tree — the SDK's AAR (and therefore the APK) contains a *stripped*
   `libhandscrash.so`, so "intermediates from the app build" are fake symbols.
   The real symbols ship as the `native-symbols` Maven classifier of
   `build.hands:hands-android-sdk` (packaged from the CMake unstripped obj by
   `scripts/package_android_native_symbols.sh` via the
   `packageReleaseNativeSymbols` gradle task in the publish workflow;
   fail-closed on stripped/missing/duplicate/Build-ID-less input, with a
   `manifest.json` of per-ABI Build IDs). The app release flow resolves the
   classifier for its exact SDK version, verifies per-ABI Build IDs against
   the APK's stripped `.so`, and only then uploads the zip as the build's
   `native-symbols` asset — missing or mismatched ⇒ release fails closed.
   **AAR and classifier must come from the same channel** (GitHub Packages vs
   JitPack build separately; their Build IDs differ).
1. **Server tooling is Linux-only, standardized on the Rust symbolication
   stack** (owner call, 2026-07-05): Sentry's `symbolic` for dSYM/ELF
   frame resolution and Mozilla's `rust-minidump`/`minidump-stackwalk` for
   any minidump input, both installed in the existing apk-parser container
   (extend, don't add a second container). `llvm-symbolizer` stays as a
   fallback; `atos`/`symbolicatecrash` are rejected — they would chain the
   pipeline to macOS runners. A useful side effect: if a client lane later
   upgrades to Crashpad-quality minidumps, the server is already able to
   process them — capture format and server tooling stay decoupled.
2. **Artifact keying.** Every symbol artifact is a build asset on the
   version_code/build that produced it (same as `proguard-mapping` today):
   `native-symbols` and `dsym` are new asset kinds. Retrace-style lookup
   stays: ticket.version_code → build → asset.
3. **Match identity is BuildId/UUID, not version.** The resolver must verify
   the ELF BuildId (Android) / Mach-O UUID (iOS) from the crash record
   against the artifact before symbolicating; version_code only narrows the
   candidate set.
   For Android native frames this is strictly fail-closed: a missing crash
   BuildId, an unreadable archive BuildId, or a mismatch produces an
   unsymbolicated evidence block. Basename-only and version-only fallbacks are
   forbidden, including when an archive contains the same soname for multiple
   ABIs.
4. **Android native capture: QNC2 crash context, not handler unwind.**
   Breakpad/Crashpad in-process brings a large NDK dependency into a Kotlin
   SDK. The QNC2 fatal-signal handler therefore stays bounded and
   async-signal-safe, but treats the kernel-provided `ucontext` as the source
   of truth: signal/siginfo, crash-thread pid/tid/name, PC/LR/SP and relevant
   registers, context PC/LR frames, precomputed loaded-image ELF BuildIds, and
   `/proc/self/maps`. It does not call `_Unwind_Backtrace` from the handler —
   that was the QNC1 bug which produced recorder frames. Mapping, JSON, HTTP,
   and upload still happen on the NEXT launch. API 30+
   `ApplicationExitInfo` supplies the sanctioned tombstone/abort-description
   evidence when the OEM retained it. Matching is fail-closed on the QNC2
   recorded pid, `REASON_CRASH_NATIVE`, and a five-second timestamp window;
   one system exit can bind to only one pending QNC, and that identity is
   persisted for deterministic retry. Coverage is best-effort, never invented.
   QNC filenames use millisecond timestamp + pid + tid and `O_EXCL` with a
   bounded collision suffix, so a same-time crash loop cannot truncate an
   earlier record.
   Crashpad remains the upgrade path if we later require full out-of-process
   stack unwinding/minidumps.
5. **iOS SDK prerequisite before any server work:** extend the crash record
   with the loaded-images table (`dyld` image list: UUID, address, path) so
   offsets are computable. Until then, dSYM upload is accepted but unused.
   SDK metadata keys are `crash_binary_images` and `crash_frames`, both JSON
   strings. `crash_binary_images[].load_address` is the runtime loaded header
   address and already includes ASLR slide; the server computes frame offsets
   as `crash_frames[].address - crash_binary_images[].load_address`.
6. **Auto-retrace flow is shared:** on crash-ticket creation, the worker
   looks up the lane by `metadata.platform` + artifact availability and
   appends one internal comment with the symbolicated stack (same UX as
   Java/R8 today). Missing artifact ⇒ comment states exactly which asset
   kind + BuildId/UUID is missing (operator-actionable, not silent).

## Implementation order

1. Android native: SDK signal capture + `native-symbols` asset kind +
   container `llvm-symbolizer` resolver (primary platform, biggest gap).
2. iOS: SDK binary-images section → `dsym` asset kind → resolver.
3. Electron/Crashpad: when the lane exists.

Non-goals for now: symbol servers (Microsoft/Mozilla style), source context
in stack frames, on-device symbolication.
