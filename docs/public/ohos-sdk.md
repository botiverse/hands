# HarmonyOS SDK

`@oranix/quiver` is the HarmonyOS SDK for Quiver (ArkTS HAR): **feedback
tickets** and **crash reporting** against a Quiver server's
public feedback endpoint. Mirrors the Android and iOS SDKs.

> **Status:** the package is being published to ohpm. Until it's live,
> consume the HAR from a local build of `clients/ohos` in the
> [Quiver repo](https://github.com/oranix-io/quiver).

## Install

```bash
ohpm install @oranix/quiver
```

## Configure & start

All configuration is runtime parameters — the SDK ships nothing
app-specific. Get the client key from your app's **Settings** tab in the
Quiver console (Sentry-DSN model: it identifies the app; rotate it from the
console if it leaks).

```ts
import { Quiver } from '@oranix/quiver';

// In UIAbility onCreate — pass the context to wire the internal launch
// logic (throttled device-analytics ping + pending-crash upload).
Quiver.install({
  baseUrl: 'https://quiver.example.com',
  appSlug: 'my-app',
  channel: 'main',          // Quiver release-channel routing field
  clientKey: 'qk_…',
}, this.context);
```

Call it as early as possible (UIAbility `onCreate`). The app needs the
`ohos.permission.INTERNET` permission declared in its `module.json5`. With
the context passed, `install` handles device analytics and pending-crash
upload for you — no separate calls needed.

## Feedback

```ts
import { QuiverFeedbackClient } from '@oranix/quiver';

const ticketId = await QuiverFeedbackClient.submit(
  context,                    // common.UIAbilityContext
  'Feed does not refresh',    // message
  'bug',                      // 'feedback' | 'bug' | 'crash'
  [logFilePath],              // up to 3 files, 10 MB each
  [],                         // extras: Array<{ key, value }>
);
```

Device metadata (version, model, OS, ABI, locale, per-install device id) is
attached automatically.

## Crash reporting

`Quiver.install(config, context)` captures uncaught ArkTS errors and uploads
them as `kind=crash` tickets, grouped by signature in the console. Nothing
else to wire.

## Device analytics

`Quiver.install(config, context)` also reports active-device and
version-distribution metrics automatically (no PII — a random per-install
device id and build/OS metadata). The ping is throttled and is not a true
online heartbeat. No separate call.
