---
title: "Electron update patches"
description: "Smaller macOS updates for electron-updater apps on Hands: binary patches made in CI by hands electron make-patches and applied by @botiverse/hands-electron/updater."
category: "SDKs & API"
order: 20
---

# Electron update patches (macOS)

An Electron app that updates through `electron-updater` and the
[Hands generic feed](public-api-reference.md#electron-generic-provider)
downloads the whole per-architecture zip on macOS (often 100 MB or more), or
a blockmap differential of it. An update patch is much smaller: a routine
release is typically tens of kilobytes to a few megabytes, an Electron upgrade
about 20 MB.

How it fits together:

1. **CI** runs `hands electron make-patches` after the build. For each of the
   newest releases on the channel (3 by default) and each architecture, it
   makes a patch from that release's app to the new one, applies it once to
   check that it gives back the new app exactly, and lists the patches in the
   new `latest-mac.yml` under `patches`.
2. **Publish** uploads the `.patch` files as assets of the same build, next to
   the zips. Hands serves them from `/electron/<app>/<channel>/<file>` like any
   other build file.
3. **The app** calls `enablePatchUpdates(autoUpdater)` from
   `@botiverse/hands-electron/updater`. When the feed lists a patch from the
   running version, the app downloads it, rebuilds the release zip from the
   installed app, and hands that zip to Squirrel.Mac. The app inside is byte
   for byte the signed and notarized release, so Squirrel's signature check
   passes as usual.

Anything unexpected falls back to electron-updater's own download (the
blockmap differential, else the full zip). Clients without the SDK, or older
versions of it, ignore `patches`.

Only macOS is covered. Windows keeps electron-updater's NSIS blockmap
differential. The patch format also handles a single file (an AppImage), but
the CLI does not make Linux patches yet.

## Requirements

- **electron-builder** builds a `zip` target per architecture
  (`<name>-<version>-arm64.zip`, `<name>-<version>-x64.zip`). The zips you
  publish must be the signed, notarized and stapled ones, because a patch is
  made from exactly those bytes.
- The publish config turns off multi-range requests. Hands answers one range
  per request, and without this setting the blockmap fallback silently
  becomes a full download:

  ```yaml
  publish:
    provider: generic
    url: https://hands.build/electron/<appSlug>/<channel>
    useMultipleRangeRequest: false
  ```

- **electron-updater** 6.3.9 to 6.x. The SDK replaces a private method of
  `MacUpdater` (see [How the client hooks in](#how-the-client-hooks-in)).
- **Electron** whose Node is 22.19+ or 24.6+. Older runtimes accept a zstd
  dictionary and silently ignore it. The SDK checks this at start and stays
  off if the runtime cannot apply patches.
- **CI**: a Linux or macOS runner with Node 22.19+ (or 24.6+), `unzip` and
  `diff`, and a Hands token that can read the app (viewer). The
  [GitHub OIDC trusted publisher](cli-reference.md#github-actions-without-a-stored-token-trusted-publishers)
  token is enough.
- A release can only be a base once it is on Hands with its notarized zips.
  Your first release on Hands gets no patches. Users who installed the
  **universal** DMG fall back to the full download once (reason
  `base_universal`); that download installs the single-architecture app, so
  their next update can be patched.

## 1. The app

```bash
npm install @botiverse/hands-electron electron-updater
```

```ts
import { autoUpdater } from "electron-updater";
import { enablePatchUpdates } from "@botiverse/hands-electron/updater";

const patches = enablePatchUpdates(autoUpdater, {
  onEvent: (event) => log.info("update_patch", event),
});
// ...then use autoUpdater as before (checkForUpdates, downloadUpdate, ...).
```

Call it once, in the main process, before the first download. Under CommonJS
(TypeScript `module: nodenext` with CJS output), load it with
`await import("@botiverse/hands-electron/updater")`.

The SDK makes no network calls of its own and sends no telemetry. `onEvent`
receives closed codes and numbers. The only free text is `detail`, which names
the file that failed and is meant for the local log:

| `type` | Fields | When |
|---|---|---|
| `unavailable` | `reason`: `unsupported_platform` or `updater_internals` | At start: not macOS, a runtime without zstd dictionaries, or an electron-updater without the methods the hook needs. Updates work as before. |
| `started` | `from`, `to`, `arch`, `bytes` | The patch download begins. |
| `built` | `from`, `to`, `arch`, `bytes`, `downloadMs`, `buildMs` | The zip was rebuilt and handed to Squirrel. |
| `fallback` | `from`, `to`, `arch`, `reason`, `bytesDownloaded`, `detail?` | The patch was not used; electron-updater's own download follows. |

`reason` is one of:

| Reason | Meaning |
|---|---|
| `base_universal` | The installed app is the universal build. Nothing was downloaded. |
| `base_version_mismatch` | The patch is not for this version or architecture. |
| `base_missing`, `base_modified` | An installed file the patch needs is missing or was changed. |
| `patch_corrupt` | The download does not match the feed's `sha512`, or the file is damaged. |
| `verify_failed` | The rebuilt file does not match the release's sha256. |
| `unsupported_format` | A patch format this SDK does not read. |
| `download_failed` | The patch download failed. |
| `install_rejected` | Squirrel.Mac refused the patched update. |
| `other` | Anything else, for example the hand-off to Squirrel failing. |

A version whose patch failed is not tried again while the app runs. A
cancelled download is passed on as a cancellation, not turned into a full
download.

Options:

| Option | Default | |
|---|---|---|
| `onEvent` | none | Event callback (above). Exceptions it throws are ignored. |
| `redownloadOnReject` | `true` | When Squirrel.Mac reports an error for a patched update, emit `install_rejected` and call `autoUpdater.downloadUpdate()`, which downloads the release in full. Set `false` if the app watches Squirrel itself; it then calls `patches.reject(version)` before downloading again. |
| `version` | `autoUpdater.currentVersion` | The running version, as in the feed's `from`. |
| `arch` | `process.arch` | |
| `appBundle` | the `.app` of `process.execPath` | The installed bundle the patch starts from. It is only read. |
| `isUpdateFile` | name ends in `-${arch}.zip` | Which of the release's files is this architecture's zip. |

The returned object has `enabled`, `patched(version)`, `reject(version)` and
`dispose()` (which puts electron-updater's own download back).

### How the client hooks in

electron-updater has no extension point for this. The SDK replaces
`doDownloadUpdate` on the updater instance and then uses electron-updater's
own steps: `executeDownload` (cache folder, progress and events),
`httpExecutor.download` (which refuses bytes that do not match the feed's
`sha512`), `provider.resolveFiles`, and `MacUpdater.updateDownloaded` (the
local proxy Squirrel.Mac downloads from). The rebuilt zip is stored rather
than compressed, so its size and sha512 replace the release's in what is
handed to Squirrel. The feed itself is not changed.

If any of these methods is missing, the SDK emits `unavailable` with
`updater_internals` and does nothing else. The tests run the hook against the
real `MacUpdater` of electron-updater 6.3.9 and 6.8.11.

A patch is only picked when its `from` equals the running version and its
`arch` matches, its `url` is a plain `*.patch` file name next to the zip (never
another host or folder), its `size` is at most 64 MiB, and its `sha512` is
well formed.

## 2. CI: make the patches

After electron-builder, signing and notarization, with the release's
`latest-mac.yml` and zips in one folder:

```bash
hands electron make-patches <appSlug> \
  --version-name "$VERSION" \
  --dir release \
  --update-feed release/latest-mac.yml
```

| Option | Default | |
|---|---|---|
| `--version-name` | required | The new version; must equal `version` in `latest-mac.yml`. |
| `--dir` | required | Folder with `latest-mac.yml` and `<name>-<version>-<arch>.zip`. Each zip must match the yml's `sha512`. |
| `--channel` | `main` | Where the bases come from. |
| `--from-count` | `3` | Patch from this many of the newest releases below the new version (at most 10). |
| `--from <version>` | none | Patch from exactly these versions instead. Repeatable. |
| `--arch` | `arm64,x64`, those with a zip in the yml | Comma-separated. |
| `--name` | from the zip names | File name prefix. |
| `--out` | `--dir` | Where the `.patch` files and `patches.json` go. |
| `--update-feed` | none | Add `patches`, `previousVersion` and `electronVersion` to this yml. It is written atomically, and only when there are patches. |
| `--max-share` | `0.4` | Drop a patch larger than this share of its zip. |
| `--max-bytes` | `64MiB` | Drop a patch larger than this. Clients never accept more than 64 MiB. |
| `--legacy-magic` | off | Start the files with `RAFTPAT1` instead of `HANDPAT1`, for clients that only read Raft Desktop's original format. The bytes after the magic are the same. |
| `--level` | `19` | zstd level. |
| `--json` | off | Print `patches.json` to stdout. |

**Which releases are bases.** The command lists the channel's releases
(`GET /api/apps/:appId/releases?channel=<channel>&product_type=desktop-installer`,
and the legacy name `electron-installer`, since releases published under it
are bases too). It keeps `active` and `superseded` releases whose version is
below the new one, and takes the newest N by `version_code`. For each base it
reads that release's own `latest-mac.yml` through
`GET /api/apps/:appId/releases/:releaseId/electron-metadata/latest-mac.yml`,
which returns the served replacement if there is one. It then finds the zip
among the build's assets, downloads it through
`GET /api/apps/:appId/builds/:buildId/assets/:assetId/download?presign=1`, and
checks it against that yml's `sha512`. Asking for a presigned link does not
add to the asset's `download_count` (downloading without `presign=1` does), and
these downloads do not reach the `/electron` route, so they are not in the
[download stats](#measuring-download-stats) either. Each run downloads up to N
× architectures zips.

**What each patch goes through.** Both zips are unpacked with `unzip`. The
patch is made, dropped if it is larger than
`min(--max-share × zip size, --max-bytes)`, and otherwise applied to the base
app. The app in the resulting zip is compared with the new app using
`diff -r --no-dereference`. All architectures must carry the same Electron
version.

**When something fails:**

- The newest base fails: the command exits 2, writes no patches and leaves
  the yml unchanged. Ship without patches (for example with
  `continue-on-error: true` on the step), or fix the cause.
- An older base fails: a warning, and that base is skipped.
- No base, or every patch too large: exit 0 with an empty `patches`, and the
  yml unchanged.

**Output.** `<out>/<name>-<version>-<arch>-from-<from>.patch`, and
`<out>/patches.json`:

```json
{
  "previousVersion": "0.1.7",
  "electronVersion": "45.3.2",
  "patches": [
    { "from": "0.1.7", "arch": "arm64", "url": "My-App-0.1.8-arm64-from-0.1.7.patch", "size": 412345, "sha512": "…" }
  ],
  "slots": [
    { "file": "My-App-0.1.8-arm64-from-0.1.7.patch", "artifact_kind": "update-patch", "platform": "darwin", "arch": "arm64",
      "variant": "patch-from-0.1.7", "filetype": "patch",
      "metadata": { "from": "0.1.7", "algorithm": "app-patch-v1", "sha512": "…" } }
  ]
}
```

With `--update-feed`, the yml gains the same `patches` entries plus
`previousVersion` and `electronVersion`. Both are informational. `files`,
`path` and `sha512` are not touched:

```yaml
patches:
  - from: 0.1.7
    arch: arm64
    url: My-App-0.1.8-arm64-from-0.1.7.patch
    size: 412345
    sha512: …
previousVersion: 0.1.7
electronVersion: 45.3.2
```

## 3. Publish

Upload the `.patch` files as assets of the **same build** as the zips and the
updated `latest-mac.yml`, one per `slots` entry of `patches.json`:

| Field | Value |
|---|---|
| `artifact_kind` | `update-patch` |
| `platform` | `darwin` |
| `arch` | the patch's architecture |
| `variant` | `patch-from-<from version>` |
| `filetype` | `patch` |
| `metadata_json` | `{ "filename": "<file>", "from": "<from>", "algorithm": "app-patch-v1", "sha512": "<sha512>" }` |

Declare these slots when the build is created. A build's slots are fixed at
creation, and patches cannot be added to a published build later.
`hands builds publish-electron` has no option for patches yet, so publish
them from your own publish step with the `slots` in `patches.json`.

## Turning patches off, rolling back

Patches are not tied to the app's `delta_updates_enabled` setting, which
controls Android delta downloads only. To stop serving the patches of a
published release, remove `patches` from its `latest-mac.yml` with a metadata
replacement:

```bash
hands releases electron-metadata get <app> <releaseId> latest-mac.yml > latest-mac.yml
# delete the `patches:` list, then:
hands releases electron-metadata set <app> <releaseId> latest-mac.yml --from latest-mac.yml
```

Clients see the change within a minute and download the zip as before (see
[Changing a published release's update metadata](cli-reference.md#changing-a-published-release-s-update-metadata)).
`revert` puts the patches back. To stop making patches, skip the CI step. To
roll a release back, cancel it so the previous release's feed is served again.
Patches never downgrade an installed app.

## Measuring: download stats

Hands counts the requests the `/electron` route answers, per file and UTC day
([details](public-api-reference.md#electron-generic-provider)):

```bash
hands api GET "/api/apps/<appId>/stats/electron-downloads?days=14"
```

- Only `.patch` files, installers and zips, and `.blockmap` files are counted.
  Update checks (`latest*.yml`) are not.
- Per file and day there are three numbers: `full_requests` (no `Range`
  header), `range_requests` (with one; on a zip, usually the blockmap
  differential) and `sources`, the distinct requesters by a daily hash of IP
  address and user agent. The raw IP is not stored.
- Requests are not deduplicated: a client that retries counts again. Use
  `sources` to count clients.
- A client whose patch worked asks for the yml and the `.patch` only. A
  client that fell back also appears on the zip. A rough patch hit rate for a
  day is therefore patch `sources` / (patch `sources` + zip `sources`).
- Why a client fell back is not visible to Hands. That comes from the app's
  own `onEvent` reporting.

## The patch format

`@botiverse/hands-app-patch` (no dependencies; `node:zlib` zstd) has the
format, the applier and the generator. A file starts with the 8-byte magic
`HANDPAT1`, then a little-endian u32 length of the zstd-compressed JSON
manifest, the manifest, and the data. Readers also accept `RAFTPAT1`, which
is the same format as Raft Desktop shipped it. The manifest lists every
entry of the new `.app`:

- directories and symlinks;
- files, each built one of three ways: `copy` (an installed file with the same
  bytes), `patch` (8 MB chunks, each either the installed bytes at that
  offset or zstd-compressed with the installed file as the dictionary), or
  `full` (zstd on its own).

Every rebuilt file carries its sha256. Authenticity rests on the feed's
`sha512` of the `.patch` file, served over HTTPS like the zip's, and on
Squirrel's code-signature check. A tampered patch can only cause a failed
check followed by a full download. The feed and asset name of this format is
`app-patch-v1`.
