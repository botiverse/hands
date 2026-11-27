// The patch download in place of MacUpdater's, against a fake of the
// MacUpdater methods it uses. The patch itself is real (@botiverse/hands-app-patch).
// updater-electron-updater.test.ts runs the same against the real
// electron-updater 6.3.9 and 6.8.11.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeAppPatch } from "@botiverse/hands-app-patch/make";
import type { AppUpdater } from "electron-updater";
import { afterEach, describe, it } from "vitest";
import { bundleOf, enablePatchUpdates, pickPatch } from "../src/updater/index.js";
import type { PatchEvent, PatchUpdatesOptions } from "../src/updater/index.js";

const SHA = "A".repeat(86) + "==";
const b64 = (b: Buffer) => createHash("sha512").update(b).digest("base64");

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("pickPatch", () => {
  it("only picks a well-formed patch for exactly this version and architecture", () => {
    const running = { version: "1.0.0", arch: "arm64" };
    const good = { from: "1.0.0", arch: "arm64", url: "My-App-1.1.0-arm64-from-1.0.0.patch", size: 10, sha512: SHA };
    assert.deepEqual(pickPatch({ patches: [null, { ...good, from: "0.9.0" }, good] }, running), good);
    for (const info of [
      null, {}, { patches: "x" }, { patches: [] },
      ...([
        { baseSize: 5 },
        { from: "0.9.0" }, { arch: "x64" }, { url: "../x.patch" }, { url: "https://evil.example/x.patch" }, { url: "//evil/x.patch" }, { url: "x.zip" },
        { size: 0 }, { size: 1.5 }, { size: 1e12 }, { sha512: "x" }, { sha512: undefined },
      ].map((over) => ({ patches: [{ ...good, ...over }] }))),
    ]) assert.equal(pickPatch(info, running), null, JSON.stringify(info));
  });

  it("bundleOf", () => {
    assert.equal(bundleOf("/Applications/My App.app/Contents/MacOS/My App"), "/Applications/My App.app");
  });
});

class CancellationError extends Error {}

interface SetupOptions {
  served?: (patch: Buffer) => Buffer;
  download?: Error;
  patches?: boolean;
  breakDone?: boolean;
  executableMagic?: number;
  options?: Partial<PatchUpdatesOptions>;
  withoutNative?: boolean;
}

async function setup(opts: SetupOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hands-mac-patch-"));
  cleanups.push(dir);
  const bundle = async (name: string, version: string): Promise<string> => {
    const root = path.join(dir, name, "My App.app");
    await mkdir(path.join(root, "Contents/MacOS"), { recursive: true });
    await writeFile(path.join(root, "Contents/Info.plist"), `<key>CFBundleShortVersionString</key><string>${version}</string>`);
    await writeFile(path.join(root, "Contents/app.asar"), `${"frontend ".repeat(1000)}${version}`);
    const head = Buffer.alloc(64);
    head.writeUInt32BE(name === "old" && opts.executableMagic !== undefined ? opts.executableMagic : 0xcffaedfe, 0);
    await writeFile(path.join(root, "Contents/MacOS/My App"), head);
    return root;
  };
  const oldApp = await bundle("old", "1.0.0");
  const newApp = await bundle("new", "1.1.0");
  const patchPath = path.join(dir, "made.patch");
  const made = makeAppPatch(oldApp, newApp, patchPath, "arm64", { level: 3 });
  const patchBytes = await readFile(patchPath);
  const fullBytes = Buffer.from("the release zip");
  const info = {
    version: "1.1.0",
    files: [
      { url: "My-App-1.1.0-x64.zip", sha512: "other", size: 1 },
      { url: "My-App-1.1.0-arm64.zip", sha512: b64(fullBytes), size: fullBytes.length },
    ],
    ...(opts.patches === false ? {} : { patches: [{ from: "1.0.0", arch: "arm64", url: "p.patch", size: made.size, sha512: made.sha512 }] }),
  };
  const events: PatchEvent[] = [];
  const calls = { full: 0, downloadUpdate: 0, downloads: [] as string[], delivered: [] as Array<{ size?: number; sha512: string; file: Buffer }> };
  const cache = path.join(dir, "cache");
  await mkdir(cache);
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const nativeUpdater = {
    on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
    removeListener(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener)); },
    emit(event: string, ...args: unknown[]) { for (const l of listeners.get(event) ?? []) l(...args); },
  };
  const updater = {
    currentVersion: { version: "1.0.0" },
    ...(opts.withoutNative ? {} : { nativeUpdater }),
    async doDownloadUpdate() { calls.full++; return ["full"]; },
    async downloadUpdate() { calls.downloadUpdate++; return (updater.doDownloadUpdate as (o: unknown) => Promise<unknown>)({ updateInfoAndProvider: { info, provider } }); },
    async executeDownload(task: { fileInfo: { url: URL; info: { sha512: string } }; task: (d: string, o: object) => Promise<void>; done: (e: unknown) => Promise<unknown> }) {
      const target = path.join(cache, path.basename(task.fileInfo.url.pathname));
      const temp = path.join(cache, `temp-${path.basename(target)}`);
      await task.task(temp, { sha512: task.fileInfo.info.sha512 });
      await task.done({ downloadedFile: temp });
      return [target];
    },
    async updateDownloaded(fileInfo: { info: { size?: number; sha512: string } }, event: { downloadedFile: string }) {
      if (opts.breakDone) throw new Error("proxy");
      calls.delivered.push({ ...fileInfo.info, file: await readFile(event.downloadedFile) });
    },
    httpExecutor: {
      async download(url: URL, destination: string, options: { sha512?: string }) {
        calls.downloads.push(url.href);
        if (opts.download) throw opts.download;
        const bytes = opts.served?.(patchBytes) ?? patchBytes;
        await writeFile(destination, bytes);
        if (b64(bytes) !== options.sha512) throw Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" });
      },
    },
  };
  const provider = { resolveFiles: (i: unknown) => (i as typeof info).files.map((f) => ({ url: new URL(f.url, "https://feed.example/main/"), info: f })) };
  const patch = enablePatchUpdates(updater as unknown as AppUpdater, {
    platform: "darwin",
    arch: "arm64",
    appBundle: oldApp,
    executable: path.join(oldApp, "Contents/MacOS/My App"),
    onEvent: (e) => { events.push(e); },
    ...opts.options,
  });
  const run = () => (updater.doDownloadUpdate as (o: unknown) => Promise<unknown>)({ updateInfoAndProvider: { info, provider } });
  const reasons = () => events.filter((e) => e.type === "fallback").map((e) => (e as { reason: string }).reason);
  return { dir, cache, oldApp, info, calls, events, run, patch, reasons, made, updater, nativeUpdater };
}

describe("enablePatchUpdates", () => {
  it("downloads a listed patch instead of the zip, and hands Squirrel the built zip with its own size and hash", async () => {
    const env = await setup();
    assert.equal(env.patch.enabled, true);
    await env.run();
    assert.equal(env.calls.full, 0);
    assert.deepEqual(env.calls.downloads, ["https://feed.example/main/p.patch"]);
    const [delivered] = env.calls.delivered;
    assert.ok(delivered);
    assert.equal(delivered.size, delivered.file.length);
    assert.equal(delivered.sha512, b64(delivered.file));
    assert.equal(delivered.file.toString("latin1", 0, 4), "PK\u0003\u0004");
    assert.ok(env.patch.patched("1.1.0"));
    assert.equal(env.info.files[1]!.sha512, b64(Buffer.from("the release zip")), "the feed's own entry is not changed");
    await assert.rejects(stat(path.join(env.cache, "temp-My-App-1.1.0-arm64.zip.patch")), { code: "ENOENT" });
    assert.deepEqual(env.events.map((e) => e.type), ["started", "built"]);
    const built = env.events[1] as Extract<PatchEvent, { type: "built" }>;
    assert.deepEqual({ ...built, downloadMs: 0, buildMs: 0 }, { type: "built", from: "1.0.0", to: "1.1.0", arch: "arm64", bytes: env.made.size, downloadMs: 0, buildMs: 0 });
  });

  it("leaves a feed without a patch to electron-updater", async () => {
    const env = await setup({ patches: false });
    await env.run();
    assert.equal(env.calls.full, 1);
    assert.deepEqual(env.calls.downloads, []);
    assert.deepEqual(env.events, []);
  });

  it("falls back to the full update on any failure, with its reason, and does not try again", async () => {
    const cases: Array<[string, SetupOptions, string, number, ((env: Awaited<ReturnType<typeof setup>>) => Promise<void>)?]> = [
      ["offline", { download: new Error("net::ERR") }, "download_failed", 0],
      ["wrong bytes", { served: (p) => Buffer.concat([p, Buffer.from("x")]) }, "patch_corrupt", 0],
      ["installed app changed", {}, "base_modified", 1, (env) => writeFile(path.join(env.oldApp, "Contents/app.asar"), "edited")],
      ["hand-off failed", { breakDone: true }, "other", 1],
    ];
    for (const [name, opts, reason, downloaded, before] of cases) {
      const env = await setup(opts);
      await before?.(env);
      assert.deepEqual(await env.run(), ["full"], name);
      assert.deepEqual(env.reasons(), [reason], name);
      const fallback = env.events.find((e) => e.type === "fallback") as Extract<PatchEvent, { type: "fallback" }>;
      assert.equal(fallback.bytesDownloaded, downloaded ? env.made.size : 0, name);
      assert.equal(env.patch.patched("1.1.0"), false);
      await env.run();
      assert.equal(env.calls.full, 2, name);
      assert.equal(env.calls.downloads.length, 1, name);
    }
  });

  it("sends the universal build (one DMG for every Mac) straight to the full download; a one-chip build is patched", async () => {
    for (const magic of [0xcafebabe, 0xcafebabf]) {
      const env = await setup({ executableMagic: magic });
      assert.deepEqual(await env.run(), ["full"]);
      assert.deepEqual(env.calls.downloads, [], "nothing downloaded for a patch that cannot apply");
      assert.deepEqual(env.reasons(), ["base_universal"]);
    }
    const thin = await setup({ executableMagic: 0xcffaedfe }); // MH_MAGIC_64 as stored on disk
    await thin.run();
    assert.equal(thin.calls.full, 0);
    assert.ok(thin.patch.patched("1.1.0"));
  });

  it("says which file failed, in the event's local detail only", async () => {
    const env = await setup();
    await writeFile(path.join(env.oldApp, "Contents/app.asar"), "edited");
    await env.run();
    const fallback = env.events.find((e) => e.type === "fallback") as Extract<PatchEvent, { type: "fallback" }>;
    assert.match(String(fallback.detail), /app\.asar/);
  });

  it("does not turn a cancelled download into a full one", async () => {
    const env = await setup({ download: new CancellationError("cancelled") });
    await assert.rejects(env.run, CancellationError);
    assert.equal(env.calls.full, 0);
  });

  it("downloads in full what Squirrel refused, once", async () => {
    const env = await setup();
    await env.run();
    env.nativeUpdater.emit("error", new Error("Code signature did not pass validation"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(env.reasons(), ["install_rejected"]);
    assert.equal(env.calls.downloadUpdate, 1);
    assert.equal(env.calls.full, 1);
    env.nativeUpdater.emit("error", new Error("again"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(env.calls.downloadUpdate, 1, "only the patched update is redone");
  });

  it("forgets a patched update once Squirrel took it", async () => {
    const env = await setup();
    await env.run();
    env.nativeUpdater.emit("update-downloaded");
    env.nativeUpdater.emit("error", new Error("a later, unrelated error"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(env.calls.downloadUpdate, 0);
  });

  it("leaves Squirrel's refusal to the app when asked to, through reject()", async () => {
    const env = await setup({ options: { redownloadOnReject: false } });
    await env.run();
    env.nativeUpdater.emit("error", new Error("refused"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(env.calls.downloadUpdate, 0);
    assert.equal(env.patch.reject("1.0.9"), false, "another version");
    assert.equal(env.patch.reject("1.1.0"), true);
    assert.equal(env.patch.reject("1.1.0"), false, "once");
    assert.deepEqual(env.reasons(), ["install_rejected"]);
    assert.deepEqual(await env.run(), ["full"]);
  });

  it("stays off, and says why, off macOS or without the updater's internals", async () => {
    const events: PatchEvent[] = [];
    const linux = enablePatchUpdates({} as AppUpdater, { platform: "linux", onEvent: (e) => events.push(e) });
    assert.equal(linux.enabled, false);
    const env = await setup();
    env.patch.dispose();
    const { httpExecutor: _, ...withoutExecutor } = env.updater;
    const internals = enablePatchUpdates(withoutExecutor as unknown as AppUpdater, { platform: "darwin", onEvent: (e) => events.push(e) });
    assert.equal(internals.enabled, false);
    assert.deepEqual(events, [{ type: "unavailable", reason: "unsupported_platform" }, { type: "unavailable", reason: "updater_internals" }]);
  });

  it("puts electron-updater's own download back on dispose", async () => {
    const env = await setup();
    env.patch.dispose();
    await env.run();
    assert.equal(env.calls.full, 1);
    assert.deepEqual(env.calls.downloads, []);
  });

  it("a throwing onEvent does not break the update", async () => {
    const env = await setup({ options: { onEvent: () => { throw new Error("app bug"); } } });
    await env.run();
    assert.ok(env.patch.patched("1.1.0"));
  });
});
