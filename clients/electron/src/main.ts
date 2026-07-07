// Quiver Electron SDK — main-process entry.
//
//   import * as Quiver from "@oranix/quiver-electron/main";
//   Quiver.init({ appSlug: "my-app", clientKey: "qk_...", versionCode: 1020300 });
//
// Starts Crashpad (which captures both main- and renderer-process minidumps and
// uploads them to Quiver), listens for renderer/child-process termination, and
// manages a crash scope (user/tags/extra/breadcrumbs) that rides along on the
// next dump. Renderers forward their scope here over IPC (see ./renderer).

import { app, crashReporter, ipcMain } from "electron";
import type { ChildProcessGoneDetails, RenderProcessGoneDetails, WebContents } from "electron";
import {
  CONTEXT_CHANNEL,
  buildGlobalExtra,
  buildSubmitURL,
  toParam,
  type CrashContext,
  type QuiverBreadcrumb,
  type QuiverElectronOptions,
} from "./common.js";

const MAX_BREADCRUMBS = 100;

let started = false;
const context: CrashContext = { tags: {}, extra: {}, user: null, breadcrumbs: [] };

/** Initialise crash reporting. Call once in the main process before app ready. */
export function init(options: QuiverElectronOptions): void {
  if (started) return;
  started = true;

  crashReporter.start({
    productName: options.productName ?? options.appSlug,
    submitURL: buildSubmitURL(options),
    uploadToServer: options.uploadToServer ?? true,
    compress: true,
    globalExtra: buildGlobalExtra(options, process, app.getVersion()),
  });

  // Renderer / child-process crashes: Crashpad already captured a minidump for
  // real crashes; annotate the reason and surface every termination (including
  // the dump-less ones: oom / killed / launch-failed) via onCrash.
  app.on(
    "render-process-gone",
    (_event: unknown, _webContents: WebContents, details: RenderProcessGoneDetails) => {
      crashReporter.addExtraParameter("process_type", "renderer");
      crashReporter.addExtraParameter("crash_reason", details.reason);
      options.onCrash?.({
        processType: "renderer",
        reason: details.reason,
        exitCode: details.exitCode,
      });
    },
  );
  app.on("child-process-gone", (_event: unknown, details: ChildProcessGoneDetails) => {
    options.onCrash?.({
      processType: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  // Scope forwarded from renderer processes.
  ipcMain.on(CONTEXT_CHANNEL, (_event: unknown, patch: Partial<CrashContext>) => applyContext(patch));
}

/** Attach user identity to subsequent crashes (or clear with null). */
export function setUser(user: Record<string, string> | null): void {
  context.user = user;
  crashReporter.addExtraParameter("user", user ? JSON.stringify(user).slice(0, 2000) : "");
}

/** Set an indexed tag on subsequent crashes. */
export function setTag(key: string, value: string): void {
  context.tags[key] = value;
  crashReporter.addExtraParameter(`tag.${key}`.slice(0, 120), toParam(value).slice(0, 2000));
}

/** Set an arbitrary extra annotation on subsequent crashes. */
export function setExtra(key: string, value: unknown): void {
  context.extra[key] = value;
  crashReporter.addExtraParameter(`extra.${key}`.slice(0, 120), toParam(value).slice(0, 2000));
}

/** Record a breadcrumb; the most recent are attached to the next crash. */
export function addBreadcrumb(crumb: QuiverBreadcrumb): void {
  context.breadcrumbs.push({ timestamp: Date.now(), ...crumb });
  while (context.breadcrumbs.length > MAX_BREADCRUMBS) context.breadcrumbs.shift();
  crashReporter.addExtraParameter("breadcrumbs", JSON.stringify(context.breadcrumbs).slice(0, 8000));
}

function applyContext(patch: Partial<CrashContext>): void {
  if (patch.user !== undefined) setUser(patch.user);
  if (patch.tags) for (const [k, v] of Object.entries(patch.tags)) setTag(k, v);
  if (patch.extra) for (const [k, v] of Object.entries(patch.extra)) setExtra(k, v);
  if (patch.breadcrumbs) for (const b of patch.breadcrumbs) addBreadcrumb(b);
}
