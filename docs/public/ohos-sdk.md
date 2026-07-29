# HarmonyOS SDK

`@botiverse/hands` is the HarmonyOS SDK for Hands (ArkTS HAR): **feedback
tickets** and **crash reporting** against a Hands server's
public feedback endpoint. Mirrors the Android and iOS SDKs.

If the registry version lags the source release, build the exact HAR from
`clients/ohos` in the [Hands repo](https://github.com/botiverse/hands).

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
  baseUrl: 'https://hands.build',
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
  [logFilePath],              // up to 9 files
  [],                         // extras: Array<{ key, value }>
);
```

Device metadata (version, model, OS, ABI, locale, per-install device id) is
attached automatically. Files up to 10 MB use the multipart request; larger
files use a presigned upload, with a 50 MB OHOS cap.

## Crash reporting

`Hands.install(config, context)` captures uncaught ArkTS errors plus system
`APP_CRASH` / `APP_FREEZE` events, including native C/C++ faults that cannot
reach the in-process ArkTS observer. Nothing else is required.

Native faults are store-then-send: HarmonyOS retains the fault record after
the process dies, and Hands consumes it on the next launch. Pending crash
files are kept until ticket creation succeeds (subject to the bounded
five-crash retention cap). One malformed system event does not block later
events in the same batch.

For handled errors and diagnostic context:

```ts
Hands.addBreadcrumb('member-detail', 'opened from thread');
await Hands.captureException(context, error, 'Could not open member detail');
```

## Device analytics

`Hands.install(config, context)` also reports active-device and
version-distribution metrics automatically (no PII — a random per-install
device id and build/OS metadata). The ping is throttled and is not a true
online heartbeat. No separate call.
