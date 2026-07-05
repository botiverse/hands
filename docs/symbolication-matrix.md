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
| Android native (NDK) | tombstone-style dump: abort message, signal, per-frame `#NN pc <offset> <soname> (BuildId: …)` | `native-symbols` (zip of unstripped `.so`) | container `llvm-symbolizer --obj=<so> <offset>` per frame, matched by BuildId | 🔨 next |
| iOS | crash record with a **binary images section** (image UUID + load address + slide) and frame addresses — `backtrace_symbols` text alone is NOT symbolicatable | `dsym` (zip of dSYM bundles) | container `llvm-symbolizer`/`symbolic` by image UUID + address-slide; no mac/atos dependency | 📐 (SDK prerequisite: images section) |
| Electron / Crashpad | minidump | Breakpad `.sym` files | `minidump-stackwalk` (rust-minidump) | ⏸ no electron lane yet |

## Decisions

1. **Server tooling is Linux-only.** iOS symbolication uses LLVM/`symbolic`
   inside the existing apk-parser container (extend, don't add a second
   container). `atos`/`symbolicatecrash` are rejected — they would chain the
   pipeline to macOS runners.
2. **Artifact keying.** Every symbol artifact is a build asset on the
   version_code/build that produced it (same as `proguard-mapping` today):
   `native-symbols` and `dsym` are new asset kinds. Retrace-style lookup
   stays: ticket.version_code → build → asset.
3. **Match identity is BuildId/UUID, not version.** The resolver must verify
   the ELF BuildId (Android) / Mach-O UUID (iOS) from the crash record
   against the artifact before symbolicating; version_code only narrows the
   candidate set.
4. **Android native capture: minimal tombstone parser, not Breakpad.**
   Breakpad/Crashpad in-process brings a large NDK dependency into a Kotlin
   SDK for marginal gain; Android already writes tombstones and
   `ndk-stack`-format dumps. v1: capture the signal in-process (same
   store-then-send shape as `QuiverCrash`), format frames as
   `pc <offset> <soname> (BuildId)`. Crashpad reconsidered only if we need
   out-of-process capture guarantees.
5. **iOS SDK prerequisite before any server work:** extend the crash record
   with the loaded-images table (`dyld` image list: UUID, address, path) so
   offsets are computable. Until then, dSYM upload is accepted but unused.
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
