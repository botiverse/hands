# HarmonyOS SDK

`@oranix/quiver` is the HarmonyOS SDK for Quiver (ArkTS HAR): **feedback
tickets** and store-then-send **crash reporting** against a Quiver server's
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

Quiver.start({
  baseUrl: 'https://quiver.example.com',
  appSlug: 'my-app',
  channel: 'main',          // Quiver release-channel routing field
  clientKey: 'qk_…',
});
```

Call it as early as possible (UIAbility `onCreate`). The app also needs the
`ohos.permission.INTERNET` permission declared in its `module.json5`.

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

## Crash reporting (store-then-send)

At crash time (e.g. an `errorManager` observer), write the crash log and its
signature sidecar — no network in the dying process:

```ts
import { QuiverCrashUploader } from '@oranix/quiver';

QuiverCrashUploader.writeMeta(crashLogPath, {
  exception_class: error.name,
  exception_message: error.message,
  top_frame: topFrame,
  reason: 'uncaught_error',
  crash_at: Date.now(),
});
```

On the next launch (a few seconds after startup):

```ts
QuiverCrashUploader.enforceRetention(context);
await QuiverCrashUploader.uploadPending(context);
```

Pending crashes upload as `kind=crash` tickets, grouped by signature
server-side; local retention cap is 5.
