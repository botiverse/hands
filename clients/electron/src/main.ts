// Quiver Electron SDK — main-process entry.
//
//   import * as Quiver from "@botiverse/hands-electron/main";
//   Quiver.init({ appSlug: "my-app", clientKey: "qk_...", versionCode: 1020300 });
//
// Starts Crashpad (which captures both main- and renderer-process minidumps and
// uploads them to Quiver), listens for renderer/child-process termination, and
// manages a crash scope (user/tags/extra/breadcrumbs) that rides along on the
// next dump. Renderers forward their scope here over IPC (see ./renderer).

import { app, crashReporter, ipcMain } from "electron";
import type { ChildProcessGoneDetails, RenderProcessGoneDetails, WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const METRICS_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

  void reportMetrics(options);

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

/** Force a runtime metrics ping outside the normal 24h throttle. */
export function reportDevice(options: QuiverElectronOptions): Promise<boolean> {
  return reportMetrics(options, true);
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

async function reportMetrics(options: QuiverElectronOptions, force = false): Promise<boolean> {
  const state = loadMetricsState();
  const now = Date.now();
  if (!force && state.lastPingAt > 0 && now - state.lastPingAt < METRICS_INTERVAL_MS) return false;

  const deviceId = state.deviceId || randomUUID();
  const endpoint = (options.endpoint ?? "https://quiver.oranix.io").replace(/\/+$/, "");
  const url = `${endpoint}/public/v2/apps/${encodeURIComponent(options.appSlug)}/metrics`;
  const env = options.environment ?? "production";
  const metadata = {
    version_name: options.release ?? app.getVersion(),
    version_code: options.versionCode,
    channel: env,
    platform: `electron-${process.platform}`,
    arch: process.arch,
    os_version: process.versions.electron ? `Electron ${process.versions.electron}` : "Electron",
    device_model: app.getName(),
    locale: app.getLocale(),
    product_type: "electron",
    electron_version: process.versions.electron,
    chrome_version: process.versions.chrome,
    node_version: process.versions.node,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Quiver-Client-Key": options.clientKey,
        "X-Quiver-Device-Id": deviceId,
      },
      body: JSON.stringify(metadata),
    });
    if (!response.ok) return false;
    saveMetricsState({ deviceId, lastPingAt: now });
    return true;
  } catch {
    return false;
  }
}

function statePath(): string {
  return join(app.getPath("userData"), "quiver-metrics.json");
}

function loadMetricsState(): { deviceId: string; lastPingAt: number } {
  const path = statePath();
  try {
    if (!existsSync(path)) return { deviceId: "", lastPingAt: 0 };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { deviceId?: unknown; lastPingAt?: unknown };
    return {
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : "",
      lastPingAt: typeof parsed.lastPingAt === "number" ? parsed.lastPingAt : 0,
    };
  } catch {
    return { deviceId: "", lastPingAt: 0 };
  }
}

function saveMetricsState(state: { deviceId: string; lastPingAt: number }): void {
  const path = statePath();
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* metrics state is best-effort */
  }
}
