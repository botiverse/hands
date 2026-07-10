# Hands (iOS)

Native iOS reporting layer for Hands: feedback tickets and store-then-send
crash reporting. Objective-C, no dependencies, iOS 14.1+.

## Install (CocoaPods, via git)

```ruby
pod 'Hands', :git => 'https://github.com/botiverse/hands.git', :tag => 'ios-v0.2.1'
```

## Configure & start

All configuration is runtime parameters — the SDK ships nothing app-specific.
Get the client key from your app's Settings tab in the Hands console
(Sentry-DSN model: it identifies the app and ships in the bundle; rotate it
from the console if it leaks).

```swift
Hands.install(with: HandsConfig(
    baseUrl: "https://hands.build",
    appSlug: "my-app",
    channel: "main",
    clientKey: "qk_…"
))
```

`install(with:)` installs the crash handlers and uploads any pending crash
reports a few seconds after launch. Call it as early as possible (app init).

## Feedback

```swift
Hands.submitFeedback(
    "Feed doesn't refresh after login.",
    kind: "bug",                      // "feedback" | "bug" | "crash"
    attachmentPaths: [logFilePath],   // up to 3 files, 10 MB each
    extras: nil
) { ticketId, error in … }
```

Device metadata (version, model, OS, arch, locale, per-install device id) is
attached automatically.

## Crash reporting

- Uncaught `NSException`s: full `callStackSymbols` plus a signature sidecar.
- Fatal signals (SIGABRT/SEGV/BUS/ILL/FPE/TRAP): the guaranteed record is
  written with async-signal-safe calls only; stack capture runs last as
  best-effort.
- Crash metadata includes dSYM-ready `crash_binary_images` and
  `crash_frames` fields. `crash_binary_images` is a JSON array of dyld-loaded
  Mach-O images with `uuid`, runtime `load_address`, `base_address`,
  `end_address`, `slide`, `path`, and `name`; `crash_frames` is a JSON array
  of raw return addresses. `load_address` already includes ASLR slide, so the
  server resolver computes image offsets as `address - load_address`.
- Reports upload as `kind=crash` tickets on the next launch and are grouped
  by signature server-side; retention cap 5 pending reports on disk.

Known v1 gaps: no all-threads dump, no Mach exception handling. dSYM
symbolication requires the matching server/CLI dSYM asset resolver rollout.
