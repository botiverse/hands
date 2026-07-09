# @botiverse/hands-electron

Crash reporting for Electron apps, backed by [Quiver](https://quiver.oranix.io).

Electron's built-in [Crashpad](https://www.electronjs.org/docs/latest/api/crash-reporter)
captures native minidumps for **both the main and renderer processes** and
uploads them straight to Quiver, where they're stored as crash tickets and
symbolicated server-side against your uploaded Breakpad symbols. This SDK wires
that up, adds renderer/child-process crash listeners, and manages a crash scope
(user / tags / extra / breadcrumbs) that rides along on the next dump.

The SDK has two entry points, like `@sentry/electron`: one for the **main**
process and one for the **renderer**.

## Install

```bash
npm install @botiverse/hands-electron
```

`electron` is a peer dependency (provided by your app).

## Main process

Call `init()` once, before the app is ready:

```ts
import { app } from "electron";
import * as Quiver from "@botiverse/hands-electron/main";

Quiver.init({
  appSlug: "my-desktop-app",     // your Quiver app slug
  clientKey: "qk_live_...",      // public client key (safe to ship)
  release: app.getVersion(),     // version_name (defaults to app.getVersion())
  versionCode: 1020300,          // Quiver version_code → picks the symbol set
  environment: "stable",         // channel
  extra: { deployment: "ga" },   // static annotations on every crash
  onCrash: (info) => {
    // renderer / child-process termination (incl. oom / killed, which produce
    // no minidump) — log, show a dialog, etc.
    console.warn("process gone:", info.processType, info.reason);
  },
});

// Attach context that rides along on the next crash:
Quiver.setUser({ id: "u_123", email: "a@b.com" });
Quiver.setTag("feature", "editor");
Quiver.setExtra("open_docs", 3);
Quiver.addBreadcrumb({ message: "opened project", category: "ui" });
```

`init()` also sends a throttled launch/install metrics ping to Quiver using a
random per-install device id stored under Electron `userData`. This powers
active-device and version-distribution analytics; it is not a true online
heartbeat. Use `Quiver.reportDevice(options)` if you need to force a metrics
ping outside the normal 24h throttle.

## Renderer process

Renderer crashes are captured by the main-process Crashpad automatically — the
renderer entry only manages scope and forwards it to main over IPC:

```ts
import * as Quiver from "@botiverse/hands-electron/renderer";

Quiver.setTag("route", location.pathname);
Quiver.addBreadcrumb({ message: "clicked export" });
```

For sandboxed renderers (`contextIsolation: true`), expose the API from your
preload script instead:

```ts
// preload.ts
import { exposeQuiver } from "@botiverse/hands-electron/preload";
exposeQuiver(); // → window.quiver.setTag(...), window.quiver.addBreadcrumb(...)
```

## Symbols (server-side symbolication)

Minidumps only become readable stacks when Quiver has your app's Breakpad
symbols for that `version_code`. In CI, generate them with
[`dump_syms`](https://github.com/mozilla/dump_syms) and upload alongside the
release:

```bash
# produce .sym files for your app + Electron framework binaries
dump_syms path/to/MyApp > syms/MyApp.sym
# … repeat per binary, then zip them (flat is fine — Quiver reads each
#    file's MODULE header to place it correctly) …
zip -r symbols.zip syms/

quiver builds publish-electron my-desktop-app \
  --version-name 1.2.3 --version-code 1020300 \
  --installer dist/MyApp-1.2.3.exe \
  --symbols symbols.zip
```

Once symbols are present, each crash ticket gets a symbolicated stack posted as
a comment. Without symbols, Quiver still records the crash with module+offset
frames.

## What gets sent

Every minidump carries a Sentry-electron-style annotation set the server folds
into the ticket: `product_type=electron`, `version`, `version_code`,
`environment`/`channel`, `platform`, `arch`, `process_type`,
`electron_version`, `chrome_version`, plus any `extra` and the current
user/tags/breadcrumbs.
