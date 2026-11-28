package build.hands.update.internal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.tukaani.xz.LZMA2Options
import org.tukaani.xz.MemoryLimitException
import org.tukaani.xz.XZOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.zip.GZIPOutputStream

class DeltaCompressionTest {
    @Test
    fun `algorithm ids map to their compression and unknown ones to null`() {
        assertEquals(PatchCompression.NONE, DeltaUpdater.compressionFor("archive-patcher-v1"))
        assertEquals(PatchCompression.GZIP, DeltaUpdater.compressionFor("archive-patcher-v1+gzip"))
        assertEquals(PatchCompression.XZ, DeltaUpdater.compressionFor("archive-patcher-v1+xz"))
        for (unknown in listOf("archive-patcher-v1+zstd", "archive-patcher-v2+xz", "bsdiff", "", "ARCHIVE-PATCHER-V1+XZ")) {
            assertNull(unknown, DeltaUpdater.compressionFor(unknown))
        }
    }

    @Test
    fun `every declared algorithm is one the SDK applies`() {
        assertEquals(listOf("archive-patcher-v1+xz", "archive-patcher-v1+gzip"), DeltaUpdater.supportedAlgorithms(false))
        assertEquals(
            listOf("archive-patcher-zucchini-v1+xz", "archive-patcher-v1+xz", "archive-patcher-v1+gzip"),
            DeltaUpdater.supportedAlgorithms(true),
        )
        for (algorithm in DeltaUpdater.supportedAlgorithms(true)) {
            assertTrue(algorithm, DeltaUpdater.compressionFor(algorithm) != null)
        }
    }

    @Test
    fun `zucchini is declared first when the native applier loads`() {
        // Unit tests load the host build of libhandscrash.so, which carries it.
        assertEquals(DeltaUpdater.supportedAlgorithms(true), DeltaUpdater.SUPPORTED_ALGORITHMS)
    }

    @Test
    fun `zucchini algorithm is xz-compressed with the zucchini engine, others use bsdiff`() {
        assertEquals(PatchCompression.XZ, DeltaUpdater.compressionFor("archive-patcher-zucchini-v1+xz"))
        assertEquals(PatchEngine.ZUCCHINI, DeltaUpdater.engineFor("archive-patcher-zucchini-v1+xz"))
        for (algorithm in listOf("archive-patcher-v1", "archive-patcher-v1+gzip", "archive-patcher-v1+xz")) {
            assertEquals(algorithm, PatchEngine.BSDIFF, DeltaUpdater.engineFor(algorithm))
        }
        assertNull(DeltaUpdater.compressionFor("archive-patcher-zucchini-v1+gzip"))
    }

    @Test
    fun `xz patch with the server's 16 MiB dictionary round-trips within the memory limit`() {
        val raw = samplePatch()
        val xz = xz(raw, 16 shl 20)
        assertArrayEquals(raw, decode(xz, PatchCompression.XZ))
    }

    @Test
    fun `xz stream needing more memory than the limit is refused`() {
        val xz = xz(samplePatch(), 32 shl 20)
        try {
            decode(xz, PatchCompression.XZ)
            fail("a 32 MiB dictionary must exceed the ${DeltaUpdater.XZ_MEMORY_LIMIT_KIB} KiB limit")
        } catch (e: MemoryLimitException) {
            assertEquals(DeltaUpdater.XZ_MEMORY_LIMIT_KIB, e.memoryLimit)
        }
    }

    @Test
    fun `gzip and raw patches still decode`() {
        val raw = samplePatch()
        val gz = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(raw) } }.toByteArray()
        assertArrayEquals(raw, decode(gz, PatchCompression.GZIP))
        assertArrayEquals(raw, decode(raw, PatchCompression.NONE))
    }

    @Test
    fun `a gzip patch is not mistaken for xz`() {
        val gz = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(samplePatch()) } }.toByteArray()
        val closed = CloseTracking(ByteArrayInputStream(gz))
        try {
            DeltaUpdater.openDeltaStream(closed, PatchCompression.XZ)
            fail("gzip bytes must not open as xz")
        } catch (_: IOException) {
            assertTrue("raw stream is closed on failure", closed.closed)
        }
    }

    @Test
    fun `raw stream is returned unchanged`() {
        val raw = ByteArrayInputStream(byteArrayOf(1))
        assertSame(raw, DeltaUpdater.openDeltaStream(raw, PatchCompression.NONE))
    }

    private fun decode(bytes: ByteArray, compression: PatchCompression): ByteArray =
        DeltaUpdater.openDeltaStream(ByteArrayInputStream(bytes), compression).use { it.readBytes() }

    /** Mostly zeros with sparse structure, like a raw archive-patcher patch. */
    private fun samplePatch(): ByteArray = ByteArray(256 * 1024).also { bytes ->
        for (i in bytes.indices step 509) bytes[i] = (i * 31).toByte()
    }

    /** Fast preset so the encoder stays small; only the dictionary size matters here. */
    private fun xz(raw: ByteArray, dictSize: Int): ByteArray {
        val options = LZMA2Options(0).apply { this.dictSize = dictSize }
        return ByteArrayOutputStream().also { out -> XZOutputStream(out, options).use { it.write(raw) } }.toByteArray()
    }

    private class CloseTracking(input: InputStream) : java.io.FilterInputStream(input) {
        var closed = false
        override fun close() {
            closed = true
            super.close()
        }
    }
}
