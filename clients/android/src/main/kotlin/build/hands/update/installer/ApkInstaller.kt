package build.hands.update.installer

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.net.URI

internal enum class DownloadState {
    PENDING,
    RUNNING,
    PAUSED,
    SUCCESSFUL,
    FAILED,
    MISSING,
    READ_UNAVAILABLE,
    UNKNOWN,
}

internal data class ApkDownloadStatus(
    val state: DownloadState,
    val reason: Int? = null,
    val downloadedBytes: Long? = null,
    val totalBytes: Long? = null,
)

internal fun downloadStateFromRawStatus(rawStatus: Int): DownloadState = when (rawStatus) {
    DownloadManager.STATUS_PENDING -> DownloadState.PENDING
    DownloadManager.STATUS_RUNNING -> DownloadState.RUNNING
    DownloadManager.STATUS_PAUSED -> DownloadState.PAUSED
    DownloadManager.STATUS_SUCCESSFUL -> DownloadState.SUCCESSFUL
    DownloadManager.STATUS_FAILED -> DownloadState.FAILED
    else -> DownloadState.UNKNOWN
}

internal inline fun readDownloadStatus(
    read: () -> ApkDownloadStatus?,
): ApkDownloadStatus = try {
    read() ?: ApkDownloadStatus(DownloadState.READ_UNAVAILABLE)
} catch (_: Exception) {
    ApkDownloadStatus(DownloadState.READ_UNAVAILABLE)
}

data class EnqueuedApkDownload(
    val id: Long,
    val destination: File,
)

internal enum class DownloadInstallResult {
    IGNORED,
    UNAVAILABLE_OR_UNSAFE_URI,
    INSTALL_STARTED,
    INSTALL_FAILED,
}

internal fun validatedApkContentUri(uriString: String?): String? {
    val candidate = uriString?.takeIf { it.isNotBlank() } ?: return null
    val parsed = try {
        URI(candidate)
    } catch (_: Exception) {
        return null
    }
    return candidate.takeIf {
        parsed.scheme.equals("content", ignoreCase = true) &&
            !parsed.rawAuthority.isNullOrBlank()
    }
}

internal fun resolveDownloadedApkContentUri(
    uriString: String?,
    fileProviderUri: (File) -> String,
): String? {
    val candidate = uriString?.takeIf { it.isNotBlank() } ?: return null
    val parsed = try {
        URI(candidate)
    } catch (_: Exception) {
        return null
    }
    return when {
        parsed.scheme.equals("content", ignoreCase = true) ->
            validatedApkContentUri(candidate)
        parsed.scheme.equals("file", ignoreCase = true) -> {
            val file = try {
                File(parsed)
            } catch (_: Exception) {
                return null
            }
            validatedApkContentUri(fileProviderUri(file))
        }
        else -> null
    }
}

internal fun handleCompletedDownload(
    expectedDownloadId: Long,
    completedDownloadId: Long,
    downloadedUri: (Long) -> String?,
    fileProviderUri: (File) -> String,
    launchInstaller: (String) -> Unit,
    onFailure: (Exception) -> Unit = {},
): DownloadInstallResult {
    if (completedDownloadId != expectedDownloadId) return DownloadInstallResult.IGNORED

    return try {
        val apkUri = resolveDownloadedApkContentUri(
            downloadedUri(completedDownloadId),
            fileProviderUri,
        )
            ?: return DownloadInstallResult.UNAVAILABLE_OR_UNSAFE_URI
        launchInstaller(apkUri)
        DownloadInstallResult.INSTALL_STARTED
    } catch (exception: Exception) {
        try {
            onFailure(exception)
        } catch (_: Exception) {
            // Receiver failures must never escape into the host process.
        }
        DownloadInstallResult.INSTALL_FAILED
    }
}

internal fun apkInstallIntentFlags(): Int =
    Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION

internal fun triggerApkInstall(ctx: Context, apkUri: Uri) {
    if (validatedApkContentUri(apkUri.toString()) == null) return
    val install = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(apkUri, "application/vnd.android.package-archive")
        flags = apkInstallIntentFlags()
    }
    ctx.startActivity(install)
}

/**
 * Downloads the APK from [downloadUrl] using Android's DownloadManager and
 * triggers the system installer on completion.
 *
 * Uses DownloadManager (rather than OkHttp) so the download:
 *  - Survives Activity recreation
 *  - Is visible in the system notification shade
 *  - Doesn't require a foreground Service for downloads > a few MB
 *  - Honors mobile data restrictions
 *
 * After the download completes, the OS shows the system install prompt.
 */
class ApkInstaller(private val context: Context) {

    fun enqueueDownload(
        downloadUrl: String,
        fileName: String = "quiver-update.apk",
        title: String = "App update",
    ): EnqueuedApkDownload {
        val destination = downloadDestination(fileName)
        if (destination.exists() && !destination.delete()) {
            throw IllegalStateException("unable to replace previous SDK update file")
        }

        val dm = ContextCompat.getSystemService(context, DownloadManager::class.java)
            ?: throw IllegalStateException("DownloadManager not available")

        val request = DownloadManager.Request(Uri.parse(downloadUrl))
            .setTitle(title)
            .setDescription("Downloading latest version…")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
            .setMimeType("application/vnd.android.package-archive")

        // Keep the file app-scoped. DownloadManager may still report it as a
        // file:// URI, which the completion path converts through FileProvider.
        request.setDestinationInExternalFilesDir(
            context,
            Environment.DIRECTORY_DOWNLOADS,
            fileName,
        )

        return EnqueuedApkDownload(dm.enqueue(request), destination)
    }

    fun downloadAndInstall(
        downloadUrl: String,
        fileName: String = "quiver-update.apk",
        title: String = "App update",
    ): Long = enqueueDownload(downloadUrl, fileName, title).id

    fun downloadDestination(fileName: String): File {
        require(fileName.matches(Regex("^[A-Za-z0-9._-]+\\.apk$"))) {
            "unsafe APK file name"
        }
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IllegalStateException("app-scoped Downloads directory unavailable")
        return File(directory, fileName)
    }

    internal fun queryDownload(downloadId: Long): ApkDownloadStatus {
        val dm = ContextCompat.getSystemService(context, DownloadManager::class.java)
            ?: return ApkDownloadStatus(DownloadState.READ_UNAVAILABLE)
        return readDownloadStatus {
            val cursor = dm.query(DownloadManager.Query().setFilterById(downloadId))
                ?: return@readDownloadStatus null
            cursor.use {
                if (!it.moveToFirst()) return@readDownloadStatus ApkDownloadStatus(DownloadState.MISSING)
                val rawStatus = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val reason = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                val downloaded = it.getLong(
                    it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                )
                val total = it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                ApkDownloadStatus(
                    downloadStateFromRawStatus(rawStatus),
                    reason,
                    downloaded,
                    total,
                )
            }
        }
    }

    internal fun removeDownload(downloadId: Long): Boolean {
        val dm = ContextCompat.getSystemService(context, DownloadManager::class.java)
            ?: return queryDownload(downloadId).state == DownloadState.MISSING
        return try {
            dm.remove(downloadId)
            queryDownload(downloadId).state == DownloadState.MISSING
        } catch (_: Exception) {
            false
        }
    }

    /** Reopens the exact SDK-owned APK file through the SDK FileProvider. */
    fun installDownloadedApk(file: File): String {
        val authority = "${context.packageName}.hands.fileprovider"
        val apkUri = FileProvider.getUriForFile(context, authority, file)
        triggerApkInstall(context, apkUri)
        return apkUri.toString()
    }

    /**
     * Observe the download completion and trigger the system install prompt.
     *
     * Returns a BroadcastReceiver that the caller must register (and
     * unregister) — typically from an Activity's lifecycle.
     */
    fun createInstallReceiver(downloadId: Long): BroadcastReceiver {
        return object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                try {
                    val receiverContext = ctx ?: context
                    val dm = ContextCompat.getSystemService(
                        receiverContext,
                        DownloadManager::class.java,
                    ) ?: return
                    val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                    val result = handleCompletedDownload(
                        expectedDownloadId = downloadId,
                        completedDownloadId = id ?: -1L,
                        downloadedUri = { dm.getUriForDownloadedFile(it)?.toString() },
                        fileProviderUri = {
                            FileProvider.getUriForFile(
                                receiverContext,
                                "${receiverContext.packageName}.hands.fileprovider",
                                it,
                            ).toString()
                        },
                        launchInstaller = { triggerApkInstall(receiverContext, Uri.parse(it)) },
                        onFailure = {
                            Log.e(TAG, "Unable to launch the package installer", it)
                        },
                    )
                    if (result == DownloadInstallResult.UNAVAILABLE_OR_UNSAFE_URI) {
                        Log.e(TAG, "Downloaded APK URI was unavailable or unsafe")
                    }
                } catch (exception: Exception) {
                    Log.e(TAG, "Unable to handle the completed APK download", exception)
                }
            }
        }
    }

    /**
     * Completion signal for the persistent transaction controller. It does not
     * trust or launch the returned URI; the controller reconciles and verifies
     * the exact SDK-owned destination before opening the installer.
     */
    fun createDownloadCompletionReceiver(
        downloadId: Long,
        onComplete: () -> Unit,
    ): BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            val completedId = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                ?: -1L
            if (completedId != downloadId) return
            try {
                onComplete()
            } catch (exception: Exception) {
                Log.e(TAG, "Unable to reconcile the completed APK download", exception)
            }
        }
    }

    /**
     * Trigger the system install prompt for an APK that already lives on disk
     * (e.g. one reconstructed locally by the delta updater), rather than one
     * fetched via DownloadManager.
     *
     * The file is expected to sit in the host app's private cacheDir; it is
     * shared with the installer through the SDK's FileProvider (authority
     * `${'$'}{applicationId}.hands.fileprovider`, declared in the SDK manifest)
     * so no world-readable storage is needed.
     */
    fun installLocalApk(file: File) {
        installDownloadedApk(file)
    }

    private companion object {
        const val TAG = "HandsApkInstaller"
    }
}
