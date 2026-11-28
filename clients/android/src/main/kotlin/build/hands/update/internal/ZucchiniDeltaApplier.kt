package build.hands.update.internal

import com.google.archivepatcher.applier.DeltaApplier
import com.google.archivepatcher.applier.FileByFileV1DeltaApplier
import com.google.archivepatcher.shared.IDeflater
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.function.BiFunction

/**
 * JNI entry point into the Zucchini applier compiled into `libhandscrash.so`
 * (see `src/main/cpp/hands_zucchini.cc`).
 */
internal object ZucchiniNative {
    /**
     * True when the native library is loaded and has the applier. It ships in
     * the same library as the bundled zlib; the probe also guards against a
     * library built without it. Never throws.
     */
    val isAvailable: Boolean by lazy {
        try {
            BundledZlib.isAvailable && nativeAbiVersion() == ABI_VERSION
        } catch (_: Throwable) {
            false
        }
    }

    /** Bumped if [nativeApply]'s contract changes. */
    private const val ABI_VERSION = 1

    @JvmStatic external fun nativeAbiVersion(): Int

    /**
     * Applies the Zucchini patch at [patchPath] to [oldPath], writing the
     * result to [outPath]. Returns 0 on success, otherwise a Zucchini status
     * (1..10) or a negative code from hands_zucchini.cc. Refuses a patch whose
     * header declares an output larger than [maxNewSize] bytes.
     */
    @JvmStatic external fun nativeApply(oldPath: String, patchPath: String, outPath: String, maxNewSize: Long): Int
}

/**
 * archive-patcher's file-by-file applier with the inner bsdiff step replaced
 * by Zucchini. The patch container is unchanged: archive-patcher still
 * uncompresses the old APK's entries into a delta-friendly blob and
 * recompresses the new blob into the APK with the same deflate settings; only
 * the delta between the two blobs is a Zucchini patch, which understands DEX
 * and ELF code and is much smaller than bsdiff for app updates.
 */
internal class ZucchiniFileByFileApplier(
    private val tempDir: File,
    deflaters: BiFunction<Int, Boolean, IDeflater>,
) : FileByFileV1DeltaApplier(tempDir, deflaters) {
    override fun getDeltaApplier(): DeltaApplier = ZucchiniDeltaApplier(tempDir)
}

/**
 * Applies the Zucchini delta to the delta-friendly old blob. Zucchini needs the
 * whole patch and random access to the old blob, so the patch is spooled to a
 * file and both, plus the output, are memory-mapped by the native side rather
 * than held on the Java heap.
 */
internal class ZucchiniDeltaApplier(private val tempDir: File) : DeltaApplier {
    override fun applyDelta(oldBlob: File, deltaIn: InputStream, newBlobOut: OutputStream) {
        if (!ZucchiniNative.isAvailable) throw IOException("zucchini applier is not available")
        val patch = File.createTempFile("hands-zucchini", ".patch", tempDir)
        val newBlob = File.createTempFile("hands-zucchini", ".new", tempDir)
        try {
            patch.outputStream().use { spool(deltaIn, it) }
            val status = ZucchiniNative.nativeApply(oldBlob.path, patch.path, newBlob.path, MAX_NEW_BLOB_BYTES)
            if (status != 0) throw IOException("zucchini apply failed: status=$status")
            newBlob.inputStream().use { it.copyTo(newBlobOut) }
        } finally {
            patch.delete()
            newBlob.delete()
        }
    }

    /** Copies the patch, refusing one larger than [MAX_PATCH_BYTES]. */
    private fun spool(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return
            total += read
            if (total > MAX_PATCH_BYTES) throw IOException("zucchini patch exceeds $MAX_PATCH_BYTES bytes")
            output.write(buffer, 0, read)
        }
    }

    internal companion object {
        /**
         * Upper bound on the decompressed Zucchini delta. Real patches are a
         * fraction of the APK; this only stops a corrupt stream from filling
         * the disk.
         */
        const val MAX_PATCH_BYTES = 1L shl 30

        /**
         * Upper bound on the delta-friendly new blob a patch may declare: an
         * APK with every entry uncompressed. Far above any real app, it only
         * stops a corrupt header from creating a huge file.
         */
        const val MAX_NEW_BLOB_BYTES = 2L shl 30
    }
}
