# Changelog

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
