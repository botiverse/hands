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
import com.google.archivepatcher.applier.FileByFileV1DeltaApplier
import com.google.archivepatcher.shared.DefaultDeflater
import com.google.archivepatcher.shared.IDeflater
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.function.BiFunction
import java.util.zip.GZIPInputStream

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
 * The apply + signature/package checks require a real device/PackageManager and
 * the archive-patcher engine, so they are validated on-device, not by JVM unit
 * tests. The pure helpers ([isGzipped], [toHex], [constantTimeEquals]) are unit
 * testable in isolation.
 */
class DeltaUpdater(
    private val context: Context,
    private val installedVersionCode: Long,
    private val httpClient: OkHttpClient,
    private val installer: ApkInstaller,
    private val deltaApplyEnabled: Boolean = true,
) {

    /**
     * Attempt to apply [patch] on top of the installed base APK and install the
     * result.
     *
     * @return `true` if a verified reconstructed APK was handed to the installer
     *         (caller should stop); `false` for ANY failure (caller must fall
     *         back to the full download). Never throws.
     */
    fun tryApplyAndInstall(
        patch: Patch,
        asset: UpdateAsset,
        latest: LatestUpdate,
        appSlug: String,
    ): Boolean {
        if (!deltaEnabled()) {
            log("delta_fallback reason=flag_off")
            return false
        }
        if (!validateOffer(patch)) {
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

        val stamp = System.nanoTime()
        val patchFile = File(context.cacheDir, "hands-delta-${latest.version_code}-$stamp.patch")
        val reconstructed =
            File(context.cacheDir, "hands-delta-$appSlug-${latest.version_code}-$stamp.apk")
        var installed = false
        try {
            // 1. Download the patch bytes into a private temp file.
            try {
                downloadTo(patch.download_url, patchFile)
            } catch (e: Throwable) {
                log("delta_fallback reason=download err=${e.message}")
                return false
            }

            // 2. Open the delta stream, gunzipping first when the algorithm asks
            //    for it. A corrupt gzip header surfaces here as `gunzip`.
            val deltaStream: InputStream = try {
                openDeltaStream(patchFile, isGzipped(patch.algorithm))
            } catch (e: Throwable) {
                log("delta_fallback reason=gunzip err=${e.message}")
                return false
            }

            // 3. Apply the patch onto the base APK. A mid-stream gunzip fault or
            //    any patch error surfaces here as `apply`.
            try {
                deltaStream.use { stream ->
                    reconstructed.outputStream().buffered().use { out ->
                        // Use cacheDir as the applier's scratch dir explicitly
                        // rather than relying on java.io.tmpdir.
                        FileByFileV1DeltaApplier(context.cacheDir, deflaterFactory())
                            .applyDelta(baseFile, stream, out)
                    }
                }
            } catch (e: Throwable) {
                log("delta_fallback reason=apply err=${e.message}")
                return false
            }

            // 4a. Content integrity: sha256 must equal the offered target.
            val actualSha = sha256Hex(reconstructed)
            if (!constantTimeEquals(actualSha, expectedSha.lowercase())) {
                log("delta_fallback reason=sha_mismatch")
                return false
            }

            // 4b/4c. Package identity, version, and signer-cert equality.
            val reason = verifyReconstructedApk(reconstructed)
            if (reason != null) {
                log("delta_fallback reason=$reason")
                return false
            }

            // 5. Install the verified reconstructed APK.
            installer.installLocalApk(reconstructed)
            installed = true
            log("delta_applied bytes_saved=${asset.size_bytes - patch.size_bytes}")
            return true
        } catch (e: Throwable) {
            // Belt-and-suspenders: nothing above should escape, but never throw.
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
        if (!patch.algorithm.startsWith("archive-patcher-v1")) return false
        if (patch.target_sha256.isNullOrBlank()) return false
        return true
    }

    private fun downloadTo(url: String, dest: File) {
        val request = Request.Builder()
            .url(url)
            .header("accept", "application/octet-stream")
            .build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("HTTP ${response.code}")
            }
            val body = response.body ?: throw IOException("empty response body")
            dest.outputStream().use { out ->
                body.byteStream().use { input -> input.copyTo(out) }
            }
        }
    }

    private fun openDeltaStream(patchFile: File, gzipped: Boolean): InputStream {
        val raw = patchFile.inputStream().buffered()
        return if (gzipped) {
            try {
                GZIPInputStream(raw)
            } catch (e: Throwable) {
                raw.close()
                throw e
            }
        } else {
            raw
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

    companion object {
        private const val TAG = "HandsDelta"

        private val HEX = "0123456789abcdef".toCharArray()

        /** The `+gzip` suffix means the patch bytes are gzip-wrapped. */
        internal fun isGzipped(algorithm: String): Boolean = algorithm.endsWith("+gzip")

        /** Same deflater factory the generator (CLI/CI) used; must match byte-for-byte. */
        internal fun deflaterFactory(): BiFunction<Int, Boolean, IDeflater> =
            BiFunction { level, nowrap -> DefaultDeflater(level, nowrap) }

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
