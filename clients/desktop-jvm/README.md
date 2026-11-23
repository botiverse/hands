# Hands Desktop Updater (JVM)

Kotlin/JVM client for Hands `desktop` apps: checks for an update, builds the
new app bundle from the unchanged files of the installed copy plus the changed
files downloaded from Hands, and swaps it in after the app exits, rolling back
when the new version does not confirm its launch. Server contract:
[Ship a desktop app](../../docs/public/desktop-apps.md).

- Artifact: `build.hands:hands-desktop-updater` (not published yet; build
  from this directory)
- JDK 17 or newer. Uses `java.net.http.HttpClient`, so a jlinked runtime
  needs the `java.net.http` module.
- One dependency: `org.jetbrains.kotlinx:kotlinx-serialization-json` (JSON
  tree parsing only; no compiler plugin).
- macOS, Linux and Windows (the Windows swap helper needs Windows PowerShell
  5.1, which every supported Windows ships).

## API

```kotlin
class HandsDesktopUpdater(
    appSlug: String,
    apiOrigin: String = "https://hands.build",
    channel: String = "main",
    target: String = HandsDesktopUpdater.detectTarget(), // darwin-arm64, linux-x64, ...
    currentVersionCode: Long,
    installRoot: Path,          // /Applications/Raft.app, or the install directory
    stateDir: Path,             // owned by the app, outside installRoot
    deviceId: String? = null,   // stable per install; needed for staged rollouts
    httpClient: HttpClient? = null,
    parallelism: Int = 4,
    downloadStallTimeout: Duration = Duration.ofSeconds(30), // no bytes for this long: abandon and retry
)

fun installBlocker(): InstallBlocker?            // TRANSLOCATED | READ_ONLY_VOLUME | NOT_WRITABLE | MISSING, or null
fun checkForUpdate(): UpdateCheck                 // NoUpdate(latestVersionCode) | Available(release, manifest, fullArchive, installer, ...)
fun prepare(update: UpdateCheck.Available, progress: ProgressListener? = null): PreparedUpdate
fun loadPrepared(): PreparedUpdate?               // a tree an earlier prepare() left staged
fun installAndRestart(prepared: PreparedUpdate, relaunchArgs: List<String> = emptyList(), launcher: String? = null)
fun markLaunchSucceeded()
fun lastInstallResult(): InstallResult?           // INSTALLED | ROLLED_BACK | ABORTED, with the version code
```

Every call blocks; run it off the UI thread. Failures are
`HandsUpdateException` (subclasses `HttpStatusException`, `IntegrityException`,
`ManifestInvalidException`). `UpdateCheck.Available.forceUpdate` carries the
publisher's force-update flag; what to do with it (block the UI, nag) is the
app's choice.

## What `prepare` does

1. Downloads the manifest and checks its size and SHA-256 against the update
   check, then validates it with the rules Hands applies when publishing:
   relative paths without `.`/`..`, symlinks resolved through other symlinks
   and kept inside the root, modes of exactly three octal digits, case and
   Unicode collisions on darwin/win32 targets, Windows names on win32.
2. For every regular file, looks at the installed copy at the same path: same
   size, then same SHA-256 (streamed). Matches are reused (copied; files of
   1 MiB or more are cloned with `cp -c` on macOS, which costs no space on
   APFS).
3. Downloads each missing digest once from `files_url_template`, four at a
   time, three retries with backoff on transfer errors, 5xx/429, digest
   mismatches and downloads that receive nothing for `downloadStallTimeout`
   (30 s by default; the JDK client's own timeout ends once headers arrive); each download is size-capped and checked. When the missing
   bytes plus 32 KiB per missing file exceed the full archive, it downloads
   the archive instead, checks its SHA-256, and takes the missing files out of
   it by path, checking each one; anything still missing is then downloaded
   singly. Paths, modes and symlinks always come from the manifest, never from
   the zip's own entries or attributes, so the zip needs no Unix attributes.
4. Assembles `stateDir/staging/<version_code>/<root>`: files, symlinks, then
   (after hashing) modes.
5. Walks the staged tree: every manifest entry present with the right type,
   size, link target, mode and SHA-256; no extra file, link or directory.
   Writes `stateDir/staging/<version_code>/.hands-prepared.json`.

Any failure deletes the staging directory; the install is never written to.

## What `installAndRestart` does

It writes `stateDir/hands-swap.sh` (POSIX sh, all paths baked in), starts it
detached, and returns. **The app must then exit**. The helper:

1. waits for the app's PID to exit (120 s; on timeout: result `ABORTED`,
   nothing changed, the staged tree is kept);
2. `mv installRoot stateDir/backup/<name>-<old code>-<time>`, then
   `mv staged root installRoot` (a rename on one filesystem; `mv` copies across
   filesystems);
3. relaunches: `open -n <bundle> --args …` on macOS, the launcher executable on
   Linux;
4. waits up to 60 s for the marker `markLaunchSucceeded()` writes with the new
   version code. Confirmed: deletes the staging directory and every backup but
   this one (`INSTALLED`). Not confirmed: stops the new process
   (TERM, then KILL; on macOS by `pkill -f <bundle>/Contents/MacOS/`), moves
   the backup back, relaunches the old version (`ROLLED_BACK`).

It logs to `stateDir/hands-swap.log`; `lastInstallResult()` reads the outcome.

On Windows the helper is `stateDir/hands-swap.ps1`, run by Windows PowerShell
with the same steps, and the launcher (`launcher`, or this process's
executable) is started directly with the relaunch arguments quoted for the
Windows command line. Windows refuses to rename a directory while any process
holds a file in it open (an antivirus scan, the indexer), so each move is
retried for up to 15 s, and a move across volumes falls back to copy plus
delete. Stopping an unconfirmed version is `CloseMainWindow`, then a forced
stop after the grace time.

## Required app behaviour

- Call `markLaunchSucceeded()` on every start once the app is known to work
  (for example after the first window is shown), within 60 s of launch. It
  also removes leftovers from earlier updates.
- After `installAndRestart`, exit promptly (within 120 s).
- The user must be able to rename `installRoot` (its parent must be writable):
  an app in `/Applications` installed by an admin user is fine; a standard
  user or a translocated (quarantined, never moved) app cannot self-update.
- Keep `stateDir` outside `installRoot`, preferably on the same volume. Use
  `~/Library/Application Support/<App>/hands-updates` on macOS and
  `${XDG_STATE_HOME:-~/.local/state}/<app>/hands-updates` on Linux.
- On Linux pass `launcher` (relative to `installRoot`, e.g. `bin/Raft`) unless
  the running process's executable is inside `installRoot`.

## Deliberately not done

- No signature checks: integrity is the SHA-256 Hands declares (by design).
- No `com.apple.quarantine` handling: files the app downloads itself are not
  quarantined.
- No resumable downloads; a failed `prepare` starts again.

## Build and test

```bash
gradle -p clients/desktop-jvm test
HANDS_DESKTOP_IT=1 gradle -p clients/desktop-jvm test   # also the read-only hands-desktop-smoke test
```
