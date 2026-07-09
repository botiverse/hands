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
| Android native (NDK) | `metadata.crash_native_frames`: `[{ index, offset, soname, build_id }]` (plus the human-readable dump as attachment) | `native-symbols` (zip of unstripped `.so`) | ✅ container `/symbolicate-native`: unzip → BuildId verify (`readelf -n`) → `llvm-symbolizer` per frame → internal ticket comment (missing asset ⇒ actionable comment). `symbolic` upgrade slot reserved. | server ✅ · SDK capture 🔨 |
| iOS | crash record with a **binary images section** (image UUID + load address + slide) and frame addresses — `backtrace_symbols` text alone is NOT symbolicatable | `dsym` (zip of dSYM bundles) | container: `symbolic` by image UUID + address-slide; no mac/atos dependency | 📐 (SDK prerequisite: images section) |
| Electron / Crashpad | minidump POSTed by Electron's built-in `crashReporter` to `POST /public/v2/apps/:slug/minidump` (`upload_file_minidump` + Sentry-electron-style annotations) | `breakpad-symbols` (zip of `dump_syms` `.sym`) | ✅ container `/symbolicate-minidump`: rebuild Breakpad tree from each `.sym` MODULE header → `minidump-stackwalk --json` → internal ticket comment (no symbols ⇒ module+offset + upload tip) | server ✅ · SDK ✅ (`@botiverse/hands-electron`, main+renderer) |

## Decisions

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
4. **Android native capture: minimal async-signal-safe handler, not
   Breakpad.** Breakpad/Crashpad in-process brings a large NDK dependency
   into a Kotlin SDK for marginal gain. v1 (same store-then-send shape and
   the same handler discipline as the iOS SDK): the fatal-signal handler
   writes only a minimal, preallocated append-only record (signal number,
   fault address, raw frame pointers/offsets via a signal-safe unwinder) —
   no allocation, no JSON, no HTTP, no path assembly; all
   `pc <offset> <soname> (BuildId)` formatting and the upload happen on the
   NEXT launch. System tombstones/debuggerd output are NOT a data source:
   app processes cannot read /data/tombstones on release devices
   (`ApplicationExitInfo` traces are the only sanctioned peek, API 30+ and
   NDK-crash coverage is spotty). Crashpad reconsidered only if we need
   out-of-process minidump quality.
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
