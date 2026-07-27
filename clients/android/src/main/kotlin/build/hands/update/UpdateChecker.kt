package build.hands.update

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import build.hands.update.installer.ApkInstaller
import build.hands.update.installer.DownloadState
import build.hands.update.internal.DeltaUpdater
import build.hands.update.internal.HandsClient
import build.hands.update.models.LatestUpdate
import build.hands.update.models.Patch
import build.hands.update.models.UpdateAsset
import build.hands.update.models.UpdateCheckResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

internal const val DOWNLOAD_COMPLETED_SENDER_PERMISSION =
    "android.permission.SEND_DOWNLOAD_COMPLETED_INTENTS"

/**
 * DownloadManager completion is sent by a privileged package rather than the
 * system UID on some Android builds. The receiver must therefore be exported,
 * while the signature sender permission prevents third-party spoofing.
 */
internal fun downloadReceiverRegistrationFlags(sdkInt: Int): Int? =
    if (sdkInt >= Build.VERSION_CODES.TIRAMISU) Context.RECEIVER_EXPORTED else null

private fun Context.registerDownloadReceiver(
    receiver: BroadcastReceiver,
    filter: IntentFilter,
) {
    registerDownloadReceiverForSdk(
        sdkInt = Build.VERSION.SDK_INT,
        registerLegacy = { senderPermission ->
            @Suppress("DEPRECATION")
            registerReceiver(receiver, filter, senderPermission, null)
        },
        registerModern = { senderPermission, flags ->
            registerReceiver(receiver, filter, senderPermission, null, flags)
        },
    )
}

internal fun registerDownloadReceiverForSdk(
    sdkInt: Int,
    registerLegacy: (senderPermission: String) -> Unit,
    registerModern: (senderPermission: String, flags: Int) -> Unit,
) {
    val flags = downloadReceiverRegistrationFlags(sdkInt)
    if (flags == null) {
        registerLegacy(DOWNLOAD_COMPLETED_SENDER_PERMISSION)
    } else {
        registerModern(DOWNLOAD_COMPLETED_SENDER_PERMISSION, flags)
    }
}

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
 *  4. Persists the transaction and registers a [BroadcastReceiver] that
 *     reconciles the completed download before opening the package installer.
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
    private val client: HandsClient = HandsClient(baseUrl),
    private val installer: ApkInstaller = ApkInstaller(context),
    private val deviceId: String? = null,
    /** Master switch for client-side delta (incremental) update apply. */
    private val deltaApplyEnabled: Boolean = true,
    private val languageTag: String? = null,
    private val eventListener: HandsUpdateEventListener = HandsUpdateEventListener {},
    private val deltaUpdater: DeltaUpdater? = null,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val authority = UpdateAuthority(
        packageName = context.packageName,
        baseUrl = baseUrl,
        appSlug = appSlug,
        channel = channel,
        productType = productType,
        platform = platform,
        arch = arch,
    )
    private val commandMutex = commandMutexes.computeIfAbsent(authority.storageKey()) { Mutex() }
    private val transactionStore = UpdateTransactionStore(context, authority)
    private val effectiveDeltaUpdater: DeltaUpdater by lazy {
        deltaUpdater ?: DeltaUpdater(
            context = context,
            installedVersionCode = installedVersionCode,
            httpClient = HandsClient.defaultClient(),
            installer = installer,
            deltaApplyEnabled = deltaApplyEnabled,
            eventSink = { name, errorCode ->
                emit(name, HandsUpdateState.PATCHING, errorCode = errorCode)
            },
        )
    }

    /** Reconcile the persisted transaction with PackageManager, DownloadManager and disk. */
    suspend fun status(): HandsUpdateStatus = withContext(Dispatchers.IO) {
        reconcileTransaction()
    }

    /**
     * Idempotent install command for host UIs.
     *
     * A verified local APK is reopened, an active patch/download is left alone,
     * and only idle/failed/stale/installed transactions start a new check.
     */
    suspend fun install(languageTag: String? = this.languageTag): HandsUpdateStatus {
        return commandMutex.withLock {
            val current = withContext(Dispatchers.IO) { reconcileTransaction() }
            when (current.state) {
                HandsUpdateState.READY_TO_INSTALL,
                HandsUpdateState.INSTALLER_OPENED,
                -> withContext(Dispatchers.IO) { reopenPendingInstallerUnlocked() }

                HandsUpdateState.CHECKING,
                HandsUpdateState.PATCHING,
                HandsUpdateState.DOWNLOADING,
                -> current

                else -> {
                    try {
                        checkAndInstallUnlocked(languageTag)
                    } catch (_: Exception) {
                        // The command records the precise failure boundary.
                    }
                    withContext(Dispatchers.IO) { reconcileTransaction() }
                }
            }
        }
    }

    /** Reopen the same verified APK without checking or downloading again. */
    suspend fun reopenPendingInstaller(): HandsUpdateStatus = commandMutex.withLock {
        withContext(Dispatchers.IO) { reopenPendingInstallerUnlocked() }
    }

    private fun reopenPendingInstallerUnlocked(): HandsUpdateStatus {
        val current = reconcileTransaction()
        if (
            current.state != HandsUpdateState.READY_TO_INSTALL &&
            current.state != HandsUpdateState.INSTALLER_OPENED
        ) {
            return current
        }
        val record = transactionStore.read() ?: return idleStatus()
        val file = record.localFilePath?.let(::File)
        val validationError = validateLocalApk(record, file)
        if (validationError != null) {
            cleanup(record)
            return transition(
                record,
                HandsUpdateState.STALE,
                errorCode = validationError,
                retryable = true,
                clearLocalAuthority = true,
            ).status(installedVersionCodeNow())
        }
        return try {
            installer.installDownloadedApk(requireNotNull(file))
            emit(
                "content_uri_ready",
                HandsUpdateState.READY_TO_INSTALL,
                record.targetVersionCode,
                requestedLanguageTag = record.requestedLanguageTag,
                resolvedLanguageTag = record.resolvedLanguageTag,
            )
            transition(record, HandsUpdateState.INSTALLER_OPENED)
                .status(installedVersionCodeNow())
        } catch (_: Exception) {
            transition(
                record,
                HandsUpdateState.FAILED,
                errorCode = "installer_open_failed",
                retryable = true,
            ).status(installedVersionCodeNow())
        }
    }

    /**
     * Check for an update; if newer, download and trigger install.
     *
     * Full downloads are persisted and reconciled through DownloadManager,
     * PackageManager, and the exact SDK-owned file before installation.
     *
     * @return UpdateCheckResponse (always, even when no update) so the
     *         caller can display a "you are up to date" message.
     */
    suspend fun checkAndInstall(languageTag: String? = this.languageTag): UpdateCheckResponse =
        commandMutex.withLock { checkAndInstallUnlocked(languageTag) }

    private suspend fun checkAndInstallUnlocked(languageTag: String?): UpdateCheckResponse {
        val requestedLanguage = normalizedLanguageTag(languageTag)
        val prior = transactionStore.read()
        if (prior == null || prior.state in RESTARTABLE_STATES) {
            transactionStore.write(
                newRecord(
                    state = HandsUpdateState.CHECKING,
                    requestedLanguageTag = requestedLanguage,
                )
            )
        }
        emit(
            "check_started",
            HandsUpdateState.CHECKING,
            requestedLanguageTag = requestedLanguage,
        )
        val response = try {
            client.checkForUpdate(
                slug = appSlug,
                channel = channel,
                currentVersionCode = installedVersionCode,
                productType = productType,
                platform = platform,
                arch = arch,
                deviceId = deviceId ?: HandsDeviceId.get(context),
                languageTag = requestedLanguage,
            )
        } catch (exception: Exception) {
            transactionStore.read()?.takeIf { it.state == HandsUpdateState.CHECKING }?.let {
                transition(it, HandsUpdateState.FAILED, "check_failed", true)
            }
            emit(
                "check_failed",
                HandsUpdateState.FAILED,
                errorCode = "check_failed",
                requestedLanguageTag = requestedLanguage,
            )
            throw exception
        }
        val resolvedLanguage = resolveLanguageTag(
            requestedLanguage,
            response.latest?.release_notes,
        )
        emit(
            "check_completed",
            HandsUpdateState.CHECKING,
            targetVersionCode = response.latest?.version_code,
            requestedLanguageTag = requestedLanguage,
            resolvedLanguageTag = resolvedLanguage,
        )
        if (response.requireUpdate() != null) {
            installUpdate(response, requestedLanguage, resolvedLanguage)
        } else if (transactionStore.read()?.state == HandsUpdateState.CHECKING) {
            transactionStore.clear()
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

    private suspend fun installUpdate(
        response: UpdateCheckResponse,
        requestedLanguageTag: String?,
        resolvedLanguageTag: String?,
    ) {
        val (latest, asset) = response.requireUpdate() ?: return
        val existing = transactionStore.read()
        if (existing?.targetVersionCode == latest.version_code) {
            when (reconcileTransaction().state) {
                HandsUpdateState.READY_TO_INSTALL,
                HandsUpdateState.INSTALLER_OPENED,
                -> {
                    withContext(Dispatchers.IO) { reopenPendingInstallerUnlocked() }
                    return
                }

                HandsUpdateState.PATCHING,
                HandsUpdateState.DOWNLOADING,
                -> return

                else -> cleanup(existing)
            }
        } else if (existing != null && existing.state != HandsUpdateState.CHECKING) {
            cleanup(existing)
            transition(
                existing,
                HandsUpdateState.STALE,
                errorCode = "target_changed",
                retryable = true,
                clearLocalAuthority = true,
            )
        }

        val baseRecord = recordForOffer(
            latest = latest,
            asset = asset,
            patch = response.patch,
            requestedLanguageTag = requestedLanguageTag,
            resolvedLanguageTag = resolvedLanguageTag,
        )

        // Prefer the incremental (delta) path when the server offered a patch.
        // DeltaUpdater does blocking IO + a CPU-heavy patch apply and never
        // throws: it returns false for any failure/verification miss, and we
        // fall through to the unchanged full-APK download below.
        val patch = response.patch
        if (patch != null) {
            transactionStore.write(baseRecord.copy(state = HandsUpdateState.PATCHING))
            emit(
                "patch_started",
                HandsUpdateState.PATCHING,
                latest.version_code,
                requestedLanguageTag = requestedLanguageTag,
                resolvedLanguageTag = resolvedLanguageTag,
            )
            val applied = withContext(Dispatchers.IO) {
                effectiveDeltaUpdater.tryApplyAndInstall(
                    patch,
                    asset,
                    latest,
                    appSlug,
                ) { apk, sha256 ->
                    val opened = baseRecord.copy(
                        state = HandsUpdateState.INSTALLER_OPENED,
                        assetSha256 = sha256,
                        localFilePath = apk.absolutePath,
                        updatedAt = System.currentTimeMillis(),
                    )
                    transactionStore.write(opened)
                }
            }
            if (applied) return
            emit(
                "full_download_fallback",
                HandsUpdateState.DOWNLOADING,
                latest.version_code,
                requestedLanguageTag = requestedLanguageTag,
                resolvedLanguageTag = resolvedLanguageTag,
            )
        }

        val enqueued = installer.enqueueDownload(
            downloadUrl = asset.download_url,
            fileName = "quiver-${appSlug}-${latest.version_code}.apk",
            title = "${response.app.slug} v${latest.version}",
        )
        val downloading = baseRecord.copy(
            state = HandsUpdateState.DOWNLOADING,
            downloadId = enqueued.id,
            localFilePath = enqueued.destination.absolutePath,
            updatedAt = System.currentTimeMillis(),
        )
        transactionStore.write(downloading)
        emit(
            "full_download_started",
            HandsUpdateState.DOWNLOADING,
            latest.version_code,
            requestedLanguageTag = requestedLanguageTag,
            resolvedLanguageTag = resolvedLanguageTag,
        )
        val receiver = installer.createDownloadCompletionReceiver(enqueued.id) {
            scope.launch {
                val completed = status()
                if (completed.state == HandsUpdateState.READY_TO_INSTALL) {
                    reopenPendingInstaller()
                }
            }
        }
        // Register on Application context so the receiver survives Activity death.
        if (context is android.app.Application) {
            context.registerDownloadReceiver(
                receiver,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
            )
        }
    }

    private fun reconcileTransaction(): HandsUpdateStatus {
        val installed = installedVersionCodeNow()
        val record = transactionStore.read() ?: return idleStatus(installed)
        if (record.state == HandsUpdateState.INSTALLED) return record.status(installed)
        val target = record.targetVersionCode
        if (target != null && installed != null && installed >= target) {
            cleanup(record)
            return transition(
                record,
                HandsUpdateState.INSTALLED,
                retryable = false,
                clearLocalAuthority = true,
            ).status(installed)
        }
        if (target != null && installed != null && installed < (record.installedVersionCodeAtStart ?: 0)) {
            cleanup(record)
            return transition(
                record,
                HandsUpdateState.STALE,
                errorCode = "installed_version_regressed",
                retryable = true,
                clearLocalAuthority = true,
            ).status(installed)
        }

        return when (record.state) {
            HandsUpdateState.CHECKING -> {
                if (isExpired(record, CHECK_TIMEOUT_MS)) {
                    transition(record, HandsUpdateState.STALE, "check_interrupted", true)
                        .status(installed)
                } else {
                    record.status(installed)
                }
            }

            HandsUpdateState.PATCHING -> {
                if (isExpired(record, PATCH_TIMEOUT_MS)) {
                    cleanup(record)
                    transition(
                        record,
                        HandsUpdateState.STALE,
                        "patch_interrupted",
                        true,
                        clearLocalAuthority = true,
                    ).status(installed)
                } else {
                    record.status(installed)
                }
            }

            HandsUpdateState.DOWNLOADING -> reconcileDownload(record, installed)
            HandsUpdateState.READY_TO_INSTALL,
            HandsUpdateState.INSTALLER_OPENED,
            -> {
                val error = validateLocalApk(record, record.localFilePath?.let(::File))
                if (error == null) {
                    record.status(installed)
                } else {
                    cleanup(record)
                    transition(
                        record,
                        HandsUpdateState.STALE,
                        error,
                        true,
                        clearLocalAuthority = true,
                    ).status(installed)
                }
            }

            else -> record.status(installed)
        }
    }

    private fun reconcileDownload(
        record: UpdateTransactionRecord,
        installed: Long?,
    ): HandsUpdateStatus {
        val downloadId = record.downloadId ?: return transition(
            record,
            HandsUpdateState.STALE,
            "download_id_missing",
            true,
            clearLocalAuthority = true,
        ).status(installed)
        return when (installer.queryDownload(downloadId).state) {
            DownloadState.PENDING,
            DownloadState.RUNNING,
            DownloadState.PAUSED,
            -> record.status(installed)

            DownloadState.SUCCESSFUL -> {
                val error = validateLocalApk(record, record.localFilePath?.let(::File))
                if (error == null) {
                    emit(
                        "full_download_completed",
                        HandsUpdateState.READY_TO_INSTALL,
                        record.targetVersionCode,
                        requestedLanguageTag = record.requestedLanguageTag,
                        resolvedLanguageTag = record.resolvedLanguageTag,
                    )
                    transition(record, HandsUpdateState.READY_TO_INSTALL).status(installed)
                } else {
                    cleanup(record)
                    transition(
                        record,
                        HandsUpdateState.STALE,
                        error,
                        true,
                        clearLocalAuthority = true,
                    ).status(installed)
                }
            }

            DownloadState.FAILED -> {
                cleanup(record)
                transition(
                    record,
                    HandsUpdateState.FAILED,
                    "download_failed",
                    true,
                    clearLocalAuthority = true,
                ).status(installed)
            }

            DownloadState.MISSING -> {
                cleanup(record)
                transition(
                    record,
                    HandsUpdateState.STALE,
                    "download_missing",
                    true,
                    clearLocalAuthority = true,
                ).status(installed)
            }
        }
    }

    private fun recordForOffer(
        latest: LatestUpdate,
        asset: UpdateAsset,
        patch: Patch?,
        requestedLanguageTag: String?,
        resolvedLanguageTag: String?,
    ): UpdateTransactionRecord = newRecord(
        state = HandsUpdateState.CHECKING,
        installedVersionCodeAtStart = installedVersionCodeNow() ?: installedVersionCode,
        targetVersionCode = latest.version_code,
        targetBuildId = latest.build_id,
        assetSizeBytes = asset.size_bytes,
        assetSha256 = asset.sha256 ?: patch?.target_sha256,
        assetSignature = asset.signature,
        filetype = asset.filetype,
        requestedLanguageTag = requestedLanguageTag,
        resolvedLanguageTag = resolvedLanguageTag,
    )

    private fun newRecord(
        state: HandsUpdateState,
        installedVersionCodeAtStart: Long? = null,
        targetVersionCode: Long? = null,
        targetBuildId: String? = null,
        assetSizeBytes: Long? = null,
        assetSha256: String? = null,
        assetSignature: String? = null,
        filetype: String? = null,
        requestedLanguageTag: String? = null,
        resolvedLanguageTag: String? = null,
    ): UpdateTransactionRecord = UpdateTransactionRecord(
        packageName = authority.packageName,
        baseUrl = authority.canonicalBaseUrl,
        appSlug = authority.appSlug,
        channel = authority.channel,
        productType = authority.productType,
        platform = authority.platform,
        arch = authority.arch,
        state = state,
        installedVersionCodeAtStart = installedVersionCodeAtStart,
        targetVersionCode = targetVersionCode,
        targetBuildId = targetBuildId,
        assetSizeBytes = assetSizeBytes,
        assetSha256 = assetSha256,
        assetSignature = assetSignature,
        filetype = filetype,
        requestedLanguageTag = requestedLanguageTag,
        resolvedLanguageTag = resolvedLanguageTag,
    )

    private fun transition(
        record: UpdateTransactionRecord,
        state: HandsUpdateState,
        errorCode: String? = null,
        retryable: Boolean = record.retryable,
        clearLocalAuthority: Boolean = false,
    ): UpdateTransactionRecord {
        val next = record.copy(
            state = state,
            downloadId = if (clearLocalAuthority) null else record.downloadId,
            localFilePath = if (clearLocalAuthority) null else record.localFilePath,
            errorCode = errorCode,
            retryable = retryable,
            updatedAt = System.currentTimeMillis(),
        )
        transactionStore.write(next)
        if (record.state != next.state || record.errorCode != next.errorCode) {
            emit(
                "state_changed",
                state,
                next.targetVersionCode,
                errorCode,
                next.requestedLanguageTag,
                next.resolvedLanguageTag,
            )
        }
        return next
    }

    private fun cleanup(record: UpdateTransactionRecord) {
        record.downloadId?.let(installer::removeDownload)
        val file = record.localFilePath?.let(::File)
        if (file != null && isSdkOwnedFile(file)) {
            try {
                if (file.exists()) file.delete()
            } catch (_: Exception) {
                // Best-effort cleanup. Authority is still cleared fail-closed.
            }
        }
        emit(
            "cleanup",
            record.state,
            record.targetVersionCode,
            requestedLanguageTag = record.requestedLanguageTag,
            resolvedLanguageTag = record.resolvedLanguageTag,
        )
    }

    private fun validateLocalApk(record: UpdateTransactionRecord, file: File?): String? {
        if (file == null || !isSdkOwnedFile(file) || !file.isFile) return "apk_missing"
        if (record.filetype != null && record.filetype.lowercase() != "apk") return "filetype_mismatch"
        if (record.assetSizeBytes != null && file.length() != record.assetSizeBytes) {
            return "size_mismatch"
        }
        val expectedSha = record.assetSha256?.lowercase()
        if (expectedSha != null && !constantTimeEquals(sha256Hex(file), expectedSha)) {
            return "sha256_mismatch"
        }
        return validatePackageIdentity(file, record.targetVersionCode)
    }

    private fun isSdkOwnedFile(file: File): Boolean {
        val candidate = try {
            file.canonicalFile
        } catch (_: Exception) {
            return false
        }
        val roots = listOfNotNull(
            context.cacheDir,
            context.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS),
        ).mapNotNull {
            try {
                it.canonicalFile
            } catch (_: Exception) {
                null
            }
        }
        return candidate.name.endsWith(".apk", ignoreCase = true) && roots.any { root ->
            candidate.path.startsWith(root.path + File.separator)
        }
    }

    @Suppress("DEPRECATION")
    private fun validatePackageIdentity(file: File, targetVersionCode: Long?): String? {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val archive = context.packageManager.getPackageArchiveInfo(file.path, flags)
            ?: return "invalid_apk"
        archive.applicationInfo?.apply {
            sourceDir = file.path
            publicSourceDir = file.path
        }
        if (archive.packageName != context.packageName) return "package_mismatch"
        val archiveVersion = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            archive.longVersionCode
        } else {
            archive.versionCode.toLong()
        }
        if (targetVersionCode == null || archiveVersion != targetVersionCode) {
            return "target_version_mismatch"
        }
        val installed = try {
            context.packageManager.getPackageInfo(context.packageName, flags)
        } catch (_: Exception) {
            return "installed_package_missing"
        }
        val archiveCertificates = signingCertificates(archive) ?: return "signer_mismatch"
        val installedCertificates = signingCertificates(installed) ?: return "signer_mismatch"
        if (archiveCertificates != installedCertificates) {
            return "signer_mismatch"
        }
        return null
    }

    @Suppress("DEPRECATION")
    private fun signingCertificates(info: PackageInfo): Set<String>? {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = info.signingInfo ?: return null
            if (signingInfo.hasMultipleSigners()) {
                signingInfo.apkContentsSigners
            } else {
                signingInfo.signingCertificateHistory
            }
        } else {
            info.signatures
        }
        return signatures?.map { bytesToHex(it.toByteArray()) }?.toSet()?.takeIf { it.isNotEmpty() }
    }

    private fun installedVersionCodeNow(): Long? = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    } catch (_: Exception) {
        null
    }

    private fun idleStatus(installed: Long? = installedVersionCodeNow()) = HandsUpdateStatus(
        state = HandsUpdateState.IDLE,
        installedVersionCode = installed,
    )

    private fun isExpired(record: UpdateTransactionRecord, timeoutMs: Long): Boolean =
        System.currentTimeMillis() - record.updatedAt > timeoutMs

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return bytesToHex(digest.digest())
    }

    private fun bytesToHex(bytes: ByteArray): String =
        bytes.joinToString("") { "%02x".format(it) }

    private fun constantTimeEquals(left: String, right: String): Boolean {
        if (left.length != right.length) return false
        var difference = 0
        left.indices.forEach { difference = difference or (left[it].code xor right[it].code) }
        return difference == 0
    }

    private fun emit(
        name: String,
        state: HandsUpdateState,
        targetVersionCode: Long? = null,
        errorCode: String? = null,
        requestedLanguageTag: String? = null,
        resolvedLanguageTag: String? = null,
    ) {
        try {
            eventListener.onEvent(
                HandsUpdateEvent(
                    name = name,
                    state = state,
                    targetVersionCode = targetVersionCode,
                    errorCode = errorCode,
                    requestedLanguageTag = requestedLanguageTag,
                    resolvedLanguageTag = resolvedLanguageTag,
                )
            )
        } catch (_: Throwable) {
            // Host diagnostics must never break delivery.
        }
    }

    private companion object {
        val commandMutexes = ConcurrentHashMap<String, Mutex>()
        val RESTARTABLE_STATES = setOf(
            HandsUpdateState.IDLE,
            HandsUpdateState.FAILED,
            HandsUpdateState.STALE,
            HandsUpdateState.INSTALLED,
        )
        const val CHECK_TIMEOUT_MS = 2 * 60 * 1000L
        const val PATCH_TIMEOUT_MS = 30 * 60 * 1000L
    }
}
