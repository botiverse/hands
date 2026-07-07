// Quiver Electron SDK — renderer-process entry.
//
//   import * as Quiver from "@oranix/quiver-electron/renderer";
//   Quiver.setTag("route", location.pathname);
//
// Modern Electron captures renderer crashes through the main-process Crashpad
// automatically, so this module does NOT start a second reporter. It manages
// scope and forwards it to the main process over IPC, where it's attached to
// the next minidump. Requires the main process to have called the main entry's
// init(), and (with contextIsolation) `nodeIntegration`/IPC exposure — or use
// the ./preload helper.

import { ipcRenderer } from "electron";
import { CONTEXT_CHANNEL, type QuiverBreadcrumb } from "./common.js";

/** Reserved hook — a place to wire renderer JS-error capture in the future. */
export function init(): void {
  /* no-op for now: renderer minidumps are handled by the main Crashpad. */
}

export function setUser(user: Record<string, string> | null): void {
  ipcRenderer.send(CONTEXT_CHANNEL, { user });
}

export function setTag(key: string, value: string): void {
  ipcRenderer.send(CONTEXT_CHANNEL, { tags: { [key]: value } });
}

export function setExtra(key: string, value: unknown): void {
  ipcRenderer.send(CONTEXT_CHANNEL, { extra: { [key]: value } });
}

export function addBreadcrumb(crumb: QuiverBreadcrumb): void {
  ipcRenderer.send(CONTEXT_CHANNEL, { breadcrumbs: [crumb] });
}
