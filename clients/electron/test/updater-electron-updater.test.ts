// The hook against the real electron-updater MacUpdater, in the versions the
// apps run (6.3.9 and 6.8.11): its private methods are there and called the
// way the hook expects, and a patched update reaches Squirrel.Mac's proxy as
// a zip with its own size, while every failure goes on to MacUpdater's own
// download. Electron itself is faked: a stand-in `electron` module whose
// autoUpdater (Squirrel) fetches from the proxy the way Squirrel.Mac does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeAppPatch } from "@botiverse/hands-app-patch/make";
import type { AppUpdater } from "electron-updater";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { REQUIRED_UPDATER_METHODS, enablePatchUpdates } from "../src/updater/index.js";
import type { PatchEvent } from "../src/updater/index.js";

const require = createRequire(import.meta.url);
const b64 = (b: Buffer) => createHash("sha512").update(b).digest("base64");
const ARCH = process.arch === "arm64" ? "arm64" : "x64";

/** Squirrel.Mac as MacUpdater drives it: setFeedURL, then checkForUpdates fetches the feed and the zip from the proxy. */
class FakeSquirrel extends EventEmitter {
  feed: { url: string; headers: Record<string, string> } | null = null;
  received: Array<{ bytes: Buffer; contentLength: number }> = [];
  refuse = false;
  setFeedURL(feed: { url: string; headers: Record<string, string> }): void { this.feed = feed; }
  checkForUpdates(): void {
    void (async () => {
      const { url: zipUrl } = await (await fetch(this.feed!.url, { headers: this.feed!.headers })).json() as { url: string };
      const res = await fetch(zipUrl);
      const bytes = Buffer.from(await res.arrayBuffer());
      this.received.push({ bytes, contentLength: Number(res.headers.get("content-length")) });
      // Squirrel checks the code signature after the download.
      setTimeout(() => (this.refuse ? this.emit("error", new Error("Code signature did not pass validation")) : this.emit("update-downloaded")), 5);
    })().catch((error) => this.emit("error", error));
  }
  quitAndInstall(): void {}
}

let squirrel = new FakeSquirrel();
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;

beforeAll(() => {
  loader._load = function (this: unknown, request, parent, isMain) {
    if (request === "electron") return { autoUpdater: squirrel };
    return realLoad.call(this, request, parent, isMain);
  };
});
afterAll(() => { loader._load = realLoad; });

/** MacUpdater resolves once the proxy has sent the zip; Squirrel reads it a moment later. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

for (const pkg of ["electron-updater-6.3.9", "electron-updater"]) {
  const version = require(`${pkg}/package.json`).version as string;

  describe(`electron-updater ${version}`, () => {
    const eu = require(pkg) as typeof import("electron-updater");

    it("has the private methods the hook uses, called the way it expects", () => {
      for (const method of REQUIRED_UPDATER_METHODS) {
        assert.equal(typeof (eu.MacUpdater.prototype as unknown as Record<string, unknown>)[method], "function", method);
      }
      const download = String((eu.MacUpdater.prototype as unknown as Record<string, unknown>).doDownloadUpdate);
      for (const call of ["this.executeDownload(", "this.httpExecutor.download(", "this.updateDownloaded(", "provider.resolveFiles("]) {
        assert.ok(download.includes(call), `MacUpdater.doDownloadUpdate no longer calls ${call}`);
      }
      const execute = String((eu.AppUpdater.prototype as unknown as Record<string, unknown>).executeDownload);
      for (const use of ["taskOptions.task(", "taskOptions.done(", "fileInfo.info.sha512"]) {
        assert.ok(execute.includes(use), `AppUpdater.executeDownload no longer uses ${use}`);
      }
    });

    async function setup(opts: { servedPatch?: (p: Buffer) => Buffer } = {}) {
      squirrel = new FakeSquirrel();
      const dir = await mkdtemp(path.join(tmpdir(), "hands-eu-"));
      cleanups.push(dir);
      const bundle = async (name: string, v: string): Promise<string> => {
        const root = path.join(dir, name, "My App.app");
        await mkdir(path.join(root, "Contents/MacOS"), { recursive: true });
        await writeFile(path.join(root, "Contents/Info.plist"), `<key>CFBundleShortVersionString</key><string>${v}</string>`);
        await writeFile(path.join(root, "Contents/Resources.asar"), `${"frontend ".repeat(5000)}${v}`);
        await writeFile(path.join(root, "Contents/MacOS/My App"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
        return root;
      };
      const oldApp = await bundle("old", "1.0.0");
      const newApp = await bundle("new", "1.1.0");
      const patchFile = path.join(dir, "made.patch");
      const made = makeAppPatch(oldApp, newApp, patchFile, ARCH, { level: 3 });
      const patchBytes = await readFile(patchFile);
      const releaseZip = Buffer.from("PK\u0003\u0004 the release zip, as electron-builder made it");
      const zipName = `My-App-1.1.0-${ARCH}.zip`;
      const info = {
        version: "1.1.0",
        path: zipName,
        sha512: b64(releaseZip),
        releaseDate: "2026-11-27T00:00:00.000Z",
        files: [{ url: zipName, sha512: b64(releaseZip), size: releaseZip.length }],
        patches: [{ from: "1.0.0", arch: ARCH, url: "p.patch", size: made.size, sha512: made.sha512 }],
      };
      const configPath = path.join(dir, "app-update.yml");
      await writeFile(configPath, "provider: generic\nurl: https://feed.example/main\nupdaterCacheDirName: hands-test-updater\n");
      const app = {
        version: "1.0.0", name: "hands-test", isPackaged: true, appUpdateConfigPath: configPath,
        userDataPath: path.join(dir, "userData"), baseCachePath: path.join(dir, "caches"),
        whenReady: async () => {}, relaunch: () => {}, quit: () => {}, onQuit: () => {},
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private members on purpose
      const updater = new eu.MacUpdater(undefined, app as never) as unknown as Record<string, any>;
      updater.logger = null;
      updater.autoInstallOnAppQuit = true;
      const downloads: string[] = [];
      updater.httpExecutor = {
        async download(url: URL, destination: string, options: { sha512?: string }) {
          downloads.push(path.basename(url.pathname));
          const bytes = url.pathname.endsWith(".patch") ? (opts.servedPatch?.(patchBytes) ?? patchBytes) : releaseZip;
          await writeFile(destination, bytes);
          if (options.sha512 && b64(bytes) !== options.sha512) throw Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" });
          return destination;
        },
      };
      const provider = { resolveFiles: (i: typeof info) => i.files.map((f) => ({ url: new URL(f.url, "https://feed.example/main/"), info: f })) };
      updater.updateInfoAndProvider = { info, provider };
      const events: PatchEvent[] = [];
      const patch = enablePatchUpdates(updater as unknown as AppUpdater, { arch: ARCH, platform: "darwin", appBundle: oldApp, executable: path.join(oldApp, "Contents/MacOS/My App"), onEvent: (e) => { events.push(e); } });
      const options = () => ({
        updateInfoAndProvider: { info, provider },
        requestHeaders: {},
        cancellationToken: new eu.CancellationToken(),
        disableDifferentialDownload: true,
      });
      const run = () => (updater.doDownloadUpdate as (o: unknown) => Promise<unknown>)(options());
      return { updater, patch, events, downloads, run, releaseZip, made };
    }

    it("hands Squirrel the zip built from the patch, announced with its own size", async () => {
      const env = await setup();
      assert.equal(env.patch.enabled, true);
      await env.run();
      assert.deepEqual(env.downloads, ["p.patch"]);
      await waitFor(() => squirrel.received.length > 0);
      const [got] = squirrel.received;
      assert.ok(got);
      assert.equal(got.bytes.toString("latin1", 0, 4), "PK\u0003\u0004");
      assert.equal(got.contentLength, got.bytes.length);
      assert.ok(env.patch.patched("1.1.0"));
      assert.deepEqual(env.events.map((e) => e.type), ["started", "built"]);
    });

    it("goes on to MacUpdater's own download when the patch is bad", async () => {
      const env = await setup({ servedPatch: (p) => Buffer.concat([p, Buffer.from("x")]) });
      await env.run();
      assert.deepEqual(env.downloads, ["p.patch", `My-App-1.1.0-${ARCH}.zip`]);
      await waitFor(() => squirrel.received.length > 0);
      assert.deepEqual(squirrel.received.map((r) => r.bytes), [env.releaseZip]);
      assert.deepEqual(env.events.filter((e) => e.type === "fallback").map((e) => (e as { reason: string }).reason), ["patch_corrupt"]);
    });

    it("downloads the release in full when Squirrel refuses the patched one", async () => {
      const env = await setup();
      squirrel.refuse = true;
      const errors: unknown[] = [];
      env.updater.on("error", (e: unknown) => { errors.push(e); });
      await env.run();
      await waitFor(() => squirrel.received.length >= 2);
      assert.deepEqual(env.downloads, ["p.patch", `My-App-1.1.0-${ARCH}.zip`]);
      assert.equal(squirrel.received.length, 2);
      assert.deepEqual(squirrel.received[1]!.bytes, env.releaseZip);
      assert.deepEqual(env.events.filter((e) => e.type === "fallback").map((e) => (e as { reason: string }).reason), ["install_rejected"]);
      assert.ok(errors.length >= 1, "the app still sees Squirrel's error");
    });
  });
}
