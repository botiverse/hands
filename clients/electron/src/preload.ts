// Hands Electron SDK — preload helper.
//
// For sandboxed renderers (contextIsolation: true), import this from your
// preload script to expose a safe `window.hands` scope API:
//
//   import { exposeHands } from "@botiverse/hands-electron/preload";
//   exposeHands();
//
// then in renderer code: window.hands.setTag("route", location.pathname).

import { contextBridge, ipcRenderer } from "electron";
import { CONTEXT_CHANNEL } from "./common.js";

/** Expose the Hands scope API on `window.hands` for isolated renderers. */
export function exposeHands(): void {
  contextBridge.exposeInMainWorld("hands", {
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
