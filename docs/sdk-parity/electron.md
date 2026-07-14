# Electron SDK inventory (`@botiverse/hands-electron` v0.2.1)

Source: `clients/electron/src/{main,renderer,preload,common}.ts`. Peer dep
`electron >= 22`, zero runtime deps. Model: thin wrapper over Electron's
built-in Crashpad reporter with Hands as the minidump endpoint.

## Present

- **Native crashes (all processes)** — `crashReporter.start()` → Crashpad
  minidumps for main + renderer + GPU/child, auto-uploaded to
  `/public/v2/apps/:slug/minidump`; Crashpad's own queue gives
  restart-surviving offline buffering. `render-process-gone`/
  `child-process-gone` listeners annotate reason and fire the `onCrash`
  callback (covers dump-less OOM/killed cases).
- **Symbolication** — server-side against Breakpad `.sym` sets uploaded via
  `hands builds publish-electron --symbols` (keyed by versionCode).
- **Crash context** — product_type, version/version_code, environment/
  channel, platform/arch, process_type, electron/chrome/node versions +
  runtime scope APIs `setUser`/`setTag`/`setExtra` (Crashpad annotations,
  2 KB slices).
- **Breadcrumbs (crash-scope)** — `addBreadcrumb` in main, renderer, and
  `window.hands` (preload); ring buffer 100; attached to the next crash
  annotation only (8 KB cap).
- **Device analytics** — 24h-throttled metrics ping, device id persisted in
  `userData/hands-metrics.json` (a legacy `quiver-metrics.json` is still read
  once as a fallback so existing installs keep their device id + throttling).
- **Endpoint migration** — the default origin is `https://hands.build`;
  callers may still pass an explicit endpoint for preview or staged rollout.

## Absent (→ roadmap)

- **JS error capture — none**: no main-process `uncaughtException`/
  `unhandledRejection` handler, and `renderer.init()` is an explicit no-op
  (P1.4)
- Renderer JS sourcemaps (P1.4)
- `captureException` (P0.2); sessions/crash-free rate (P0.1)
- **Feedback submit API — none in this SDK** (tickets exist server-side;
  CLI can triage them) (P1.4)
- Update-check client — electron-updater artifacts (latest*.yml, blockmap,
  installer) are published via CLI; no client wiring here
- Log capture/shipping (P2.1: HandsLog electron adapter is the plan);
  sampling controls
- Standalone breadcrumb delivery (today they die with the process unless a
  crash happens)

## Config surface

`HandsElectronOptions`: appSlug, clientKey, endpoint, productName, release,
versionCode, environment, uploadToServer, extra, onCrash. Scope APIs:
setUser/setTag/setExtra/addBreadcrumb.

## Related: `@botiverse/hands-cli` v0.5.7

Publish + triage only, no runtime telemetry: `builds publish-electron
--symbols/--metadata/--installer/--blockmap`, `publish-android --mapping/
--symbols`, `publish-ios --dsym`; `feedback list/show/update/comment/
download-attachment`.
