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

    fun downloadAndInstall(
        downloadUrl: String,
        fileName: String = "quiver-update.apk",
        title: String = "App update",
    ): Long {
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

        return dm.enqueue(request)
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
        val authority = "${context.packageName}.hands.fileprovider"
        val apkUri = FileProvider.getUriForFile(context, authority, file)
        triggerApkInstall(context, apkUri)
    }

    private companion object {
        const val TAG = "HandsApkInstaller"
    }
}
