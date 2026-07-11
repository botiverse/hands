# iOS SDK inventory (`Hands` pod)

Source: `clients/ios/Sources/Hands` (Objective-C — no Swift files, which is
why naive `*.swift` searches miss it). Podspec v0.1.4, iOS 14.1+, zero deps.

**Version drift (P1.6):** podspec `0.1.4` vs `kHandsSDKVersion = 0.1.5`.
**Rename in flight (P1.6):** the Raft mobile app still consumes the old
`Quiver` pod name pinned to an old git commit (Podfile.lock `Quiver (0.1.4)`)
and calls `Quiver`-prefixed symbols via reflection.

## Present

- **NSException crashes** — `NSSetUncaughtExceptionHandler`, chains prior
  handler; `callStackSymbols` + return addresses; store-then-send
  (`Application Support/quiver/crashes`, retention 5, upload ~3 s after next
  launch, retried until success).
- **Fatal signals** — ABRT/SEGV/BUS/ILL/FPE/TRAP with an async-signal-safe
  writer (sidecar first, best-effort `backtrace()` last).
- **Symbolication prep** — emits `crash_binary_images` (Mach-O UUID, load/
  base/end, slide, path from `_dyld_register_func_for_add_image`) + raw
  `crash_frames`. dSYMs reach the server via
  `hands builds publish-ios --dsym`; **the server-side resolver is not yet
  rolled out** (P1.5).
- **Feedback** — `submitFeedback:kind:attachmentPaths:extras:` with auto
  device metadata; same 10 MB inline / 200 MB presigned model; ≤9 files.
- **Device analytics** — 24h-throttled `reportDevice` ping.
- **Diagnostics provider** — `setDiagnosticsProvider:` lets the host attach
  log files at crash-upload time. The mobile app feeds its own
  `raft-diagnostics.jsonl` (512 KB × 4 rotation) — a self-built substitute
  for the missing breadcrumb layer.

## Absent (→ roadmap)

- Mach exception handling, watchdog/hang detection, all-threads dump —
  documented v1 gaps (P1.2); no MetricKit
- Breadcrumbs (P0.3); `captureException` (P0.2); sessions (P0.1)
- Performance monitoring (P2.2)
- **Update checking — none at all on iOS**; the TestFlight-on-Hands lane is
  the current distribution answer
- Feedback/metrics are fire-and-forget (only crashes are disk-buffered)

## Config surface

`HandsConfig`: `baseUrl`, `appSlug`, `channel`, `clientKey` (all runtime).
Plus `setDiagnosticsProvider:`, `reportDevice`, `deviceId`.
