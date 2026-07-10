# @botiverse/hands (HarmonyOS)

Official Hands SDK for HarmonyOS (ArkTS HAR): feedback tickets and
store-then-send crash reporting against a Hands server's public feedback
endpoint. Mirrors the Android SDK (`build.hands:hands-android-sdk`) and
the iOS `Hands` pod.

## Install

```bash
ohpm install @botiverse/hands
```

(Until the first ohpm release, consume the HAR from a local build of
`clients/ohos`.)

## Configure & start

All configuration is runtime parameters — the SDK ships nothing
app-specific. Get the client key from your app's Settings tab in the Hands
console (Sentry-DSN model: it identifies the app; rotate it from the console
if it leaks).

```ts
import { Hands } from '@botiverse/hands';

Hands.install({
  baseUrl: 'https://hands.build',
  appSlug: 'my-app',
  channel: 'main',          // Hands release-channel routing field
  clientKey: 'qk_…',
});
```

Call it as early as possible (UIAbility `onCreate`).

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

## Crash reporting (store-then-send)

At crash time (e.g. an `errorManager` observer), write the crash log and its
signature sidecar — no network in the dying process:

```ts
import { HandsCrashUploader } from '@botiverse/hands';

HandsCrashUploader.writeMeta(crashLogPath, {
  exception_class: error.name,
  exception_message: error.message,
  top_frame: topFrame,
  reason: 'uncaught_error',
  crash_at: Date.now(),
});
```

On the next launch (a few seconds after startup):

```ts
HandsCrashUploader.enforceRetention(context);
await HandsCrashUploader.uploadPending(context);
```

Pending crashes upload as `kind=crash` tickets, grouped by signature
server-side; local retention cap is 5.

## Publishing (maintainers)

```bash
# from clients/ohos, with DevEco/hvigor toolchain
ohpm install --all
hvigorw --mode module -p module=hands@default assembleHar
ohpm publish hands/build/default/outputs/default/hands.har   # needs the org's ohpm publish token
```
