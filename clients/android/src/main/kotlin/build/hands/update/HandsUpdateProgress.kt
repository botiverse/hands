package build.hands.update

import android.app.DownloadManager
import build.hands.update.installer.ApkDownloadStatus
import build.hands.update.installer.DownloadState
import kotlinx.serialization.Serializable
import java.util.concurrent.ConcurrentHashMap

/**
 * Bytes transferred for the update that is downloading now: the full APK
 * while [HandsUpdateState.DOWNLOADING], the binary patch while
 * [HandsUpdateState.PATCHING].
 *
 * [totalBytes] is null when the server did not announce a length.
 * [paused] is true while Android's DownloadManager holds the download, for
 * the reason in [pauseReason] (`waiting_for_network`, `waiting_for_wifi`,
 * `waiting_to_retry` or `unknown`).
 */
@Serializable
data class HandsUpdateProgress(
    val downloadedBytes: Long,
    val totalBytes: Long? = null,
    val paused: Boolean = false,
    val pauseReason: String? = null,
) {
    /** Whole percent in 0..100, or null while the total is unknown. */
    val percent: Int?
        get() = totalBytes?.takeIf { it > 0 }?.let { total ->
            (downloadedBytes.coerceIn(0, total) * 100 / total).toInt()
        }
}

/** Error code on a READY_TO_INSTALL status while Android blocks installs from this app. */
const val INSTALL_PERMISSION_REQUIRED = "install_permission_required"

internal fun downloadProgress(status: ApkDownloadStatus): HandsUpdateProgress? {
    val paused = when (status.state) {
        DownloadState.PENDING, DownloadState.RUNNING -> false
        DownloadState.PAUSED -> true
        else -> return null
    }
    return HandsUpdateProgress(
        downloadedBytes = (status.downloadedBytes ?: 0L).coerceAtLeast(0L),
        totalBytes = status.totalBytes?.takeIf { it > 0L },
        paused = paused,
        pauseReason = if (paused) pauseReason(status.reason) else null,
    )
}

internal fun pauseReason(reason: Int?): String = when (reason) {
    DownloadManager.PAUSED_WAITING_FOR_NETWORK -> "waiting_for_network"
    DownloadManager.PAUSED_QUEUED_FOR_WIFI -> "waiting_for_wifi"
    DownloadManager.PAUSED_WAITING_TO_RETRY -> "waiting_to_retry"
    else -> "unknown"
}

internal fun isActiveUpdateState(state: HandsUpdateState): Boolean = when (state) {
    HandsUpdateState.CHECKING,
    HandsUpdateState.PATCHING,
    HandsUpdateState.DOWNLOADING,
    -> true

    else -> false
}

/**
 * Whether [install] should reopen the verified local APK after the update
 * check failed (offline, server error). The check leaves a READY or OPENED
 * transaction untouched when it fails, so an unchanged pending installer
 * state means nothing newer could be learned and the file is still valid.
 */
internal fun shouldReopenAfterFailedCheck(
    before: HandsUpdateState,
    after: HandsUpdateState,
): Boolean {
    val pending = setOf(HandsUpdateState.READY_TO_INSTALL, HandsUpdateState.INSTALLER_OPENED)
    return before in pending && after in pending
}

internal fun installPermissionGranted(sdkInt: Int, canRequestPackageInstalls: () -> Boolean): Boolean =
    sdkInt < 26 || canRequestPackageInstalls()

/** Two statuses describe the same thing for a UI when only their timestamps differ. */
internal fun sameStatusForObservers(a: HandsUpdateStatus, b: HandsUpdateStatus): Boolean =
    a.copy(updatedAt = null) == b.copy(updatedAt = null)

/** One DownloadManager row whose destination is an SDK update file. */
internal data class SdkDownloadRow(
    val id: Long,
    val state: DownloadState,
    val localPath: String?,
)

/**
 * DownloadManager rows of SDK update files that can go: failed rows, and
 * finished rows whose APK is gone or is not newer than the installed build.
 * A finished row keeps the system's "downloaded" notification alive, so it
 * is removed once its version is installed. Rows still downloading, and
 * finished rows of a newer version (another channel's pending install), stay.
 */
internal fun staleSdkDownloadIds(
    rows: List<SdkDownloadRow>,
    keepId: Long?,
    installedVersionCode: Long?,
    archiveVersionCode: (path: String) -> Long?,
): List<Long> = rows.filter { row ->
    if (row.id == keepId) return@filter false
    when (row.state) {
        DownloadState.FAILED -> true
        DownloadState.SUCCESSFUL -> {
            val path = row.localPath ?: return@filter true
            val version = archiveVersionCode(path) ?: return@filter true
            installedVersionCode != null && version <= installedVersionCode
        }
        else -> false
    }
}.map { it.id }

private val SDK_DOWNLOAD_NAME = Regex("^hands-update-[0-9A-Fa-f-]{36}\\.apk$")

internal fun isSdkDownloadFileName(name: String): Boolean = SDK_DOWNLOAD_NAME.matches(name)

/** Patch download progress per update authority, read by status observers. */
internal object PatchProgressRegistry {
    private val entries = ConcurrentHashMap<String, HandsUpdateProgress>()

    fun set(key: String, progress: HandsUpdateProgress) {
        entries[key] = progress
    }

    fun get(key: String): HandsUpdateProgress? = entries[key]

    fun clear(key: String) {
        entries.remove(key)
    }
}

/**
 * Update authorities with a patch running in this process. A PATCHING
 * transaction is only real while its patch is in here: the record is written
 * to disk, the patch itself is not, so a process killed mid-patch leaves a
 * PATCHING record that nothing will ever finish.
 */
internal object ActivePatchRegistry {
    private val keys = ConcurrentHashMap.newKeySet<String>()

    fun begin(key: String) {
        keys.add(key)
    }

    fun end(key: String) {
        keys.remove(key)
    }

    fun isActive(key: String): Boolean = keys.contains(key)

    fun isAnyActive(): Boolean = keys.isNotEmpty()
}

/**
 * Whether a persisted PATCHING transaction must be given up: no patch for it
 * runs in this process (it died mid-patch), or it ran past the patch timeout.
 */
internal fun isPatchingAbandoned(activeInThisProcess: Boolean, expired: Boolean): Boolean =
    !activeInThisProcess || expired

private val DELTA_TEMP_NAME = Regex("^hands-delta-.+\\.(patch|apk)$")

/**
 * Patch downloads and half-built APKs a dead patch left behind. Only call
 * when no patch runs and no verified delta APK is the current authority.
 */
internal fun isDeltaTempFileName(name: String): Boolean = DELTA_TEMP_NAME.matches(name)
