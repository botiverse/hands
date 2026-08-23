# Changelog

## 0.3.4

- Upload large feedback attachments through bounded 5 MiB ArkTS reads and an
  R2 multipart session instead of allocating the whole file in ArkTS.
- Restore the shared Android/iOS/OHOS 200 MB per-file ceiling, with bounded
  progress, one retry per part, timeout cancellation, and multipart cleanup.

## 0.3.3

- Add unified `addBreadcrumb` and handled-error `captureException` APIs.
- Make crash-directory creation idempotent on HarmonyOS, where recursive
  `mkdirSync` still throws when the leaf directory already exists.
- Isolate system fault events so one malformed or unwritable event cannot drop
  the rest of the `APP_CRASH` / `APP_FREEZE` batch.
- Use collision-resistant crash filenames, keep the full five-file retention
  window, and delete a pending crash pair only after ticket creation succeeds.
- Align the `hands_sdk` ticket metadata with the published package version.

## 0.3.2

- Native crashes now ship the full backtrace, not just a top-frame summary.
  hiAppEvent delivers the symbolicatable stack (`#NN pc <off> <lib>.so(<buildId>)`)
  only as on-device fault-log file paths; read those file contents (bounded,
  best-effort) into the crash ticket so the server can symbolicate against the
  build's uploaded `.so` symbols.

## 0.3.1

- Fix native-crash signal formatting: hiAppEvent can deliver `signal` as a
  structured object, which rendered as `[object Object]` in the ticket
  summary; extract the signal name/code instead, and pick the first named
  stack frame for the summary's top frame.

## 0.3.0

- System-level fault capture via hiAppEvent (`APP_CRASH` + `APP_FREEZE`):
  native crashes and app freezes that never reach the in-process ArkTS
  errorManager now become Hands crash tickets, delivered by the OS —
  including on the launch after a crash. JsError crashes stay with the
  existing in-process reporter (no duplicate tickets).
- Reported SDK version now matches the package version.

## 0.2.1

- First branded release of the HarmonyOS Hands SDK.
- Feedback tickets with attachments and automatic device metadata; large
  attachments upload via presigned direct-to-storage URLs (up to the configured
  cap), smaller ones inline.
- Store-then-send crash reporting, uploaded as crash tickets on next launch.
- Stable per-install device id.
