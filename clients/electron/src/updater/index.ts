// Hands Electron SDK — macOS update patches for electron-updater.
//
//   import { autoUpdater } from "electron-updater";
//   import { enablePatchUpdates } from "@botiverse/hands-electron/updater";
//   enablePatchUpdates(autoUpdater, { onEvent: (e) => log.info("update_patch", e) });
//
// The feed (latest-mac.yml) may carry `patches`: {from, arch, url, size,
// sha512}, made by `hands electron make-patches`. When one starts from the
// running version and architecture, the update is downloaded as that patch
// and the release zip is rebuilt from the installed app
// (@botiverse/hands-app-patch) instead of downloading the zip. Without a
// matching entry nothing here runs and the download is electron-updater's
// own, so a feed without patches changes nothing. Any failure, before or after
// the download, falls back to electron-updater's own download (the blockmap
// differential, else the full zip).
//
// electron-updater has no extension point for this. This replaces the
// updater's (private) doDownloadUpdate and goes on with its own steps:
// executeDownload (cache folder, progress, events), httpExecutor.download
// (which refuses bytes that are not the feed's sha512), provider.resolveFiles
// and MacUpdater's updateDownloaded (the proxy Squirrel.Mac reads from). When
// any of them is missing, patch updates stay off (an `unavailable` event) and
// electron-updater works as before. Tested against electron-updater 6.3.9 and
// 6.8.11.
//
// The built zip is stored, not compressed, so its bytes differ from the
// release zip's: its own size and sha512 take the release's place in what is
// handed to Squirrel. The .app inside is byte for byte the signed and
// notarized release, so Squirrel's signature check passes as for the zip.
// electron-updater's cache folder records that hash too, so a later check of
// a version already patched in this run asks for the built zip by its own
// hash: the cached zip is handed to Squirrel again, nothing is downloaded or
// rebuilt.
//
// No network calls of its own and no telemetry: `onEvent` gets closed codes
// and numbers, the app decides what to log or report.

import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import path from "node:path";
import { AppPatchError, MAX_PATCH_FILE, buildZipFromPatch, zstdDictionarySupported } from "@botiverse/hands-app-patch";
import type { AppUpdater } from "electron-updater";

/** One entry of the feed's `patches`. */
export interface FeedPatch { from: string; arch: string; url: string; size: number; sha512: string }

export type PatchFallbackReason =
  | "base_version_mismatch"
  | "base_missing"
  | "base_modified"
  | "base_universal"
  | "patch_corrupt"
  | "verify_failed"
  | "unsupported_format"
  | "download_failed"
  | "install_rejected"
  | "other";

/** What happened to a patch update. Every field is a closed code or a number: no paths or URLs, except `detail`, which is for the local log only. */
export type PatchEvent =
  | { type: "unavailable"; reason: "unsupported_platform" | "updater_internals" }
  | { type: "started"; from: string; to: string; arch: string; bytes: number }
  | { type: "built"; from: string; to: string; arch: string; bytes: number; downloadMs: number; buildMs: number }
  | {
    type: "fallback"; from: string; to: string; arch: string; reason: PatchFallbackReason; bytesDownloaded: number;
    /** Which file or step, for the local log only. */
    detail?: string;
  };

export interface PatchUpdatesOptions {
  /** The running version. Default: the updater's currentVersion (app.getVersion()). */
  version?: string;
  /** Default: process.arch. */
  arch?: string;
  /** The installed bundle a patch starts from. Default: the .app of process.execPath. */
  appBundle?: string;
  /** The installed app's main executable, checked for a universal binary. Default: process.execPath. */
  executable?: string;
  /** Default: process.platform. Patches are applied on "darwin" only. */
  platform?: string;
  /** Which of the release's files is the zip for this architecture. Default: a name ending in `-${arch}.zip`. */
  isUpdateFile?: (url: URL, arch: string) => boolean;
  /**
   * When Squirrel.Mac refuses a patched update, download the release in full
   * (`downloadUpdate()`). Default true. Turn it off when the app watches
   * Squirrel itself and calls `reject(version)`.
   */
  redownloadOnReject?: boolean;
  onEvent?: (event: PatchEvent) => void;
}

export interface PatchUpdates {
  /** Whether patch updates are on (the platform and the updater allow them). */
  readonly enabled: boolean;
  /** Whether the download of `version` came from a patch. */
  patched(version: string): boolean;
  /** Squirrel did not take the patched `version`: use the full download from now on. True when `version` was patched. */
  reject(version: string): boolean;
  /** Puts electron-updater's own download back. */
  dispose(): void;
}

/** Release versions are `major.minor.patch`, optionally `-prerelease`. */
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The feed's patch for this copy, or null. Malformed entries are ignored. */
export function pickPatch(info: unknown, running: { version: string; arch: string }): FeedPatch | null {
  const patches = (info as { patches?: unknown } | null)?.patches;
  if (!Array.isArray(patches)) return null;
  for (const p of patches as Array<Partial<FeedPatch> & { baseSize?: unknown } | null>) {
    if (!p || p.from !== running.version || p.arch !== running.arch || !VERSION_RE.test(p.from)) continue;
    // A plain file name beside the release zip: never another host or folder.
    if (typeof p.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.patch$/.test(p.url)) continue;
    if (!Number.isInteger(p.size) || (p.size as number) <= 0 || (p.size as number) > MAX_PATCH_FILE) continue;
    // A single-file (AppImage) patch: not for a .app.
    if (p.baseSize !== undefined) continue;
    if (typeof p.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(p.sha512)) continue;
    return p as FeedPatch;
  }
  return null;
}

/** The bundle an executable is in: /X/My App.app/Contents/MacOS/My App → /X/My App.app. */
export function bundleOf(execPath: string): string {
  return path.dirname(path.dirname(path.dirname(execPath)));
}

/** Whether a Mach-O file holds code for more than one chip (a universal, "fat" binary). Unreadable: false. */
export function isUniversalBinary(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) !== 4) return false;
    const magic = head.readUInt32BE(0);
    return magic === 0xcafebabe || magic === 0xcafebabf; // FAT_MAGIC, FAT_MAGIC_64
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// The parts of electron-updater's AppUpdater / MacUpdater this uses.
interface FileInfo { url: URL; info: { url: string; sha512: string; size?: number; sha2?: string } }
interface DownloadUpdateOptions {
  updateInfoAndProvider: { info: { version: string; files?: unknown }; provider: { resolveFiles(info: unknown): FileInfo[] } };
}
interface DownloadOptions { sha512?: string; sha2?: string; cancellationToken?: unknown }
interface Emitter { on(event: string, listener: (...args: unknown[]) => void): unknown; removeListener(event: string, listener: (...args: unknown[]) => void): unknown }
interface UpdaterInternals {
  doDownloadUpdate(options: DownloadUpdateOptions): Promise<unknown>;
  executeDownload(task: {
    fileExtension: string;
    fileInfo: FileInfo;
    downloadUpdateOptions: DownloadUpdateOptions;
    task: (destination: string, options: DownloadOptions) => Promise<void>;
    done: (event: unknown) => Promise<unknown>;
  }): Promise<unknown>;
  updateDownloaded(fileInfo: FileInfo, event: unknown): Promise<unknown>;
  httpExecutor: { download(url: URL, destination: string, options: DownloadOptions): Promise<unknown> } | null;
  currentVersion?: { version?: string };
  nativeUpdater?: Partial<Emitter>;
  downloadUpdate?(): Promise<unknown>;
}

/** The private methods the hook calls: each must be a function on the updater. */
export const REQUIRED_UPDATER_METHODS = ["doDownloadUpdate", "executeDownload", "updateDownloaded"] as const;

const reasonOf = (error: unknown): PatchFallbackReason => {
  if (error instanceof AppPatchError) return error.reason;
  // What arrived is not the feed's sha512 (httpExecutor), as opposed to not arriving.
  return (error as { code?: unknown } | null)?.code === "ERR_CHECKSUM_MISMATCH" ? "patch_corrupt" : "download_failed";
};
const isCancellation = (error: unknown): boolean => (error as { constructor?: { name?: string } } | null)?.constructor?.name === "CancellationError";

const off = (): PatchUpdates => ({ enabled: false, patched: () => false, reject: () => false, dispose: () => {} });

/**
 * Downloads macOS updates as patches when the feed lists one for the running
 * version. Call once, on electron-updater's autoUpdater, before the first
 * download.
 */
export function enablePatchUpdates(updater: AppUpdater, opts: PatchUpdatesOptions = {}): PatchUpdates {
  const emit = (event: PatchEvent): void => {
    try { opts.onEvent?.(event); } catch { /* the app's callback must not break the update */ }
  };
  if ((opts.platform ?? process.platform) !== "darwin" || !zstdDictionarySupported()) {
    emit({ type: "unavailable", reason: "unsupported_platform" });
    return off();
  }
  const inner = updater as unknown as UpdaterInternals;
  const version = opts.version ?? inner.currentVersion?.version;
  const record = inner as unknown as Record<string, unknown>;
  if (!version || REQUIRED_UPDATER_METHODS.some((m) => typeof record[m] !== "function") || typeof inner.httpExecutor?.download !== "function") {
    emit({ type: "unavailable", reason: "updater_internals" });
    return off();
  }
  const arch = opts.arch ?? process.arch;
  const appBundle = opts.appBundle ?? bundleOf(process.execPath);
  const executable = opts.executable ?? process.execPath;
  const isUpdateFile = opts.isUpdateFile ?? ((url: URL, a: string) => url.pathname.endsWith(`-${a}.zip`));

  const original = inner.doDownloadUpdate;
  const ownMethod = Object.prototype.hasOwnProperty.call(inner, "doDownloadUpdate");
  const full = original.bind(inner);
  const patchedVersions = new Set<string>();
  /** The zip built for each patched version, and the release and patch it was built for. */
  const builtZips = new Map<string, { release: string; patch: string; size: number; sha512: string }>();
  /** Versions whose patch failed in this run: not tried again. */
  const skipped = new Set<string>();
  /** The patched version last handed to Squirrel, until Squirrel takes or refuses it. */
  let delivered: string | null = null;

  const fallback = (to: string, reason: PatchFallbackReason, bytesDownloaded: number, detail?: string): void => {
    emit({ type: "fallback", from: version, to, arch, reason, bytesDownloaded, ...(detail ? { detail } : {}) });
  };

  inner.doDownloadUpdate = async (options) => {
    const { info, provider } = options.updateInfoAndProvider;
    const prior = patchedVersions.has(info.version) ? builtZips.get(info.version) : undefined;
    patchedVersions.delete(info.version);
    const patch = skipped.has(info.version) ? null : pickPatch(info, { version, arch });
    const download = inner.httpExecutor?.download;
    if (!patch || typeof download !== "function") return full(options);
    if (isUniversalBinary(executable)) {
      // The universal build's files are not the one-chip build a patch starts
      // from; the full download makes this copy one-chip, so its next update
      // can be patched.
      skipped.add(info.version);
      fallback(info.version, "base_universal", 0);
      return full(options);
    }
    let release: FileInfo | undefined;
    let patchUrl: URL | undefined;
    try {
      release = provider.resolveFiles(info).find((f) => isUpdateFile(f.url, arch));
      patchUrl = provider.resolveFiles({ ...info, files: [{ url: patch.url, sha512: patch.sha512, size: patch.size }] })[0]?.url;
    } catch { /* reported below */ }
    if (!release || !patchUrl) {
      skipped.add(info.version);
      fallback(info.version, "other", 0, "no release zip for this architecture in the feed");
      return full(options);
    }
    const startedAt = Date.now();
    // Our own copy: its size and hash become the built zip's, which the proxy
    // announces and the cache folder records.
    const file: FileInfo = { ...release, info: { ...release.info } };
    const releaseSha512 = release.info.sha512;
    // Patched before in this run, from the same release and patch: ask the
    // cache folder for that zip by its own hash. On a hit executeDownload
    // hands it to Squirrel without calling the task; on a miss the task
    // downloads the patch and builds the zip again.
    const reuse = prior !== undefined && prior.release === releaseSha512 && prior.patch === patch.sha512;
    if (reuse) {
      file.info.size = prior.size;
      file.info.sha512 = prior.sha512;
    }
    const id = { from: version, to: info.version, arch };
    let taskRan = false;
    let built = false;
    let downloaded = false;
    try {
      const result = await inner.executeDownload({
        fileExtension: "zip",
        fileInfo: file,
        downloadUpdateOptions: options,
        task: async (destination, downloadOptions) => {
          const patchFile = `${destination}.patch`;
          taskRan = true;
          try {
            emit({ type: "started", ...id, bytes: patch.size });
            // Refuses bytes that are not the feed's sha512.
            await download.call(inner.httpExecutor, patchUrl, patchFile, { ...downloadOptions, sha512: patch.sha512, sha2: undefined });
            const downloadedAt = Date.now();
            downloaded = true;
            const zip = await buildZipFromPatch({ baseApp: appBundle, patchFile, zipFile: destination, ...id });
            file.info.size = zip.size;
            file.info.sha512 = zip.sha512;
            built = true;
            patchedVersions.add(info.version);
            builtZips.set(info.version, { release: releaseSha512, patch: patch.sha512, size: zip.size, sha512: zip.sha512 });
            emit({ type: "built", ...id, bytes: patch.size, downloadMs: downloadedAt - startedAt, buildMs: Date.now() - downloadedAt });
          } finally {
            if (existsSync(patchFile)) rmSync(patchFile, { force: true });
          }
        },
        done: (event) => inner.updateDownloaded(file, event),
      });
      // The cached zip from an earlier patch of this version.
      if (reuse && !taskRan) patchedVersions.add(info.version);
      if (patchedVersions.has(info.version)) delivered = info.version;
      return result;
    } catch (error) {
      if (isCancellation(error)) throw error;
      patchedVersions.delete(info.version);
      builtZips.delete(info.version);
      skipped.add(info.version);
      const reason = built ? "other" : reasonOf(error);
      // Which file, for the local log (events otherwise carry closed codes only).
      const detail = error instanceof AppPatchError ? error.message.slice(0, 300) : undefined;
      fallback(info.version, reason, downloaded ? patch.size : 0, detail);
      return full(options);
    }
  };

  const reject = (rejected: string): boolean => {
    if (delivered === rejected) delivered = null;
    if (!patchedVersions.delete(rejected)) return false;
    skipped.add(rejected);
    fallback(rejected, "install_rejected", 0);
    return true;
  };

  // Squirrel.Mac's own verdict on what the proxy served.
  const nativeUpdater = inner.nativeUpdater;
  const listening = opts.redownloadOnReject !== false && typeof nativeUpdater?.on === "function" && typeof nativeUpdater.removeListener === "function";
  const onSquirrelError = (): void => {
    const rejected = delivered;
    if (rejected === null || !reject(rejected)) return;
    void Promise.resolve()
      .then(() => inner.downloadUpdate?.())
      .catch(() => { /* electron-updater reports its own errors */ });
  };
  const onSquirrelDownloaded = (): void => { delivered = null; };
  if (listening) {
    nativeUpdater!.on!("error", onSquirrelError);
    nativeUpdater!.on!("update-downloaded", onSquirrelDownloaded);
  }

  let disposed = false;
  return {
    enabled: true,
    patched: (v) => patchedVersions.has(v),
    reject,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (ownMethod) inner.doDownloadUpdate = original;
      else delete (inner as Partial<UpdaterInternals>).doDownloadUpdate;
      if (listening) {
        nativeUpdater!.removeListener!("error", onSquirrelError);
        nativeUpdater!.removeListener!("update-downloaded", onSquirrelDownloaded);
      }
    },
  };
}
