// The release pipeline step: a patch between two release zips' apps is kept
// only when it is small enough and, applied once, gives back the new app.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { MAX_PATCH_FILE } from "../src/index.js";
import { electronVersionOf, makeVerifiedAppPatch, unpackApp } from "../src/make.js";
import { fakeApp } from "./fixtures.js";
import { ensureUnzip, havePython, pyZip } from "./zip-tools.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function release(dir: string, version: string, next: boolean): Promise<string> {
  const app = await fakeApp(path.join(dir, version), version, next);
  const plist = path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist");
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, "<plist><key>CFBundleVersion</key>\n<string>45.3.2</string></plist>");
  const zip = path.join(dir, `My-App-${version}-arm64.zip`);
  pyZip(app, zip);
  return zip;
}

describe.skipIf(!havePython)("makeVerifiedAppPatch", { timeout: 60_000 }, () => {
  ensureUnzip();

  async function setup() {
    const dir = await mkdtemp(path.join(tmpdir(), "hands-release-patch-"));
    cleanups.push(dir);
    const oldZip = await release(dir, "1.0.0", false);
    const newZip = await release(dir, "1.1.0", true);
    const oldApp = unpackApp(oldZip, path.join(dir, "u-old"));
    const newApp = unpackApp(newZip, path.join(dir, "u-new"));
    const patchFile = path.join(dir, "My-App-1.1.0-arm64-from-1.0.0.patch");
    const base = { oldApp, newApp, newZipSize: (await stat(newZip)).size, from: "1.0.0", to: "1.1.0", arch: "arm64", patchFile, workDir: dir, level: 12 };
    return { dir, oldApp, newApp, patchFile, base };
  }

  it("keeps a small patch that rebuilds the new app", async () => {
    const t = await setup();
    assert.equal(electronVersionOf(t.newApp), "45.3.2");
    const result = await makeVerifiedAppPatch(t.base);
    assert.ok(result.kept, JSON.stringify(result));
    assert.equal(result.patch.size, (await readFile(t.patchFile)).length);
    assert.ok(result.patch.size < MAX_PATCH_FILE);
  });

  it("drops a patch over the size gate", async () => {
    const t = await setup();
    const result = await makeVerifiedAppPatch({ ...t.base, maxBytes: 100 });
    assert.deepEqual(result.kept, false);
    await assert.rejects(stat(t.patchFile), { code: "ENOENT" });
  });

  it("refuses apps that are not the versions given", async () => {
    const t = await setup();
    await assert.rejects(makeVerifiedAppPatch({ ...t.base, from: "0.9.0" }), /1\.0\.0 -> 1\.1\.0/);
    await assert.rejects(stat(t.patchFile), { code: "ENOENT" });
  });
});
