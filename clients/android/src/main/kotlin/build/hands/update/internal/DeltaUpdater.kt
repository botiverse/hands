package build.hands.update.internal

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import build.hands.update.installer.ApkInstaller
import build.hands.update.models.LatestUpdate
import build.hands.update.models.Patch
import build.hands.update.models.UpdateAsset
import build.hands.update.DeltaReadyAction
import build.hands.update.DurableInstallerLaunchResult
import build.hands.update.deltaReadyAction
import build.hands.update.launchWithDurableInstallerAuthority
import com.google.archivepatcher.applier.FileByFileV1DeltaApplier
import com.google.archivepatcher.shared.IDeflater
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.function.BiFunction
import java.util.zip.GZIPInputStream
import org.tukaani.xz.XZInputStream

/**
 * Applies a server-offered incremental (delta) APK update on-device and, only
 * after it passes every safety check, hands the reconstructed APK to the system
 * installer.
 *
 * This is intentionally a dedicated, self-contained class (not folded into
 * [build.hands.update.UpdateChecker]) because it does something security
 * sensitive: it reconstructs an installable binary from an untrusted patch and
 * then installs it. Every path that could produce an APK that is not a
 * byte-identical, same-signer successor of the running app must fail closed.
 *
 * Guarantees:
 *  - It NEVER throws. Any failure (flag off, bad offer, network, gunzip, patch
 *    apply, or a failed verification) is caught, logged, temp files are deleted,
 *    and it returns `false` so the caller falls back to the full-APK download.
 *  - It only installs a reconstructed APK when ALL of these hold:
 *      1. sha256(reconstructed) == patch.target_sha256 (constant-time compare),
 *      2. the APK's package == this app and its versionCode >= the installed one,
 *      3. the APK's signing certificate(s) exactly match the installed app's.
 *
 * Entries are recompressed with the stock zlib bundled in the SDK
 * ([BundledZlibDeflater]), checked by [DeflaterSelfCheck] before the patch is
 * downloaded; if either is unavailable the update falls back to the full APK.
 *
 * The apply + signature/package checks require a real device/PackageManager and
 * the archive-patcher engine, so they are validated on-device, not by JVM unit
 * tests. The pure helpers ([compressionFor], [openDeltaStream], [toHex],
 * [constantTimeEquals]) are unit testable in isolation.
 */
class DeltaUpdater(
    private val context: Context,
    private val installedVersionCode: Long,
    private val httpClient: OkHttpClient,
    private val installer: ApkInstaller,
    private val deltaApplyEnabled: Boolean = true,
    private val eventSink: (name: String, errorCode: String?) -> Unit = { _, _ -> },
    /** Patch bytes downloaded so far and the expected total (null if unknown). */
    private val progressSink: (downloadedBytes: Long, totalBytes: Long?) -> Unit = { _, _ -> },
) {

    /**
     * Attempt to apply [patch] on top of the installed base APK and install the
     * result.
     *
     * With [openInstaller] false (prepare), the verified APK is persisted as
     * READY_TO_INSTALL and the installer is not opened.
     *
     * @return `true` if a verified reconstructed APK was handed to the installer
     *         or persisted as READY (caller should stop); `false` for ANY failure (caller must fall
     *         back to the full download). Never throws.
     */
    fun tryApplyAndInstall(
        patch: Patch,
        asset: UpdateAsset,
        latest: LatestUpdate,
        appSlug: String,
        persistReadyToInstall: (apk: File, sha256: String) -> Unit = { _, _ -> },
        persistInstallerOpened: () -> Unit = {},
        openInstaller: Boolean = true,
    ): Boolean {
        if (!deltaEnabled()) {
            emit("patch_fallback", "flag_off")
            log("delta_fallback reason=flag_off")
            return false
        }
        if (!validateOffer(patch)) {
            emit("patch_fallback", "offer_invalid")
            log("delta_fallback reason=validate")
            return false
        }
        // Non-null and non-blank, per validateOffer.
        val expectedSha = patch.target_sha256!!

        val baseFile = File(context.applicationInfo.sourceDir)
        if (!baseFile.isFile) {
            log("delta_fallback reason=validate")
            return false
        }

        // The patch rebuilds the APK only if this device recompresses every
        // entry exactly like the generator's stock zlib. Prove that before
        // spending bandwidth on the patch.
        val deflaters = compatibleDeflaterFactory()
        if (deflaters == null) {
            emit("patch_fallback", "deflater_incompatible")
            log("delta_fallback reason=deflater_incompatible")
            return false
        }

        val stamp = System.nanoTime()
        val patchFile = File(context.cacheDir, "hands-delta-${latest.version_code}-$stamp.patch")
        val reconstructed =
            File(context.cacheDir, "hands-delta-$appSlug-${latest.version_code}-$stamp.apk")
        var installed = false
        try {
            // 1. Download the patch bytes into a private temp file.
            try {
                emit("patch_download_started")
                downloadTo(patch.download_url, patchFile, patch.size_bytes.takeIf { it > 0L })
                emit("patch_download_completed")
            } catch (e: Throwable) {
                emit("patch_fallback", "patch_download_failed")
                log("delta_fallback reason=download err=${e.message}")
                return false
            }

            // 2. Open the delta stream, decompressing as the algorithm says
            //    (validateOffer accepted it, so it is known). A corrupt gzip or
            //    xz header surfaces here.
            val compression = compressionFor(patch.algorithm) ?: PatchCompression.NONE
            val deltaStream: InputStream = try {
                openDeltaStream(patchFile.inputStream().buffered(), compression)
            } catch (e: Throwable) {
                val code = if (compression == PatchCompression.XZ) "patch_decompress_failed" else "patch_gunzip_failed"
                emit("patch_fallback", code)
                log("delta_fallback reason=${compression.name.lowercase()} err=${e.message}")
                return false
            }

            // 3. Apply the patch onto the base APK. A mid-stream decompression
            //    fault or any patch error surfaces here as `apply`.
            try {
                emit("patch_apply_started")
                deltaStream.use { stream ->
                    reconstructed.outputStream().buffered().use { out ->
                        // Use cacheDir as the applier's scratch dir explicitly
                        // rather than relying on java.io.tmpdir.
                        val applier = when (engineFor(patch.algorithm)) {
                            PatchEngine.ZUCCHINI -> ZucchiniFileByFileApplier(context.cacheDir, deflaters)
                            else -> FileByFileV1DeltaApplier(context.cacheDir, deflaters)
                        }
                        applier.applyDelta(baseFile, stream, out)
                    }
                }
                emit("patch_apply_completed")
            } catch (e: Throwable) {
                emit("patch_fallback", "patch_apply_failed")
                log("delta_fallback reason=apply err=${e.message}")
                return false
            }

            // 4a. Content integrity: sha256 must equal the offered target.
            val actualSha = sha256Hex(reconstructed)
            if (!constantTimeEquals(actualSha, expectedSha.lowercase())) {
                emit("patch_fallback", "sha256_mismatch")
                log("delta_fallback reason=sha_mismatch actual=$actualSha size=${reconstructed.length()}")
                return false
            }

            // 4b/4c. Package identity, version, and signer-cert equality.
            val reason = verifyReconstructedApk(reconstructed)
            if (reason != null) {
                emit("patch_fallback", reason)
                log("delta_fallback reason=$reason")
                return false
            }
            emit("patch_validation_completed")

            // 5. Persist exact file authority before opening the external
            // installer. If the post-launch OPENED commit fails, READY remains
            // durable and the host can safely reopen the same verified APK.
            // Without the "install unknown apps" permission the installer
            // cannot open. Keep the verified APK as READY: the host sends the
            // person to the permission screen and reopens it from there.
            // A prepare() caller stops here too: the verified APK stays READY
            // until the host reopens it.
            val action = deltaReadyAction(openInstaller, installer.canRequestPackageInstalls())
            if (action != DeltaReadyAction.OPEN_INSTALLER) {
                try {
                    persistReadyToInstall(reconstructed, actualSha)
                } catch (_: Throwable) {
                    emit("transaction_persist_failed", "ready_persist_failed")
                    return false
                }
                installed = true
                if (action == DeltaReadyAction.KEEP_READY_PERMISSION_REQUIRED) {
                    emit("install_permission_required", "install_permission_required")
                }
                log("delta_applied bytes_saved=${asset.size_bytes - patch.size_bytes} installer=deferred")
                return true
            }
            when (launchWithDurableInstallerAuthority(
                persistReady = { persistReadyToInstall(reconstructed, actualSha) },
                launchInstaller = { installer.installLocalApk(reconstructed) },
                persistOpened = persistInstallerOpened,
            )) {
                DurableInstallerLaunchResult.READY_PERSIST_FAILED -> {
                    emit("transaction_persist_failed", "ready_persist_failed")
                    return false
                }
                DurableInstallerLaunchResult.LAUNCH_FAILED -> {
                    emit("patch_fallback", "installer_open_failed")
                    return false
                }
                DurableInstallerLaunchResult.OPENED_WITH_READY_AUTHORITY -> {
                    installed = true
                    emit("transaction_persist_failed", "opened_persist_failed")
                }
                DurableInstallerLaunchResult.OPENED -> {
                    installed = true
                }
            }
            emit("installer_opened")
            log("delta_applied bytes_saved=${asset.size_bytes - patch.size_bytes}")
            return true
        } catch (e: Throwable) {
            // Belt-and-suspenders: nothing above should escape, but never throw.
            emit("patch_fallback", "patch_apply_failed")
            log("delta_fallback reason=apply err=${e.message}")
            return false
        } finally {
            // The patch is never needed once applied. The reconstructed APK is
            // kept ONLY on the success path — the system installer reads it via
            // the content URI after we return; deleting it would break install.
            safeDelete(patchFile)
            if (!installed) safeDelete(reconstructed)
        }
    }

    /**
     * Feature flag. Defaults to the constructor value, but a JVM system property
     * `HANDS_DELTA_APPLY=false` force-disables it (kill switch for field ops).
     */
    private fun deltaEnabled(): Boolean {
        val override = System.getProperty("HANDS_DELTA_APPLY")
        if (override != null) return !override.equals("false", ignoreCase = true)
        return deltaApplyEnabled
    }

    /**
     * Cheap, non-cryptographic offer sanity checks. The real trust anchors are
     * the post-apply verifications; this just avoids wasted work.
     */
    private fun validateOffer(patch: Patch): Boolean {
        if (patch.from_version_code != installedVersionCode) return false
        if (compressionFor(patch.algorithm) == null) return false
        if (engineFor(patch.algorithm) == PatchEngine.ZUCCHINI && !ZucchiniNative.isAvailable) return false
        if (patch.target_sha256.isNullOrBlank()) return false
        return true
    }

    private fun downloadTo(url: String, dest: File, expectedBytes: Long?) {
        val request = Request.Builder()
            .url(url)
            .header("accept", "application/octet-stream")
            .build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code}")
            }
            val body = response.body ?: throw IOException("empty response body")
            val total = body.contentLength().takeIf { it > 0L } ?: expectedBytes
            dest.outputStream().use { out ->
                body.byteStream().use { input ->
                    copyWithProgress(input, out) { done -> reportProgress(done, total) }
                }
            }
        }
    }

    /**
     * Verifies the reconstructed APK is a legitimate successor of the running
     * app. Returns `null` when everything checks out, or a short fallback reason
     * (`pkg_mismatch` / `signer_mismatch`) otherwise.
     */
    @Suppress("DEPRECATION")
    private fun verifyReconstructedApk(file: File): String? {
        val pm = context.packageManager
        val usesSigningInfo = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        val flags = if (usesSigningInfo) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }

        val archiveInfo = pm.getPackageArchiveInfo(file.path, flags) ?: return "pkg_mismatch"
        // Point the parsed ApplicationInfo at the archive so signatures resolve
        // on pre-P devices (where getPackageArchiveInfo leaves sourceDir null).
        archiveInfo.applicationInfo?.apply {
            sourceDir = file.path
            publicSourceDir = file.path
        }

        if (archiveInfo.packageName != context.packageName) return "pkg_mismatch"
        val archiveVersionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            archiveInfo.longVersionCode
        } else {
            archiveInfo.versionCode.toLong()
        }
        if (archiveVersionCode < installedVersionCode) return "pkg_mismatch"

        val installedInfo = try {
            pm.getPackageInfo(context.packageName, flags)
        } catch (e: Exception) {
            return "signer_mismatch"
        }

        val archiveCerts = signingCerts(archiveInfo) ?: return "signer_mismatch"
        val installedCerts = signingCerts(installedInfo) ?: return "signer_mismatch"
        if (archiveCerts != installedCerts) return "signer_mismatch"
        return null
    }

    /**
     * The set of signing certificates (hex-encoded DER) for [info], or `null` if
     * none could be read. On API 28+ we read the modern `signingInfo`; on
     * 24–27 the legacy `signatures` array.
     */
    @Suppress("DEPRECATION")
    private fun signingCerts(info: PackageInfo?): Set<String>? {
        info ?: return null
        val raw: Array<out android.content.pm.Signature>? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val signingInfo = info.signingInfo ?: return null
                if (signingInfo.hasMultipleSigners()) {
                    signingInfo.apkContentsSigners
                } else {
                    signingInfo.signingCertificateHistory
                }
            } else {
                info.signatures
            }
        val set = raw?.mapNotNull { it?.toByteArray()?.let(::toHex) }?.toSet()
        return set?.takeIf { it.isNotEmpty() }
    }

    private fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return toHex(digest.digest())
    }

    private fun log(message: String) {
        Log.i(TAG, message)
    }

    private fun reportProgress(downloadedBytes: Long, totalBytes: Long?) {
        try {
            progressSink(downloadedBytes, totalBytes)
        } catch (_: Throwable) {
            // Progress is advisory; it must never break update delivery.
        }
    }

    private fun emit(name: String, errorCode: String? = null) {
        try {
            eventSink(name, errorCode)
        } catch (_: Throwable) {
            // Host diagnostics must never break update delivery.
        }
    }

    companion object {
        /** Reports at most once per [reportEveryBytes] copied, plus once at the end. */
        internal fun copyWithProgress(
            input: InputStream,
            output: OutputStream,
            reportEveryBytes: Long = 64L * 1024L,
            onProgress: (copiedBytes: Long) -> Unit,
        ): Long {
            val buffer = ByteArray(8192)
            var copied = 0L
            var lastReported = 0L
            onProgress(0L)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                output.write(buffer, 0, count)
                copied += count
                if (copied - lastReported >= reportEveryBytes) {
                    lastReported = copied
                    onProgress(copied)
                }
            }
            if (copied != lastReported) onProgress(copied)
            return copied
        }

        private const val TAG = "HandsDelta"

        private val HEX = "0123456789abcdef".toCharArray()

        /**
         * Patch algorithms this SDK applies, best first. Sent as
         * `X-Hands-Delta-Algorithms` so the server only offers these; a server
         * that sees no header offers `+gzip` (what SDKs before 0.15.0 apply).
         */
        internal val SUPPORTED_ALGORITHMS: List<String>
            get() = supportedAlgorithms(ZucchiniNative.isAvailable)

        /** Zucchini patches need the native applier; without it they are not declared. */
        internal fun supportedAlgorithms(zucchiniAvailable: Boolean): List<String> =
            if (zucchiniAvailable) {
                listOf(ZUCCHINI_XZ_ALGORITHM, "archive-patcher-v1+xz", "archive-patcher-v1+gzip")
            } else {
                listOf("archive-patcher-v1+xz", "archive-patcher-v1+gzip")
            }

        /**
         * archive-patcher container whose inner delta is a Zucchini patch
         * ([ZucchiniFileByFileApplier]) instead of bsdiff, xz-compressed.
         */
        internal const val ZUCCHINI_XZ_ALGORITHM = "archive-patcher-zucchini-v1+xz"

        /**
         * XZInputStream memory limit in KiB. The server compresses with a
         * 16 MiB LZMA2 dictionary (container/src/patch-compression.ts), which
         * needs about 16.1 MiB to decode; 20 MiB leaves margin but refuses a
         * stream that would need far more memory than any patch we generate.
         */
        internal const val XZ_MEMORY_LIMIT_KIB = 20 * 1024

        /**
         * How the patch bytes for [algorithm] are compressed, or null for an
         * algorithm this SDK cannot apply (the caller falls back to the full
         * APK).
         */
        internal fun compressionFor(algorithm: String): PatchCompression? = when (algorithm) {
            "archive-patcher-v1" -> PatchCompression.NONE
            "archive-patcher-v1+gzip" -> PatchCompression.GZIP
            "archive-patcher-v1+xz" -> PatchCompression.XZ
            ZUCCHINI_XZ_ALGORITHM -> PatchCompression.XZ
            else -> null
        }

        /** Which delta engine sits inside the archive-patcher container for [algorithm]. */
        internal fun engineFor(algorithm: String): PatchEngine =
            if (algorithm == ZUCCHINI_XZ_ALGORITHM) PatchEngine.ZUCCHINI else PatchEngine.BSDIFF

        /** Wraps [raw] in the decompressor for [compression]; closes [raw] if that fails. */
        internal fun openDeltaStream(raw: InputStream, compression: PatchCompression): InputStream =
            try {
                when (compression) {
                    PatchCompression.NONE -> raw
                    PatchCompression.GZIP -> GZIPInputStream(raw)
                    PatchCompression.XZ -> XZInputStream(raw, XZ_MEMORY_LIMIT_KIB)
                }
            } catch (e: Throwable) {
                raw.close()
                throw e
            }

        /**
         * Deflaters that recompress like the patch generator's stock zlib: the
         * zlib bundled in the SDK, never the platform's (Chromium's fork on
         * Android 12+, whose output differs). Null when the native library
         * cannot be loaded, so the caller skips the delta.
         */
        internal fun deflaterFactory(): BiFunction<Int, Boolean, IDeflater>? =
            if (BundledZlib.isAvailable) {
                BiFunction { level, nowrap -> BundledZlibDeflater(level, nowrap) }
            } else {
                null
            }

        /** Checked once per process: the bundled zlib cannot change while it runs. */
        private val compatibleDeflaters: BiFunction<Int, Boolean, IDeflater>? by lazy {
            deflaterFactory()?.takeIf { DeflaterSelfCheck.passes(it) }
        }

        /** [deflaterFactory] if it passes [DeflaterSelfCheck], else null. Never throws. */
        internal fun compatibleDeflaterFactory(): BiFunction<Int, Boolean, IDeflater>? =
            try {
                compatibleDeflaters
            } catch (_: Throwable) {
                null
            }

        /** Lowercase hex encoding. */
        internal fun toHex(bytes: ByteArray): String {
            val out = CharArray(bytes.size * 2)
            for (i in bytes.indices) {
                val v = bytes[i].toInt() and 0xFF
                out[i * 2] = HEX[v ushr 4]
                out[i * 2 + 1] = HEX[v and 0x0F]
            }
            return String(out)
        }

        /**
         * Length-and-content constant-time comparison of two hex strings. Both
         * are compared as-is (callers pass already-lowercased values); guards the
         * sha256 check against timing side channels.
         */
        internal fun constantTimeEquals(a: String, b: String): Boolean {
            if (a.length != b.length) return false
            var diff = 0
            for (i in a.indices) {
                diff = diff or (a[i].code xor b[i].code)
            }
            return diff == 0
        }

        private fun safeDelete(file: File) {
            try {
                if (file.exists()) file.delete()
            } catch (_: Throwable) {
                // best-effort cleanup
            }
        }
    }
}

/** Compression wrapped around an archive-patcher patch. */
internal enum class PatchCompression { NONE, GZIP, XZ }

/** The delta between archive-patcher's delta-friendly blobs. */
internal enum class PatchEngine { BSDIFF, ZUCCHINI }
