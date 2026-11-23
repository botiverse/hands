---
title: "Ship a desktop app"
description: "Publish desktop apps of any runtime per OS and architecture, with file-level incremental updates."
category: "SDKs & API"
order: 19
---

# Ship a desktop app

Hands releases a desktop app the same way whatever it is built with: a
JVM/Compose app with a bundled Java runtime, a native app, a Tauri app, or
anything else that installs as a directory of files. Each release carries,
per machine target, an installer for first installs and an update payload
that lets an installed copy download only the files that changed.

Existing `electron` apps keep their electron-builder feed under
`/electron/...` (see [Electron Generic Provider](public-api-reference.md#electron-generic-provider)).
Nothing on this page changes them.

## The model

| Concept | Value |
| --- | --- |
| App platform | `desktop` |
| Product type | `desktop-installer` (seeded on every new app) |
| Target | `<os>-<arch>`: `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64` |
| Runtime | Optional app attribute: `jvm`, `electron`, `native`, `tauri`, or `other` |

The runtime is descriptive. Hands records and shows it; it does not change
how the app is published or updated.

```bash
hands apps create --slug raft-desktop --name "Raft" --platform desktop --runtime jvm
```

One version is one build and one release that carries every target. Targets
are published one at a time, usually by one CI job per target: the first
creates the build and the release, each later one adds its target to them.
Each target of a build holds two kinds of files.

**Installer.** A file for people: `dmg`, `pkg`, `msi`, `exe`, `AppImage`,
`deb`, and so on. It is an ordinary build asset with `artifact_kind`
`installable`.

**Update payload.** Three parts:

1. A manifest (`artifact_kind` `desktop-manifest`, `filetype` `json`) that
   lists every file of the app bundle or install directory.
2. Every regular file of the bundle, stored once per app by its SHA-256 at
   `apps/{appId}/files/sha256/{sha256}`. A file that does not change between
   versions, such as a bundled Java runtime, is uploaded once and reused by
   every later version.
3. A full archive of the bundle (`artifact_kind` `desktop-archive`, a zip),
   the fallback when an incremental update cannot be applied.

## Manifest format

```json
{
  "schema": 1,
  "target": "darwin-arm64",
  "root": "Raft.app",
  "files": [
    { "path": "Contents/MacOS/Raft", "sha256": "3f2a…", "size": 123456, "mode": "755", "link": null },
    { "path": "Contents/Frameworks/X.framework/X", "link": "Versions/Current/X" }
  ],
  "total_size": 123456
}
```

| Field | Rule |
| --- | --- |
| `schema` | `1` |
| `target` | One of the targets above; must equal the target the manifest asset was uploaded for |
| `root` | Name of the bundle directory (`Raft.app`, `Raft`), a single path segment |
| `files[].path` | Relative to `root`, `/`-separated, no empty, `.` or `..` segment, no leading `/`, no drive letter, no `\`, no control character; unique |
| `files[].sha256`, `size` | Regular files only: lowercase hex digest and byte length |
| `files[].mode` | Regular files only: exactly three octal digits (`"644"`, `"755"`); no setuid, setgid or sticky bit |
| `files[].link` | Symlinks only: the link target, relative to the link's directory; no `sha256` |
| `total_size` | Optional; when present, the sum of all file sizes |

Directories are implied by the paths under them. No entry may sit under a
file or a symlink. The manifest is at most 8 MiB.

Paths are compared the way the target's filesystem compares them: on
`darwin-*` and `win32-*` targets, two paths that differ only in letter case or
Unicode normalization are the same path and are refused as duplicates. On
`win32-*` targets a name may not be a reserved device name (`CON`, `PRN`,
`AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, with or without an extension),
contain `< > : " | ? *`, or end with a dot or a space.

Every symlink is resolved against the manifest the way the filesystem would
resolve it, following any other symlinks on the way, and must stay inside
the bundle at every step. So `d/up -> ..` is accepted, but
`l -> d/up/../..` is refused, because once `d/up` is followed it climbs out
of the root. Chains longer than 40 links, or loops, are refused.

When the manifest upload is sealed, Hands parses it and checks that every
`sha256` it names is already stored for the app with the same size. If any
check fails, the upload fails with `DESKTOP_MANIFEST_INVALID` or
`DESKTOP_MANIFEST_FILES_MISSING` (the latter lists up to 50 missing
digests), the build stays pending, and nothing is published.

## Publish from CI

```bash
hands builds publish-desktop raft-desktop \
  --target darwin-arm64 \
  --channel main \
  --version-name 1.4.0 \
  --version-code 1004000 \
  --bundle build/Raft.app \
  --archive build/Raft-1.4.0-darwin-arm64.zip \
  --installer build/Raft-1.4.0.dmg \
  --notes-file notes.md \
  --draft
```

The command:

1. walks the bundle without following symlinks, hashing every regular file
   as it streams and recording each symlink's target; a symlink that is
   absolute or points outside the bundle stops the command;
2. asks Hands which digests it does not hold yet and uploads only those,
   straight to storage, four at a time, with retries;
3. has Hands verify each uploaded file;
4. creates a pending build whose required slots are the manifest, the
   archive and the installer for the target, and uploads them;
5. marks the build succeeded and creates the release (a draft with
   `--draft`).

It prints the number of files, how many were uploaded and their size, and how
many were reused. `--json` prints the result as JSON (`appended` is `true`
when the target was added to an existing release). Create the archive with
your build tooling, for example `ditto -c -k --keepParent Raft.app Raft.zip`
on macOS.

### Several targets

Run the command once per target with the same `--version-name` and
`--version-code`. When that version already has a release on the channel,
the command adds this target's installer, archive and manifest to the
release's build and leaves the release as it is (its notes and force-update
flag were set by the first target). The manifest is uploaded last: a target
goes live on a published release the moment its manifest is sealed.

- A target cannot be changed once its manifest is sealed. Publishing it again
  with the same files is a no-op; with different files it fails with
  `DESKTOP_TARGET_EXISTS`. Publish a new version instead.
- Only a draft or active release takes a new target; a superseded or
  cancelled one fails with `DESKTOP_RELEASE_NOT_APPENDABLE`.
- Agents and deploy tokens must pass `--draft`, as with every publish
  command, and can add targets only while the release is a draft. Adding a
  target to an active release is for a person (`AGENT_ACTIVE_RELEASE_FORBIDDEN`
  otherwise). The usual flow is: publish every target with `--draft`, review,
  then `hands releases publish`.
- Two jobs that start the same version at the same moment are reconciled: the
  one that loses the race adds its target to the winner's release.

Publishing a new version as active supersedes the previous one on the
channel, so a target that the new version does not have yet gets no update
until it is added. Publishing as a draft and activating after the last target
avoids that gap.

## Check for an update

```http
GET /public/v2/apps/:slug/desktop/update?target=darwin-arm64&channel=main&current_version_code=1003000
X-Hands-Device-Id: 2f1c…
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `target` | yes | The installed copy's target |
| `current_version_code` | yes | The installed version code (non-negative integer) |
| `channel` | no | Channel slug, default `main`; the public alias `latest` resolves to `main` |
| `installer_filetype` | no | Prefer this installer file type when a target has several |
| `X-Hands-Device-Id` | no | Stable per-install id; needed to receive a staged rollout |

Hands chooses the release the same way as
[Latest Release](public-api-reference.md#latest-release): the most specific
matching scope, then the newest activation, with staged rollouts admitted by
device id. It considers only active releases that are not hidden, whose
availability time has passed, and whose build has a manifest for the target.
Only assets sealed by the direct upload protocol (their bytes verified, and a
manifest's files checked) are offered; desktop manifests and archives cannot
be registered any other way.

When a newer version exists:

```json
{
  "update_available": true,
  "channel": "main",
  "target": "darwin-arm64",
  "current_version_code": 1003000,
  "release": {
    "id": "6c0e…",
    "version": "1.4.0",
    "version_code": 1004000,
    "notes_url": "https://hands.build/apps/raft-desktop/v/1.4.0",
    "force_update": false,
    "released_at": 1795000000000
  },
  "manifest": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 48211 },
  "full_archive": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 201326592 },
  "installer": { "url": "https://hands.build/public/r2/…", "sha256": "…", "size": 210763776, "filetype": "dmg" },
  "files_url_template": "https://hands.build/public/v2/apps/raft-desktop/files/{sha256}",
  "expires_in": 3600
}
```

`full_archive` and `installer` are `null` when the build has none for the
target. The `url` values are signed and expire after `expires_in` seconds;
fetch them soon after the check, or check again.

Otherwise:

```json
{ "update_available": false, "channel": "main", "target": "darwin-arm64", "current_version_code": 1004000, "latest_version_code": 1004000 }
```

`latest_version_code` is `null` when no release is eligible for the target.
An unknown app or channel is a 404; a bad `target` or `current_version_code`
is a 400.

## Download a file

```http
GET /public/v2/apps/:slug/files/:sha256
```

Answers `302` to a short-lived signed URL for that file. Hands answers only
for a digest that a validated manifest references, on a succeeded build of
this app whose release is active or superseded, not hidden, not QA, and
already available; any other digest, or a digest of another app, is `404`.

## Applying an update

A client typically:

1. downloads the manifest and checks its `sha256`;
2. compares it with the installed files and downloads each changed or new
   `sha256` from the file route, checking every file's digest and size;
3. assembles the new bundle next to the installed one (set `mode`, create
   symlinks), then swaps it in;
4. falls back to `full_archive` when step 2 or 3 fails, and checks its
   `sha256` too.

## Kotlin client

`build.hands:hands-desktop-updater` (source in `clients/desktop-jvm`, first
release pending) implements the steps above for a JVM app, such as a Compose
Desktop app packaged with jpackage, on macOS and Linux. It needs JDK 17+
(with the `java.net.http` module in a jlinked runtime) and depends only on
`kotlinx-serialization-json`.

```kotlin
import build.hands.desktop.*
import kotlin.io.path.Path

val stateDir = Path(System.getProperty("user.home"), "Library/Application Support/Raft/hands-updates")
// jpackage launchers set jpackage.app-path to .../Raft.app/Contents/MacOS/Raft
val installRoot = Path(System.getProperty("jpackage.app-path")).parent.parent.parent

val updater = HandsDesktopUpdater(
    appSlug = "raft-desktop",
    currentVersionCode = 1004000,       // this build's --version-code
    installRoot = installRoot,
    stateDir = stateDir,
    deviceId = loadOrCreateDeviceId(),  // a UUID you store once per install
)

fun main() = application {
    Window(onCloseRequest = ::exitApplication, title = "Raft") {
        var ready by remember { mutableStateOf<PreparedUpdate?>(null) }
        LaunchedEffect(Unit) {
            updater.markLaunchSucceeded()   // the window is up: this version works
            ready = withContext(Dispatchers.IO) {
                updater.loadPrepared() ?: when (val check = updater.checkForUpdate()) {
                    is UpdateCheck.Available -> updater.prepare(check) { /* progress */ }
                    is UpdateCheck.NoUpdate -> null
                }
            }
        }
        ready?.let { update ->
            Button(onClick = { updater.installAndRestart(update); exitApplication() }) {
                Text("Restart to update to ${update.release.version}")
            }
        }
    }
}
```

| Call | When | What it does |
| --- | --- | --- |
| `installBlocker()` | Before checking (no network) | Why the app cannot be replaced in place: `TRANSLOCATED` (macOS runs an unmoved quarantined app from a randomized read-only path), `READ_ONLY_VOLUME` (running from the DMG or another read-only volume), `NOT_WRITABLE` (its directory is not writable), `MISSING`; `null` when it can. For the first two, ask the user to move the app to Applications. `prepare` and `installAndRestart` throw `InstallBlockedException` for the same reasons |
| `checkForUpdate()` | At startup and periodically, off the UI thread | The [update check](#check-for-an-update); `NoUpdate` or `Available` (with `forceUpdate`) |
| `prepare(update, progress)` | Right after an `Available` check (its URLs expire) | Builds and verifies `stateDir/staging/<version_code>/<root>` from unchanged installed files plus downloads; on failure removes it and throws, the install is untouched |
| `installAndRestart(prepared)` | When the user agrees to restart; then exit | Starts a detached helper that waits for the app to exit, moves the install to `stateDir/backup/`, moves the new tree in, relaunches, and rolls back if the new version does not confirm within 60 s |
| `ProgressListener` | Pass to `prepare` | Called with `PrepareProgress` (phase, bytes done and total of that phase) from worker threads. `progress.fraction` is the whole `prepare()` from 0.0 to 1.0 for a single bar, e.g. `LinearProgressIndicator(progress = { fraction.toFloat() })` after posting it to the UI thread |
| `markLaunchSucceeded()` | Every start, once the app works (first window shown) | Confirms the launch to the helper; cleans old staging and backups |

`stateDir` belongs to the app and holds staged trees, one backup of the
previous version, the helper script and its log: use
`~/Library/Application Support/<App>/hands-updates` on macOS and
`~/.local/state/<app>/hands-updates` on Linux, outside the install and
preferably on the same volume, so the swap is a rename. The user must be able
to rename the install directory. On Linux, pass `launcher` (for example
`bin/Raft`) to `installAndRestart` unless the running executable is inside the
install directory. Windows can check and prepare, but `installAndRestart` is
not implemented there yet.

## Integrity and signing

Every file is addressed and checked by SHA-256: Hands refuses an upload
whose bytes do not match its declared digest, and a client checks each
download against the manifest. Hands does not sign or notarize desktop apps.
Code signing (Developer ID and notarization, Authenticode, package
signatures) belongs to your build: sign the bundle before publishing it, so
the files Hands stores are the signed ones.

## Publisher API

The CLI uses these routes; any client with the app's publisher role or a
deploy token can call them.

```http
POST /api/apps/:appId/desktop/files/missing
{"files":[{"sha256":"…","size":123}]}
```

Up to 1,000 entries; ask in chunks for a larger bundle. Answers
`{"missing":[{"sha256","size","upload_url","headers","expires_at"}],"present_count":N}`;
PUT each missing file to its `upload_url` with the given `content-type`
header within an hour. When a URL has expired (`403`), ask again for that
digest. An upload that is never completed stays in staging until the app is
deleted, which removes it with the rest of the app's files.

```http
POST /api/apps/:appId/desktop/files/complete
{"files":[{"sha256":"…","size":123}]}
```

Up to 100 entries. Hands copies each uploaded file into content-addressed
storage, refusing a digest or size mismatch, and answers
`{"ok","stored","present","failed","results":[{"sha256","size","status","retryable"}]}`.
`status` is `stored`, `present` (already held), `missing_upload`,
`size_mismatch`, `sha256_mismatch`, or `storage_error` (`retryable: true`).
Repeating a completion is safe.

The manifest, archive and installer are uploaded with the ordinary
[direct build asset upload](cli-reference.md#publish-hands-hosted-cli-binaries)
protocol, with `platform` and `arch` from the target.
