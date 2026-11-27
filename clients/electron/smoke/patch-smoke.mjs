#!/usr/bin/env node
// An update patch is applied inside Electron, whose node:fs is not Node's: it
// shows app.asar as a folder. The unit tests run in plain Node and passed while
// every Mac of the app this came from fell back to the full download; the
// applier reads the installed app through original-fs, and this checks it
// there, in a real Electron.
//
//   pnpm --filter @botiverse/hands-electron smoke:patch    (needs the electron binary)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildZipFromPatch } from "@botiverse/hands-app-patch";

const self = fileURLToPath(import.meta.url);
const ids = { from: "1.0.0", to: "1.1.0", arch: "arm64" };

if (process.platform === "win32") {
  console.log("SKIP patch smoke: no update patches on Windows");
} else if (process.versions.electron) {
  const [baseApp, patchFile, zipFile] = process.argv.slice(2);
  // Checks every file it writes against the new app's sha256.
  const { size } = await buildZipFromPatch({ baseApp, patchFile, zipFile, ...ids });
  console.log(`built ${size} B in Electron ${process.versions.electron}`);
} else {
  const { makeAppPatch } = await import("@botiverse/hands-app-patch/make");
  const dir = mkdtempSync(path.join(tmpdir(), "hands-patch-smoke-"));
  try {
    const app = (version) => {
      const root = path.join(dir, version, "My App.app");
      mkdirSync(path.join(root, "Contents/Resources"), { recursive: true });
      writeFileSync(path.join(root, "Contents/Info.plist"), `<plist><key>CFBundleShortVersionString</key>\n<string>${version}</string></plist>`);
      writeFileSync(path.join(root, "Contents/Resources/app.asar"), `${"frontend ".repeat(20_000)}${version}`);
      return root;
    };
    const oldApp = app(ids.from);
    const patchFile = path.join(dir, "p.patch");
    makeAppPatch(oldApp, app(ids.to), patchFile, ids.arch);
    const electron = createRequire(import.meta.url)("electron");
    const run = spawnSync(electron, [self, oldApp, patchFile, path.join(dir, "out.zip")], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    if (run.status !== 0) throw new Error(`Electron could not apply the patch (exit ${run.status ?? run.signal})`);
    console.log("PASS patch smoke");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
