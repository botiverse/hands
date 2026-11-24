package build.hands.update.internal

import com.google.archivepatcher.shared.DefaultDeflater
import com.google.archivepatcher.shared.IDeflater
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.function.BiFunction
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * Drives the real [BundledZlibDeflater] through its JNI bridge and the vendored
 * zlib, built for the host by the `buildHostBundledZlib` Gradle task.
 */
class BundledZlibDeflaterTest {
    @Before
    fun requireHostLibrary() {
        // Gradle's unit test tasks always set this; only ad-hoc IDE runs skip.
        assumeTrue(System.getProperty("hands.hostBundledZlib") != null)
        assertTrue("host bundled zlib failed to load", BundledZlib.isAvailable)
    }

    @Test
    fun `bundled zlib is 1_3_1 and passes the self-check`() {
        assertEquals("1.3.1", BundledZlib.nativeZlibVersion())
        assertNotNull(DeltaUpdater.compatibleDeflaterFactory())
        assertTrue(DeflaterSelfCheck.passes(DeltaUpdater.deflaterFactory()!!))
    }

    @Test
    fun `matches java util zip Deflater bookkeeping through level, strategy and flush changes`() {
        val data = DeflaterSelfCheck.sample()
        for (nowrap in listOf(true, false)) {
            val ours = BundledZlibDeflater(6, nowrap)
            val jdk = DefaultDeflater(6, nowrap)
            val a = drive(ours, data)
            val b = drive(jdk, data)
            assertEquals(b.bytesRead, a.bytesRead)
            assertEquals(b.adler, a.adler)
            assertEquals(data.size.toLong(), a.bytesRead)
            assertEquals(a.output.size.toLong(), a.bytesWritten)
            assertArrayEquals(data, inflate(a.output, nowrap))
            if (jdkUsesStockZlib()) assertArrayEquals(b.output, a.output)
            ours.end()
            jdk.end()
        }
    }

    @Test
    fun `reset keeps level and strategy and restarts the stream`() {
        val data = DeflaterSelfCheck.sample()
        val d = BundledZlibDeflater(9, true)
        drive(d, data) // leaves level 1, default strategy
        d.reset()
        assertEquals(0L, d.bytesRead)
        assertEquals(0L, d.bytesWritten)
        assertTrue(d.needsInput())
        val fresh = BundledZlibDeflater(1, true)
        assertArrayEquals(drive(fresh, data).output, drive(d, data).output)
        fresh.end()
        d.end()
    }

    @Test
    fun `dictionary sets adler like the JDK`() {
        val dict = "the quick brown fox".toByteArray()
        val ours = BundledZlibDeflater(6, false)
        val jdk = Deflater(6, false)
        ours.setDictionary(dict)
        jdk.setDictionary(dict)
        assertEquals(jdk.adler, ours.adler)
        ours.end()
        jdk.end()
    }

    @Test
    fun `argument and lifecycle errors match the JDK`() {
        val d = BundledZlibDeflater(6, true)
        assertThrows<IllegalArgumentException> { d.setLevel(10) }
        assertThrows<IllegalArgumentException> { d.setStrategy(3) }
        assertThrows<IllegalArgumentException> { d.deflate(ByteArray(8), 0, 8, 4) }
        assertThrows<ArrayIndexOutOfBoundsException> { d.setInput(ByteArray(8), 4, 5) }
        assertThrows<ArrayIndexOutOfBoundsException> { d.deflate(ByteArray(8), -1, 2) }
        d.end()
        d.end() // idempotent
        assertThrows<NullPointerException> { d.deflate(ByteArray(8)) }
        assertThrows<NullPointerException> { d.reset() }
    }

    private class Result(val output: ByteArray, val bytesRead: Long, val bytesWritten: Long, val adler: Int)

    /** One fixed call sequence covering lazy setLevel/setStrategy, NO/SYNC/FULL flush and finish. */
    private fun drive(d: IDeflater, data: ByteArray): Result {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(333)
        val third = data.size / 3

        d.setInput(data, 0, third)
        while (!d.needsInput()) out.write(buf, 0, d.deflate(buf))

        d.setLevel(9)
        d.setStrategy(Deflater.FILTERED)
        d.setInput(data, third, third)
        while (!d.needsInput()) out.write(buf, 0, d.deflate(buf, 0, buf.size, Deflater.NO_FLUSH))
        flush(d, out, buf, Deflater.SYNC_FLUSH)

        d.setLevel(1)
        d.setStrategy(Deflater.DEFAULT_STRATEGY)
        d.setInput(data, 2 * third, data.size - 2 * third)
        flush(d, out, buf, Deflater.FULL_FLUSH)

        d.finish()
        while (!d.finished()) out.write(buf, 0, d.deflate(buf))
        return Result(out.toByteArray(), d.bytesRead, d.bytesWritten, d.adler)
    }

    /** java.util.zip.DeflaterOutputStream.flush's loop. */
    private fun flush(d: IDeflater, out: ByteArrayOutputStream, buf: ByteArray, mode: Int) {
        while (true) {
            val n = d.deflate(buf, 0, buf.size, mode)
            if (n <= 0) break
            out.write(buf, 0, n)
            if (n < buf.size && d.needsInput()) break
        }
    }

    private fun inflate(bytes: ByteArray, nowrap: Boolean): ByteArray {
        val inflater = Inflater(nowrap)
        inflater.setInput(bytes)
        val out = ByteArrayOutputStream()
        val buf = ByteArray(4096)
        while (!inflater.finished()) {
            val n = inflater.inflate(buf)
            if (n == 0 && (inflater.needsInput() || inflater.needsDictionary())) break
            out.write(buf, 0, n)
        }
        inflater.end()
        return out.toByteArray()
    }

    /** Byte-equality with the JDK is only expected where the JDK itself runs stock zlib. */
    private fun jdkUsesStockZlib(): Boolean =
        DeflaterSelfCheck.passes(BiFunction { level, nowrap -> DefaultDeflater(level, nowrap) })

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            if (t is T) return
            throw AssertionError("expected ${T::class.java.simpleName}, got $t", t)
        }
        throw AssertionError("expected ${T::class.java.simpleName}")
    }
}
