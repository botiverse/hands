# Electron SDK

`@botiverse/hands-electron` adds crash reporting to Electron apps. Electron's
built-in [Crashpad](https://www.electronjs.org/docs/latest/api/crash-reporter)
captures native minidumps for **both the main and renderer processes** and
uploads them directly to Quiver, where they become crash tickets and are
symbolicated server-side against your uploaded Breakpad symbols.

Like `@sentry/electron`, the SDK has two entry points — one imported in the
**main** process, one in the **renderer**.

## Install

```bash
npm install @botiverse/hands-electron
```

`electron` is a peer dependency provided by your app.

## Main process

Call `init()` once, before the app is ready:

```ts
import { app } from "electron";
import * as Quiver from "@botiverse/hands-electron/main";

Quiver.init({
  appSlug: "my-desktop-app",   // your Quiver app slug
  clientKey: "qk_live_...",    // public client key (safe to ship)
  release: app.getVersion(),   // version_name; defaults to app.getVersion()
  versionCode: 1020300,        // Quiver version_code → selects the symbol set
  environment: "stable",       // channel
  extra: { deployment: "ga" }, // static annotations on every crash
  onCrash: (info) => {
    // renderer / child-process termination, including oom / killed exits that
    // produce no minidump — log it, show a recovery dialog, etc.
    console.warn("process gone:", info.processType, info.reason);
  },
});
```

Attach context that rides along on the next crash:

```ts
Quiver.setUser({ id: "u_123" });
Quiver.setTag("feature", "editor");
Quiver.setExtra("open_docs", 3);
Quiver.addBreadcrumb({ message: "opened project", category: "ui" });
```

The main entry starts Crashpad, listens for `render-process-gone` and
`child-process-gone`, and receives scope forwarded from renderers.

## Renderer process

Renderer crashes are captured by the main-process Crashpad automatically. The
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

## Symbols

Minidumps become readable stacks only when Quiver has your app's Breakpad
symbols for that `version_code`. In CI:

1. Generate `.sym` files with [`dump_syms`](https://github.com/mozilla/dump_syms)
   for your app and the Electron framework binaries.
2. Zip them (a flat zip is fine — Quiver reads each file's `MODULE` header to
   place it in the Breakpad tree).
3. Upload alongside the release:

```bash
quiver builds publish-electron my-desktop-app \
  --version-name 1.2.3 --version-code 1020300 \
  --installer dist/MyApp-1.2.3.exe \
  --symbols symbols.zip
```

Each crash ticket then gets a symbolicated stack posted as a comment. Without
symbols, Quiver still records the crash with module+offset frames and leaves a
tip to upload them.

## What gets sent

Every minidump carries a Sentry-style annotation set the server folds into the
ticket: `product_type=electron`, `version`, `version_code`,
`environment`/`channel`, `platform`, `arch`, `process_type`,
`electron_version`, `chrome_version`, plus any `extra` and the current
user / tags / breadcrumbs.

## How it reaches Quiver

The SDK points Electron's `crashReporter.submitURL` at
`POST /public/v2/apps/<slug>/minidump?client_key=<key>`. Crashpad POSTs the
minidump as `upload_file_minidump` with the annotations as form fields; Quiver
stores the dump as a crash-ticket attachment and runs the symbolication lane.
No update-check or feedback wiring is required for crash reporting.
