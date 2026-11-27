// The patch maker against the applier: the zip built from the installed app
// and a patch holds the release exactly, and every way it could not is refused
// with its reason, without touching the installed app.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  AppPatchError,
  LEGACY_PATCH_MAGIC,
  PATCH_CHUNK,
  PATCH_MAGIC,
  PATCH_WHOLE_DICT_MAX,
  buildFileFromPatch,
  buildZipFromPatch,
  checkFileManifest,
  checkManifest,
  dictionaryRange,
  zstdDictionarySupported,
} from "../src/index.js";
import type { AppPatchReason, PatchManifest } from "../src/index.js";
import { makeAppPatch, makeFilePatch } from "../src/make.js";
import { big, bigNext, fakeApp } from "./fixtures.js";
import { havePython, pyUnzip } from "./zip-tools.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const visit = async (rel: string): Promise<void> => {
    const abs = path.join(root, rel);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) out[rel] = `-> ${await readlink(abs)}`;
    else if (st.isDirectory()) {
      out[rel] = `dir ${(st.mode & 0o777).toString(8)}`;
      for (const name of await readdir(abs)) await visit(path.join(rel, name));
    } else out[rel] = `${(st.mode & 0o777).toString(8)} ${createHash("sha256").update(await readFile(abs)).digest("hex")}`;
  };
  await visit("");
  return out;
}

async function setup(options: { legacyMagic?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hands-app-patch-"));
  cleanups.push(dir);
  const oldApp = await fakeApp(path.join(dir, "old"), "1.0.0", false);
  const newApp = await fakeApp(path.join(dir, "new"), "1.1.0", true);
  const patchFile = path.join(dir, "p.patch");
  const made = makeAppPatch(oldApp, newApp, patchFile, "arm64", { level: 12, ...options });
  const zipFile = path.join(dir, "out.zip");
  const build = (over: Partial<Parameters<typeof buildZipFromPatch>[0]> = {}) =>
    buildZipFromPatch({ baseApp: oldApp, patchFile, zipFile, from: "1.0.0", to: "1.1.0", arch: "arm64", ...over });
  return { dir, oldApp, newApp, patchFile, made, zipFile, build };
}

async function refuses(run: () => Promise<unknown>, reason: AppPatchReason): Promise<void> {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof AppPatchError, String(error));
    assert.equal(error.reason, reason, error.message);
    return true;
  });
}

// Each setup makes a real patch of a 16 MB binary: seconds, not milliseconds.
describe("app patches", { timeout: 60_000 }, () => {
  it("runs on a Node whose zstd takes a dictionary", () => {
    assert.equal(zstdDictionarySupported(), true);
  });

  it.skipIf(!havePython)("the zip built from the installed app and the patch is the release, byte for byte", async () => {
    const t = await setup();
    const before = await tree(t.oldApp);
    const built = await t.build();
    const bytes = await readFile(t.zipFile);
    assert.equal(built.size, bytes.length);
    assert.equal(built.sha512, createHash("sha512").update(bytes).digest("base64"));
    const into = path.join(t.dir, "unzipped");
    await mkdir(into);
    pyUnzip(t.zipFile, into);
    assert.deepEqual(await readdir(into), ["My App.app"]);
    assert.deepEqual(await tree(path.join(into, "My App.app")), await tree(t.newApp));
    assert.deepEqual(await tree(t.oldApp), before);
    // Only what changed travels: one 8 MB chunk of the 16 MB binary, against its old bytes.
    assert.ok(t.made.size < 20_000, `patch is ${t.made.size} bytes`);
    assert.deepEqual(t.made.files, { copy: 3, patch: 3, full: 1 });
  });

  it("new patches carry the Hands magic; Raft Desktop's is still read, and written on request", async () => {
    const t = await setup();
    assert.equal((await readFile(t.patchFile)).toString("latin1", 0, 8), PATCH_MAGIC);
    await t.build();
    const legacy = await setup({ legacyMagic: true });
    assert.equal((await readFile(legacy.patchFile)).toString("latin1", 0, 8), LEGACY_PATCH_MAGIC);
    const built = await legacy.build();
    assert.ok(built.size > 0);
  });

  it("a changed or missing installed file is refused, whichever way the entry uses it", async () => {
    for (const [file, change, reason] of [
      ["Contents/Resources/app.asar", "x", "base_modified"],
      ["Contents/Resources/unchanged.bin", "sane", "base_modified"],
      ["Contents/Resources/unchanged.bin", null, "base_missing"],
      ["Contents/MacOS/My App", "flip", "base_modified"],
    ] as const) {
      const t = await setup();
      const target = path.join(t.oldApp, file);
      if (change === null) await rm(target);
      else if (change === "flip") {
        // The same size, one byte changed in a chunk the patch takes as is.
        const body = await readFile(target);
        body.writeUInt8(body.readUInt8(10) ^ 1, 10);
        await writeFile(target, body);
      } else await writeFile(target, change);
      await refuses(() => t.build(), reason);
      await assert.rejects(lstat(t.zipFile), { code: "ENOENT" });
    }
  });

  it("the dictionary range stays inside the old file, also past its end", () => {
    const old = PATCH_WHOLE_DICT_MAX + PATCH_CHUNK;
    for (let off = 0; off <= old + 10 * PATCH_CHUNK; off += PATCH_CHUNK) {
      const { start, end } = dictionaryRange(old, off);
      assert.ok(start >= 0 && start < end && end <= old, `${off}: ${start}..${end}`);
    }
    assert.deepEqual(dictionaryRange(old, old + 10 * PATCH_CHUNK), { start: old - PATCH_CHUNK, end: old });
    assert.deepEqual(dictionaryRange(1000, 5 * PATCH_CHUNK), { start: 0, end: 1000 });
  });

  it("a large file that grew by more than a chunk is rebuilt", async () => {
    const t = await setup();
    // Over PATCH_WHOLE_DICT_MAX, so each chunk has its own dictionary range.
    const old = Buffer.alloc(PATCH_WHOLE_DICT_MAX + 1000, 7);
    const grown = Buffer.concat([old, Buffer.alloc(3 * PATCH_CHUNK, 9)]);
    const rel = "Contents/Resources/large.bin";
    await writeFile(path.join(t.oldApp, rel), old);
    await writeFile(path.join(t.newApp, rel), grown);
    makeAppPatch(t.oldApp, t.newApp, t.patchFile, "arm64", { level: 1 });
    await t.build();
  }, 60_000);

  it("a year outside the zip format does not fail the build", async () => {
    const t = await setup();
    await t.build({ now: new Date(1970, 0, 1) });
    await t.build({ now: new Date(2200, 0, 1) });
  });

  it("a symlink in place of an installed file is not followed", async () => {
    const t = await setup();
    const file = path.join(t.oldApp, "Contents/Resources/unchanged.bin");
    const elsewhere = path.join(t.dir, "elsewhere.bin");
    await writeFile(elsewhere, await readFile(file));
    await rm(file);
    await symlink(elsewhere, file);
    await refuses(() => t.build(), "base_modified");
  });

  it("a symlink in place of an installed directory is not followed", async () => {
    const t = await setup();
    const dir = path.join(t.oldApp, "Contents/Resources");
    const elsewhere = path.join(t.dir, "elsewhere");
    await mkdir(elsewhere);
    for (const name of await readdir(dir)) await writeFile(path.join(elsewhere, name), await readFile(path.join(dir, name)));
    await rm(dir, { recursive: true });
    await symlink(elsewhere, dir);
    await refuses(() => t.build(), "base_modified");
  });

  it("another version, architecture or a damaged patch is refused", async () => {
    const t = await setup();
    await refuses(() => t.build({ from: "0.9.0" }), "base_version_mismatch");
    await refuses(() => t.build({ to: "1.2.0" }), "base_version_mismatch");
    await refuses(() => t.build({ arch: "x64" }), "base_version_mismatch");
    const bytes = await readFile(t.patchFile);
    const write = async (b: Buffer): Promise<string> => { const f = path.join(t.dir, `bad-${randomBytes(4).toString("hex")}`); await writeFile(f, b); return f; };
    await refuses(async () => t.build({ patchFile: await write(Buffer.from("no")) }), "patch_corrupt");
    await refuses(async () => t.build({ patchFile: await write(Buffer.concat([Buffer.from("HANDPAT9"), bytes.subarray(8)])) }), "unsupported_format");
    await refuses(async () => t.build({ patchFile: await write(bytes.subarray(0, bytes.length - 1)) }), "patch_corrupt");
    const flipped = Buffer.from(bytes);
    flipped.writeUInt8(flipped.readUInt8(flipped.length - 20) ^ 0xff, flipped.length - 20);
    await refuses(async () => t.build({ patchFile: await write(flipped) }), "verify_failed");
  });

  it("a manifest that points outside the bundle or the patch is refused", () => {
    const sha = "0".repeat(64);
    const base = (entries: unknown[]): unknown => ({ format: 1, arch: "arm64", from: "1", to: "2", root: "A.app", rootMode: 0o755, dataSize: 10, entries });
    const ok = { path: "f", kind: "file", mode: 0o644, size: 1, sha256: sha, build: { op: "copy", from: "g" } };
    assert.equal((checkManifest(base([ok])) as PatchManifest).root, "A.app");
    for (const entries of [
      [{ ...ok, path: "../f" }], [{ ...ok, path: "/f" }], [{ ...ok, path: "a//f" }], [{ ...ok, path: "a/f" }], [ok, ok],
      [{ ...ok, build: { op: "copy", from: "../../etc/passwd" } }],
      [{ path: "l", kind: "link", target: "../../etc" }], [{ path: "l", kind: "link", target: "/etc" }], [{ path: "l", kind: "link", target: "" }],
      // Nothing can be written through a link.
      [{ path: "l", kind: "link", target: "x" }, { ...ok, path: "l/f" }],
      [{ ...ok, build: { op: "full", chunks: [{ off: 5, len: 6 }] } }], [{ ...ok, build: { op: "full", chunks: [] } }],
      [{ ...ok, build: { op: "patch", from: "g", fromSize: 0, fromSha256: sha, chunks: [null] } }],
      [{ ...ok, build: { op: "other" } }], [{ ...ok, size: 2 ** 40 }], [{ ...ok, mode: 0o100644 }], [],
    ]) assert.throws(() => checkManifest(base(entries)), AppPatchError, JSON.stringify(entries));
    for (const root of ["../A.app", "A", "a/b.app", "..app/../x.app"]) {
      assert.throws(() => checkManifest({ ...(base([ok]) as object), root }), AppPatchError, root);
    }
  });

  it("a single file: rebuilt exactly, also through a symlink; a changed or missing one is refused", async () => {
    const t = await setup();
    const id = { from: "1.0.0", to: "1.1.0", arch: "x64" };
    const oldFile = path.join(t.dir, "old.AppImage");
    const newFile = path.join(t.dir, "new.AppImage");
    const outFile = path.join(t.dir, "out.AppImage");
    await writeFile(oldFile, big);
    await writeFile(newFile, Buffer.concat([bigNext, Buffer.from("longer")]));
    const patchFile = path.join(t.dir, "f.patch");
    const made = makeFilePatch(oldFile, newFile, patchFile, id, { level: 12 });
    assert.ok(made.size < 20_000, `patch is ${made.size} bytes`);
    const run = (baseFile = oldFile, over: object = {}) => buildFileFromPatch({ baseFile, patchFile, outFile, ...id, ...over });
    const built = await run();
    const want = await readFile(newFile);
    assert.deepEqual(await readFile(outFile), want);
    assert.equal(built.sha512, createHash("sha512").update(want).digest("base64"));
    const link = path.join(t.dir, "link.AppImage");
    await symlink(oldFile, link);
    await run(link);
    await refuses(() => run(path.join(t.dir, "none")), "base_missing");
    await refuses(() => run(oldFile, { to: "2.0.0" }), "base_version_mismatch");
    // An app's patch is not a file's, nor the other way round.
    await refuses(() => run(oldFile, { patchFile: t.patchFile }), "unsupported_format");
    await refuses(() => t.build({ patchFile }), "unsupported_format");
    await writeFile(oldFile, Buffer.alloc(big.length));
    await refuses(() => run(), "base_modified");
    await assert.rejects(lstat(outFile), { code: "ENOENT" });
    for (const value of [null, {}, { format: 1, kind: "file" }, { format: 1, kind: "file", ...id, dataSize: 1, size: 1, sha256: "0".repeat(64), build: { op: "copy", from: "x" } }]) {
      assert.throws(() => checkFileManifest(value), AppPatchError);
    }
  });
});
