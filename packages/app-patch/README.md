# `@botiverse/hands-app-patch`

Binary update patches for desktop apps. A patch turns the installed copy of
one release into the next: a macOS `.app` (rebuilt as the release's zip, byte
for byte per file) or a single file such as an AppImage. No dependencies:
`node:zlib` zstd with the old files as dictionaries. Needs Node 22.19+ or
24.6+ (older runtimes ignore zstd dictionaries; `zstdDictionarySupported()`
tells).

```ts
// Apply (an Electron main process, a CLI, ...)
import { buildZipFromPatch, AppPatchError } from "@botiverse/hands-app-patch";

const { size, sha512 } = await buildZipFromPatch({
  baseApp: "/Applications/My App.app", // only read
  patchFile, zipFile, from: "1.0.0", to: "1.1.0", arch: "arm64",
});
```

```ts
// Make (CI)
import { makeAppPatch, makeVerifiedAppPatch } from "@botiverse/hands-app-patch/make";

makeAppPatch(oldApp, newApp, "out.patch", "arm64");          // { from, to, size, sha512, files }
await makeVerifiedAppPatch({ oldApp, newApp, newZipSize, from, to, arch, patchFile, workDir }); // size gate + apply + diff -r
```

Every failure to apply throws `AppPatchError` with a closed `reason`
(`base_version_mismatch`, `base_missing`, `base_modified`, `patch_corrupt`,
`verify_failed`, `unsupported_format`, `other`) and removes what was written.
The installed app is opened without following symlinks; inside Electron it is
read through `original-fs`, so `app.asar` is a file.

Files start with `HANDPAT1`; `RAFTPAT1` (the same format as Raft Desktop
shipped it) is read too, and written with `{ legacyMagic: true }`. The format,
the CLI (`hands electron make-patches`) and the Electron client
(`@botiverse/hands-electron/updater`) are described in
[Electron update patches](https://hands.build/docs/electron-updates/).

This code was first written for Raft Desktop and contributed to Hands under
the MIT license with its owner's approval.
