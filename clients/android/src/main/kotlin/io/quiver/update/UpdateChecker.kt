package io.quiver.update

import android.app.DownloadManager
import android.content.Context
import android.content.IntentFilter
import io.quiver.update.installer.ApkInstaller
import io.quiver.update.internal.QuiverClient
import io.quiver.update.models.UpdateCheckResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * High-level entry point for "check if there's a new version on the quiver
 * server, and if so, install it".
 *
 * Typical usage from an Activity:
 *
 * ```kotlin
 * class MainActivity : ComponentActivity() {
 *     private val checker by lazy {
 *         UpdateChecker(
 *             context = applicationContext,
 *             baseUrl = "https://your-quiver-server.workers.dev",
 *             appSlug = "slock-android",
 *             installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
 *         )
 *     }
 *
 *     override fun onStart() {
 *         super.onStart()
 *         checker.checkAndInstall()  // suspends; show progress UI before
 *     }
 * }
 * ```
 *
 * Behavior:
 *  1. Hits `GET /public/v2/apps/{slug}/updates/check`.
 *  2. The server resolves scope/rollout, compares version_code, and picks
 *     one APK asset for this device.
 *  3. If `update_available` is true, queues a download via DownloadManager.
 *  4. Registers a [BroadcastReceiver] that fires ACTION_INSTALL_PACKAGE
 *     when the download finishes.
 *  5. If no update is available, returns silently.
 */
class UpdateChecker(
    private val context: Context,
    private val baseUrl: String,
    private val appSlug: String,
    private val installedVersionCode: Long,
    private val channel: String = "main",
    private val productType: String = "android-apk",
    private val platform: String = "android",
    private val arch: String? = null,
    private val client: QuiverClient = QuiverClient(baseUrl),
    private val installer: ApkInstaller = ApkInstaller(context),
    private val deviceId: String? = null,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /**
     * Check for an update; if newer, download and trigger install.
     *
     * The call to [ApkInstaller.downloadAndInstall] registers a sticky
     * BroadcastReceiver scoped to [context] (typically Application).
     * For shorter-lived receivers, use [checkForUpdate] and manage
     * installation yourself.
     *
     * @return UpdateCheckResponse (always, even when no update) so the
     *         caller can display a "you are up to date" message.
     */
    suspend fun checkAndInstall(): UpdateCheckResponse {
        val response = client.checkForUpdate(
            slug = appSlug,
            channel = channel,
            currentVersionCode = installedVersionCode,
            productType = productType,
            platform = platform,
            arch = arch,
            deviceId = deviceId ?: QuiverDeviceId.get(context),
        )
        if (response.requireUpdate() != null) {
            installUpdate(response)
        }
        return response
    }

    /**
     * Fire-and-forget variant for non-suspending call sites (e.g. onStart).
     * Exceptions are swallowed and logged — the caller can subscribe to
     * [errors] if it cares.
     */
    fun checkAndInstallAsync() {
        scope.launch {
            try {
                checkAndInstall()
            } catch (e: Exception) {
                // Quietly no-op; alternative is to surface to caller via
                // a SharedFlow or callback. Keep it simple here.
                e.printStackTrace()
            }
        }
    }

    private fun installUpdate(response: UpdateCheckResponse) {
        val (latest, asset) = response.requireUpdate() ?: return
        val downloadId = installer.downloadAndInstall(
            downloadUrl = asset.download_url,
            fileName = "quiver-${appSlug}-${latest.version_code}.apk",
            title = "${response.app.slug} v${latest.version}",
        )
        val receiver = installer.createInstallReceiver(downloadId)
        // Register on Application context so the receiver survives Activity death.
        if (context is android.app.Application) {
            context.registerReceiver(
                receiver,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            )
        }
    }
}
