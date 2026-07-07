// Quiver Electron SDK — preload helper.
//
// For sandboxed renderers (contextIsolation: true), import this from your
// preload script to expose a safe `window.quiver` scope API:
//
//   import { exposeQuiver } from "@oranix/quiver-electron/preload";
//   exposeQuiver();
//
// then in renderer code: window.quiver.setTag("route", location.pathname).

import { contextBridge, ipcRenderer } from "electron";
import { CONTEXT_CHANNEL } from "./common.js";

/** Expose the Quiver scope API on `window.quiver` for isolated renderers. */
export function exposeQuiver(): void {
  contextBridge.exposeInMainWorld("quiver", {
    setUser: (user: Record<string, string> | null) =>
      ipcRenderer.send(CONTEXT_CHANNEL, { user }),
    setTag: (key: string, value: string) =>
      ipcRenderer.send(CONTEXT_CHANNEL, { tags: { [key]: value } }),
    setExtra: (key: string, value: unknown) =>
      ipcRenderer.send(CONTEXT_CHANNEL, { extra: { [key]: value } }),
    addBreadcrumb: (crumb: unknown) =>
      ipcRenderer.send(CONTEXT_CHANNEL, { breadcrumbs: [crumb] }),
  });
}
