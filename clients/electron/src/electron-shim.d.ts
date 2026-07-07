// Minimal ambient typing for the Electron surface this SDK uses, so the package
// typechecks and builds standalone in CI without pulling electron's full types
// (and its ~100MB binary download). At runtime the host app's real `electron`
// is used — it's declared as a peerDependency, not installed here.

declare module "electron" {
  export interface CrashReporterStartOptions {
    productName?: string;
    submitURL: string;
    uploadToServer?: boolean;
    compress?: boolean;
    globalExtra?: Record<string, string>;
    extra?: Record<string, string>;
  }
  export interface CrashReporter {
    start(options: CrashReporterStartOptions): void;
    addExtraParameter(key: string, value: string): void;
  }
  export const crashReporter: CrashReporter;

  export interface WebContents {
    id: number;
    getURL(): string;
  }
  export interface RenderProcessGoneDetails {
    reason: string;
    exitCode: number;
  }
  export interface ChildProcessGoneDetails {
    type: string;
    reason: string;
    exitCode: number;
    name?: string;
  }
  export interface App {
    getVersion(): string;
    getName(): string;
    on(
      event: "render-process-gone",
      listener: (event: unknown, webContents: WebContents, details: RenderProcessGoneDetails) => void,
    ): App;
    on(
      event: "child-process-gone",
      listener: (event: unknown, details: ChildProcessGoneDetails) => void,
    ): App;
  }
  export const app: App;

  export interface IpcMain {
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  }
  export const ipcMain: IpcMain;

  export interface IpcRenderer {
    send(channel: string, ...args: any[]): void;
  }
  export const ipcRenderer: IpcRenderer;

  export interface ContextBridge {
    exposeInMainWorld(apiKey: string, api: unknown): void;
  }
  export const contextBridge: ContextBridge;
}

// Node's `process` — typed locally to avoid an @types/node dependency.
declare const process: {
  platform: string;
  arch: string;
  versions: Record<string, string | undefined>;
};
