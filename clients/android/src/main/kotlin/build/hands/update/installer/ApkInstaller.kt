package build.hands.update.installer

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.ContextCompat
import java.io.File

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

        // For Android 10+, use a public Downloads subdir so the system
        // installer can read the file without scoped storage gymnastics.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(
                Environment.DIRECTORY_DOWNLOADS,
                fileName,
            )
        } else {
            @Suppress("DEPRECATION")
            request.setDestinationInExternalFilesDir(
                context,
                Environment.DIRECTORY_DOWNLOADS,
                fileName,
            )
        }

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
                val dm = ContextCompat.getSystemService(
                    ctx ?: context,
                    DownloadManager::class.java,
                ) ?: return
                val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id != downloadId) return
                triggerInstall(ctx ?: context, dm, id)
            }
        }
    }

    private fun triggerInstall(ctx: Context, dm: DownloadManager, downloadId: Long) {
        val query = DownloadManager.Query().setFilterById(downloadId)
        val cursor: Cursor = dm.query(query)
        if (!cursor.moveToFirst()) {
            cursor.close()
            return
        }
        val columnIndex = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
        val localUriString = if (columnIndex >= 0) cursor.getString(columnIndex) else null
        cursor.close()

        if (localUriString == null) return
        val apkUri = Uri.parse(localUriString)

        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        ctx.startActivity(install)
    }
}