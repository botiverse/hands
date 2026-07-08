# iOS SDK

`Quiver` is the iOS SDK for Quiver: in-app **feedback tickets** and
**crash reporting** posted to a Quiver server's public
feedback endpoint. Objective-C, no dependencies, iOS 14.1+.

## Install (CocoaPods, via git)

```ruby
pod 'Quiver', :git => 'https://github.com/oranix-io/quiver.git', :tag => 'ios-v0.1.3'
```

## Configure & start

All configuration is runtime parameters — the SDK ships nothing
app-specific. Get the client key from your app's **Settings** tab in the
Quiver console (Sentry-DSN model: it identifies the app and ships in the
bundle; rotate it from the console if it leaks).

```swift
import Quiver

Quiver.install(with: QuiverConfig(
    baseUrl: "https://quiver.example.com",
    appSlug: "my-app",
    channel: "main",          // Quiver release-channel routing field
    clientKey: "qk_…"
))
```

`install(with:)` installs the crash handlers and uploads any pending crash
reports a few seconds after launch. Call it as early as possible (app init).

## Feedback

```swift
Quiver.submitFeedback(
    "Feed doesn't refresh after login.",
    kind: "bug",                      // "feedback" | "bug" | "crash"
    attachmentPaths: [logFilePath],   // up to 3 files, 10 MB each
    extras: nil
) { ticketId, error in … }
```

Device metadata (version, model, OS, arch, locale, per-install device id) is
attached automatically.

`Quiver.install(with:)` also sends a throttled launch/install metrics ping for
active-device and version-distribution analytics. It carries no PII beyond the
random per-install Quiver device id and build/OS metadata, and should not be
treated as a true online heartbeat.

## Crash reporting

`Quiver.install(with:)` captures uncaught `NSException`s and fatal signals
and uploads them as `kind=crash` tickets, grouped by signature in the
console. Nothing else to wire.

## Notes

- The client key (`qk_…`) authenticates feedback/crash submissions. It ships
  inside the app bundle (Sentry-DSN model — app identifier, not a user
  secret); it is never logged or included in diagnostics exports.
- The device id is a random UUID, not a hardware id; it resets on reinstall.
