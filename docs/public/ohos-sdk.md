# HarmonyOS SDK

`@botiverse/hands` is the HarmonyOS SDK for Hands (ArkTS HAR): **feedback
tickets** and **crash reporting** against a Hands server's
public feedback endpoint. Mirrors the Android and iOS SDKs.

> **Status:** the package is being published to ohpm. Until it's live,
> consume the HAR from a local build of `clients/ohos` in the
> [Hands repo](https://github.com/oranix-io/quiver).

## Install

```bash
ohpm install @botiverse/hands
```

## Configure & start

All configuration is runtime parameters — the SDK ships nothing
app-specific. Get the client key from your app's **Settings** tab in the
Hands console (Sentry-DSN model: it identifies the app; rotate it from the
console if it leaks).

```ts
import { Hands } from '@botiverse/hands';

// In UIAbility onCreate — pass the context to wire the internal launch
// logic (throttled device-analytics ping + pending-crash upload).
Hands.install({
  baseUrl: 'https://quiver.example.com',
  appSlug: 'my-app',
  channel: 'main',          // Hands release-channel routing field
  clientKey: 'qk_…',
}, this.context);
```

Call it as early as possible (UIAbility `onCreate`). The app needs the
`ohos.permission.INTERNET` permission declared in its `module.json5`. With
the context passed, `install` handles device analytics and pending-crash
upload for you — no separate calls needed.

## Feedback

```ts
import { HandsFeedbackClient } from '@botiverse/hands';

const ticketId = await HandsFeedbackClient.submit(
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

`Hands.install(config, context)` captures uncaught ArkTS errors and uploads
them as `kind=crash` tickets, grouped by signature in the console. Nothing
else to wire.

## Device analytics

`Hands.install(config, context)` also reports active-device and
version-distribution metrics automatically (no PII — a random per-install
device id and build/OS metadata). The ping is throttled and is not a true
online heartbeat. No separate call.
