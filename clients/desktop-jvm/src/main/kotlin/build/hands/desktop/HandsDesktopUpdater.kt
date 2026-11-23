package build.hands.desktop

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.net.URLEncoder
import java.net.http.HttpClient
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration

/**
 * Update client for a Hands `desktop` app: checks for a newer release, builds the new
 * tree next to the installed one from unchanged local files plus downloaded changed
 * ones, and swaps it in through a helper after the app exits, rolling back when the
 * new version does not confirm its launch.
 *
 * All calls block; run them off the UI thread. One instance per process; do not run two
 * [prepare] calls for the same state directory at once.
 *
 * @param installRoot the installed bundle (`/Applications/Raft.app`) or install directory.
 * @param stateDir a directory the app owns, outside [installRoot], for staging, backups
 *   and launch markers; ideally on the same volume as [installRoot] so the swap is a rename.
 * @param deviceId a stable per-install id; needed to receive staged rollouts.
 */
public class HandsDesktopUpdater @JvmOverloads constructor(
    public val appSlug: String,
    public val apiOrigin: String = "https://hands.build",
    public val channel: String = "main",
    public val target: String = detectTarget(),
    public val currentVersionCode: Long,
    installRoot: Path,
    stateDir: Path,
    public val deviceId: String? = null,
    httpClient: HttpClient? = null,
    /** Concurrent file downloads and hashes. */
    public val parallelism: Int = 4,
    /** A file download that receives no bytes for this long is abandoned and retried. */
    public val downloadStallTimeout: Duration = Duration.ofSeconds(30),
) {
    public val installRoot: Path = installRoot.toAbsolutePath().normalize()
    public val stateDir: Path = stateDir.toAbsolutePath().normalize()

    private val client: HttpClient = httpClient ?: HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NORMAL)
        .connectTimeout(Duration.ofSeconds(30))
        .build()

    // Test seams.
    internal var retries: Int = 3
    internal var retryBackoffMillis: Long = 500
    internal var archivePolicy: ArchivePolicy = ArchivePolicy.AUTO
    internal var swapTimeouts: SwapTimeouts = SwapTimeouts()

    init {
        require(appSlug.isNotBlank()) { "appSlug is required" }
        require(target in DesktopManifest.TARGETS) { "target must be one of ${DesktopManifest.TARGETS}" }
        require(currentVersionCode >= 0) { "currentVersionCode must be non-negative" }
        require(parallelism in 1..32) { "parallelism must be 1-32" }
        require(!downloadStallTimeout.isNegative && !downloadStallTimeout.isZero) { "downloadStallTimeout must be positive" }
        require(!this.stateDir.startsWith(this.installRoot) && !this.installRoot.startsWith(this.stateDir)) {
            "stateDir and installRoot must not contain each other: the swap moves installRoot"
        }
    }

    private val http get() = Http(client, retries, retryBackoffMillis, downloadStallTimeout.toMillis())
    private val marker: Path get() = stateDir.resolve(MARKER)
    private val lock: Path get() = stateDir.resolve(LOCK)
    private val resultFile: Path get() = stateDir.resolve(RESULT)

    /** Ask Hands whether a newer release exists for this target and channel. */
    @Throws(HandsUpdateException::class)
    public fun checkForUpdate(): UpdateCheck {
        val url = buildString {
            append(apiOrigin.trimEnd('/'))
            append("/public/v2/apps/").append(enc(appSlug)).append("/desktop/update")
            append("?target=").append(enc(target))
            append("&channel=").append(enc(channel))
            append("&current_version_code=").append(currentVersionCode)
        }
        val headers = buildMap {
            put("Accept", "application/json")
            deviceId?.takeIf { it.isNotBlank() }?.let { put("X-Hands-Device-Id", it) }
        }
        val (status, bytes) = try {
            http.getBytes(url, headers, 1 shl 20)
        } catch (e: HandsUpdateException) {
            throw e
        } catch (e: Exception) {
            if (e is InterruptedException) throw e
            throw HandsUpdateException("update check failed: $e", e)
        }
        val body = runCatching { Json.parseToJsonElement(bytes.decodeToString()).jsonObject }.getOrNull()
        if (status != 200) {
            val code = body?.get("code")?.str()
            val message = body?.get("error")?.str() ?: "HTTP $status"
            throw HttpStatusException(status, code, "update check: $message")
        }
        body ?: throw HandsUpdateException("update check: answer is not a JSON object")
        return parseCheck(body, System.currentTimeMillis())
    }

    /**
     * Build and verify the new tree under `stateDir/staging/<version_code>/<root>`. On any
     * failure the staging directory is removed and the install is untouched.
     */
    @Throws(HandsUpdateException::class)
    @JvmOverloads
    public fun prepare(update: UpdateCheck.Available, progress: ProgressListener? = null): PreparedUpdate {
        // A missing root is only fatal at install time; staging can still build a full tree.
        requireInstallable(allowMissing = true)
        return Stager(http, target, installRoot, stateDir, parallelism, archivePolicy).prepare(update, progress)
    }

    /**
     * Why this install cannot be replaced in place, or null when it can. Local checks only,
     * no network: call it before [checkForUpdate] and, for TRANSLOCATED or
     * READ_ONLY_VOLUME, ask the user to move the app to Applications first. [prepare] and
     * [installAndRestart] refuse with [InstallBlockedException] for the same reasons.
     */
    public fun installBlocker(): InstallBlocker? = InstallCheck.blocker(installRoot)

    private fun requireInstallable(allowMissing: Boolean = false) {
        val blocker = installBlocker() ?: return
        if (allowMissing && blocker == InstallBlocker.MISSING) return
        throw InstallBlockedException(blocker, InstallCheck.describe(blocker, installRoot))
    }

    /** A tree an earlier [prepare] left staged for a version newer than this one, if any. */
    public fun loadPrepared(): PreparedUpdate? {
        val staging = stateDir.resolve("staging")
        if (!Files.isDirectory(staging)) return null
        return Files.list(staging).use { dirs ->
            dirs.toList().mapNotNull { dir ->
                runCatching {
                    val r = Json.parseToJsonElement(Files.readString(dir.resolve(Stager.RECEIPT))).jsonObject
                    val code = r["version_code"]!!.jsonPrimitive.longOrNull!!
                    val root = dir.resolve(r["root"]!!.str()!!)
                    if (code <= currentVersionCode || r["target"]?.str() != target || !Files.isDirectory(root)) return@runCatching null
                    PreparedUpdate(
                        release = DesktopRelease(
                            id = r["release_id"]!!.str()!!,
                            version = r["version"]!!.str()!!,
                            versionCode = code,
                            notesUrl = r["notes_url"]?.str(),
                            forceUpdate = r["force_update"]?.jsonPrimitive?.booleanOrNull ?: false,
                            releasedAtMillis = null,
                        ),
                        stagedRoot = root,
                        manifestSha256 = r["manifest_sha256"]!!.str()!!,
                        fileCount = r["file_count"]?.jsonPrimitive?.longOrNull?.toInt() ?: 0,
                        totalBytes = r["total_size"]?.jsonPrimitive?.longOrNull ?: 0,
                        reusedFiles = 0, downloadedFiles = 0, downloadedBytes = 0, usedFullArchive = false,
                    )
                }.getOrNull()
            }.maxByOrNull { it.release.versionCode }
        }
    }

    /**
     * Start the swap helper and return; the app must then exit promptly (the helper waits
     * for this process to end). The helper moves [installRoot] to `stateDir/backup/…`, moves
     * the staged tree into its place, relaunches the app, and waits for
     * [markLaunchSucceeded] from the new version; without it the old tree is restored and
     * relaunched. macOS and Linux only.
     *
     * @param relaunchArgs arguments for the relaunched app.
     * @param launcher Linux: the executable to start, relative to [installRoot]; by default
     *   this process's own executable when it lies inside [installRoot]. Ignored on macOS,
     *   which relaunches the bundle with `open -n`.
     */
    @Throws(HandsUpdateException::class)
    @JvmOverloads
    public fun installAndRestart(prepared: PreparedUpdate, relaunchArgs: List<String> = emptyList(), launcher: String? = null) {
        val mode = if (Platform.os == "darwin") RelaunchMode.OPEN else RelaunchMode.EXEC
        installAndRestart(prepared, relaunchArgs, launcher, ProcessHandle.current().pid(), mode)
    }

    internal fun installAndRestart(
        prepared: PreparedUpdate,
        relaunchArgs: List<String>,
        launcher: String?,
        appPid: Long,
        mode: RelaunchMode,
    ) {
        if (Platform.os == "win32") {
            throw UnsupportedOperationException("installAndRestart is not implemented on Windows yet; use the installer")
        }
        val stagingDir = stateDir.resolve("staging").resolve(prepared.release.versionCode.toString())
        if (prepared.stagedRoot.parent != stagingDir || !Files.isDirectory(prepared.stagedRoot) ||
            !Files.isRegularFile(stagingDir.resolve(Stager.RECEIPT))
        ) {
            throw HandsUpdateException("no prepared tree at ${prepared.stagedRoot}; call prepare() again")
        }
        requireInstallable()
        val launcherPath = when (mode) {
            RelaunchMode.OPEN -> null
            RelaunchMode.EXEC -> {
                val rel = launcher ?: ProcessHandle.current().info().command().orElse(null)
                    ?.let { Path.of(it).toAbsolutePath().normalize() }
                    ?.takeIf { it.startsWith(installRoot) }
                    ?.let { installRoot.relativize(it).toString() }
                    ?: throw HandsUpdateException("pass launcher: this process's executable is not inside $installRoot")
                val path = installRoot.resolve(rel).normalize()
                if (!path.startsWith(installRoot) || path == installRoot) throw HandsUpdateException("launcher must be inside installRoot")
                if (!Files.isExecutable(prepared.stagedRoot.resolve(installRoot.relativize(path)))) {
                    throw HandsUpdateException("launcher $rel is not an executable file in the new version")
                }
                path
            }
        }
        val stamp = System.currentTimeMillis()
        val spec = SwapHelper.Spec(
            appPid = appPid,
            installRoot = installRoot,
            stagedRoot = prepared.stagedRoot,
            stagingDir = stagingDir,
            backupDir = stateDir.resolve("backup"),
            backup = stateDir.resolve("backup").resolve("${installRoot.fileName}-$currentVersionCode-$stamp"),
            failedDir = stateDir.resolve("failed-${prepared.release.versionCode}"),
            marker = marker,
            lock = lock,
            result = resultFile,
            log = stateDir.resolve("hands-swap.log"),
            newVersionCode = prepared.release.versionCode,
            mode = mode,
            launcher = launcherPath,
            relaunchArgs = relaunchArgs,
            timeouts = swapTimeouts,
        )
        Files.createDirectories(stateDir)
        Files.deleteIfExists(marker)
        Files.deleteIfExists(resultFile)
        val script = stateDir.resolve(SwapHelper.SCRIPT)
        SwapHelper.write(spec, script)
        SwapHelper.launch(script)
    }

    /**
     * Call early in every start, once the app is up far enough to count as working. Confirms
     * the launch to a waiting swap helper, then (when no swap is running) removes staging
     * left from versions up to this one and all but the newest backup.
     */
    public fun markLaunchSucceeded() {
        writeAtomically(marker, currentVersionCode.toString())
        if (swapRunning()) return
        runCatching { cleanUp() }
    }

    /** What the last swap did, or null when none ran since the last [installAndRestart]. */
    public fun lastInstallResult(): InstallResult? {
        val text = runCatching { Files.readString(resultFile).trim() }.getOrNull() ?: return null
        val (word, code) = text.split(' ').takeIf { it.size == 2 } ?: return null
        val outcome = when (word) {
            "installed" -> InstallOutcome.INSTALLED
            "rolled-back" -> InstallOutcome.ROLLED_BACK
            "aborted" -> InstallOutcome.ABORTED
            else -> return null
        }
        return InstallResult(outcome, code.toLongOrNull() ?: return null)
    }

    private fun swapRunning(): Boolean {
        val pid = runCatching { Files.readString(lock).trim().toLong() }.getOrNull() ?: return false
        return ProcessHandle.of(pid).map { it.isAlive }.orElse(false)
    }

    private fun cleanUp() {
        val staging = stateDir.resolve("staging")
        if (Files.isDirectory(staging)) {
            Files.list(staging).use { it.toList() }.forEach { dir ->
                val code = dir.fileName.toString().toLongOrNull()
                if (code == null || code <= currentVersionCode || !Files.isRegularFile(dir.resolve(Stager.RECEIPT))) {
                    deleteTree(dir)
                }
            }
        }
        deleteTree(stateDir.resolve("work"))
        val backups = stateDir.resolve("backup")
        if (Files.isDirectory(backups)) {
            val all = Files.list(backups).use { it.toList() }
                .sortedByDescending { Files.getLastModifiedTime(it, java.nio.file.LinkOption.NOFOLLOW_LINKS).toMillis() }
            all.drop(1).forEach { deleteTree(it) }
        }
        Files.list(stateDir).use { it.toList() }
            .filter { it.fileName.toString().startsWith("failed-") }
            .forEach { deleteTree(it) }
    }

    public companion object {
        internal const val MARKER = "hands-launch-ok"
        internal const val LOCK = "hands-swap.lock"
        internal const val RESULT = "hands-swap-result"

        /** `darwin|win32|linux` + `-arm64|-x64` for the running JVM. */
        @JvmStatic
        public fun detectTarget(): String = Platform.detectTarget()

        private fun enc(value: String) = URLEncoder.encode(value, Charsets.UTF_8)

        private fun kotlinx.serialization.json.JsonElement.str(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        private fun asset(element: kotlinx.serialization.json.JsonElement?): RemoteAsset? {
            if (element == null || element is JsonNull) return null
            val o = element as? JsonObject ?: throw HandsUpdateException("update check: malformed asset")
            val url = o["url"]?.str() ?: throw HandsUpdateException("update check: asset without url")
            val sha = o["sha256"]?.str()?.lowercase() ?: throw HandsUpdateException("update check: asset without sha256")
            if (!DesktopManifest.isSha256(sha)) throw HandsUpdateException("update check: bad sha256")
            val size = o["size"]?.jsonPrimitive?.longOrNull ?: throw HandsUpdateException("update check: asset without size")
            return RemoteAsset(url, sha, size)
        }

        internal fun parseCheck(body: JsonObject, nowMillis: Long): UpdateCheck {
            val available = body["update_available"]?.jsonPrimitive?.booleanOrNull
                ?: throw HandsUpdateException("update check: no update_available")
            if (!available) return UpdateCheck.NoUpdate(body["latest_version_code"]?.jsonPrimitive?.longOrNull)
            val r = body["release"] as? JsonObject ?: throw HandsUpdateException("update check: no release")
            val release = DesktopRelease(
                id = r["id"]?.str() ?: throw HandsUpdateException("update check: release without id"),
                version = r["version"]?.str() ?: "",
                versionCode = r["version_code"]?.jsonPrimitive?.longOrNull
                    ?: throw HandsUpdateException("update check: release without version_code"),
                notesUrl = r["notes_url"]?.str(),
                forceUpdate = r["force_update"]?.jsonPrimitive?.booleanOrNull ?: false,
                releasedAtMillis = r["released_at"]?.jsonPrimitive?.longOrNull,
            )
            val installer = (body["installer"] as? JsonObject)?.let { o ->
                asset(o)?.let { InstallerAsset(it.url, it.sha256, it.size, o["filetype"]?.str()) }
            }
            val template = body["files_url_template"]?.str()
                ?.takeIf { it.contains("{sha256}") }
                ?: throw HandsUpdateException("update check: no files_url_template")
            val expiresIn = body["expires_in"]?.jsonPrimitive?.longOrNull ?: 3600
            return UpdateCheck.Available(
                release = release,
                manifest = asset(body["manifest"]) ?: throw HandsUpdateException("update check: no manifest"),
                fullArchive = asset(body["full_archive"]),
                installer = installer,
                filesUrlTemplate = template,
                expiresAtMillis = nowMillis + expiresIn * 1000,
            )
        }
    }
}
