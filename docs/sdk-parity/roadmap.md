# SDK parity roadmap (P0–P3)

Work items from the [parity analysis](README.md), ordered by
value-per-effort. Each P0/P1 item lists the concrete change per layer
(server / SDKs / admin) so it can be picked up directly.

## P0 — small effort, large value

### P0.1 Session events → crash-free rate (release health)
The single most persuasive Sentry metric. Today all four SDKs send only a
24-hour-throttled device ping, so there is no session denominator and
crash-free rate cannot be computed.

- **Server**: `POST /public/v2/apps/:slug/sessions` accepting
  `{device_id, session_id, event: "start"|"end", version_code, version_name,
  channel, os, model, duration_ms?, crashed?}`; D1 table `app_sessions`
  (rollup-friendly: daily aggregates per version). Crash reports carry
  `session_id` so a session is marked crashed even when `end` never arrives.
- **SDKs**: emit `start` on install/foreground, `end` on background (Android
  `ProcessLifecycleOwner` / iOS `UIApplication` notifications / OHOS ability
  lifecycle / Electron `app` events). Store-and-forward like crashes; batch
  on next launch if offline.
- **Admin**: Release Health panel — crash-free sessions %, crash-free
  devices %, per release/channel; adoption curve already exists via device
  pings.

### P0.2 Unified `captureException` (handled errors)
No SDK can report a caught exception today; a whole event class is missing.

- **Server**: reuse the crash ingest path with `fatal: false` grouping into
  crash groups (group key = exception type + top app frame).
- **SDKs**: `Hands.captureException(throwable/error, extras?)` on all four
  platforms, sharing the crash context builders that already exist.
  Fire-and-forget with the same store-then-send durability as crashes.

### P0.3 Unified breadcrumbs
Electron already has `addBreadcrumb` (crash-scope only); the iOS app built
its own rolling JSONL log to fill this hole — demand is proven.

- **SDKs**: `Hands.addBreadcrumb(category, message, data?)`, ring buffer
  (~100), serialized into crash/captureException/feedback payloads. Android/
  iOS/OHOS new; Electron extend to feedback (once P1.4 adds feedback there).
- **Server**: render breadcrumb trail on ticket/crash detail.

## P1 — crash-capture depth + symbolication completion + hygiene

1. **Android ANR detection** — main-thread watchdog (5s heartbeat) +
   `ApplicationExitInfo` (REASON_ANR) harvest on next launch.
2. **iOS depth** — Mach exception handler, watchdog/hang detection,
   all-threads dump (documented v1 gaps in `HandsCrashReporter`).
3. **OHOS native crashes** — wire `hiAppEvent`/`faultLogger` so native
   faults are captured, not just ArkTS errors.
4. **Electron JS layer** — main-process `uncaughtException`/
   `unhandledRejection` + renderer error capture (renderer.init is currently
   a no-op); renderer sourcemap support; feedback submit API.
5. **iOS dSYM server resolver** — client already ships
   `crash_binary_images` (UUID/slide/ranges); implement the server-side
   dSYM lookup + frame resolution (dSYMs already uploaded via
   `hands builds publish-ios --dsym`).
6. **SDK hygiene** — single source of truth for versions (Android reports
   0.1.0-SNAPSHOT/0.4.0/0.9.0 depending on where you look; OHOS package
   0.2.0 reports 0.1.0; iOS podspec 0.1.4 vs constant 0.1.5); finish the
   Quiver→Hands rename (mobile iOS app still consumes the old `Quiver` pod
   pinned to an old commit). Overlaps the "upgrade repos to latest hands
   SDK" task.

## P2 — selective follow

1. **Logs** — HandsLog (`@botiverse/hands-node` core + electron adapter) is
   already specced and in build (docs/handslog-spec.md); mobile aligns to
   the same schema later.
2. **Performance** — only the two highest-signal metrics: app-start time and
   ANR/hang rate. No general tracing/span product.

## P3 — explicitly not pursued

Session replay, continuous profiling, crons/uptime monitoring. Huge
investment, off-positioning; apps that need them can run Sentry alongside
Hands without conflict.
