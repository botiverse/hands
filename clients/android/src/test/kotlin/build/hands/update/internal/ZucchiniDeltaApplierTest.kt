package build.hands.update.internal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException

/**
 * Runs the real Zucchini applier from the host build of libhandscrash (see
 * buildHostBundledZlib in build.gradle.kts) on fixtures made with the Zucchini
 * generator: raw.zpatch turns old.bin into new.bin, and old-to-new.zpatch.xz is
 * an archive-patcher-zucchini-v1+xz patch from old.zip to new.zip (deflated
 * entries, so the bundled zlib recompression runs too).
 */
class ZucchiniDeltaApplierTest {
    @get:Rule
    val temp = TemporaryFolder()

    private fun fixture(name: String): ByteArray =
        requireNotNull(javaClass.getResourceAsStream("/zucchini/$name")) { "missing fixture $name" }.use { it.readBytes() }

    private fun fixtureFile(name: String): File = temp.newFile(name).apply { writeBytes(fixture(name)) }

    private fun scratch(): File = temp.newFolder("scratch")

    @Test
    fun `host library carries the applier`() {
        assertTrue(ZucchiniNative.isAvailable)
    }

    @Test
    fun `raw patch rebuilds the new blob and leaves no temp files`() {
        val dir = scratch()
        val out = ByteArrayOutputStream()
        ZucchiniDeltaApplier(dir).applyDelta(fixtureFile("old.bin"), ByteArrayInputStream(fixture("raw.zpatch")), out)
        assertArrayEquals(fixture("new.bin"), out.toByteArray())
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test
    fun `corrupt patches fail with an IOException, never with wrong output or a crash`() {
        val good = fixture("raw.zpatch")
        val expected = fixture("new.bin")
        val old = fixtureFile("old.bin")
        val dir = scratch()
        val variants = good.indices.map { i -> good.copyOf().also { it[i] = (it[i].toInt() xor 0x5a).toByte() } } +
            listOf(good.copyOf(good.size / 2), ByteArray(0))
        var failed = 0
        for ((index, bad) in variants.withIndex()) {
            val out = ByteArrayOutputStream()
            try {
                ZucchiniDeltaApplier(dir).applyDelta(old, ByteArrayInputStream(bad), out)
                // A few header bytes (the format's minor version) are not
                // checked; the output is still verified against its CRC.
                assertArrayEquals("variant $index", expected, out.toByteArray())
            } catch (e: IOException) {
                assertTrue(e.message, e.message!!.startsWith("zucchini apply failed: status="))
                failed++
            }
        }
        assertTrue("only $failed of ${variants.size} corrupt patches failed", failed >= variants.size - 4)
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    @Test
    fun `patch for a different old blob is refused`() {
        val wrongOld = temp.newFile("wrong.bin").apply { writeBytes(fixture("new.bin")) }
        try {
            ZucchiniDeltaApplier(scratch()).applyDelta(wrongOld, ByteArrayInputStream(fixture("raw.zpatch")), ByteArrayOutputStream())
            fail("applied to the wrong old blob")
        } catch (e: IOException) {
            assertEquals("zucchini apply failed: status=6", e.message)
        }
    }

    @Test
    fun `archive-patcher zucchini xz patch rebuilds the new archive byte for byte`() {
        val deflaters = requireNotNull(DeltaUpdater.compatibleDeflaterFactory())
        val algorithm = DeltaUpdater.ZUCCHINI_XZ_ALGORITHM
        val stream = DeltaUpdater.openDeltaStream(
            ByteArrayInputStream(fixture("old-to-new.zpatch.xz")),
            requireNotNull(DeltaUpdater.compressionFor(algorithm)),
        )
        assertEquals(PatchEngine.ZUCCHINI, DeltaUpdater.engineFor(algorithm))
        val out = ByteArrayOutputStream()
        stream.use { ZucchiniFileByFileApplier(scratch(), deflaters).applyDelta(fixtureFile("old.zip"), it, out) }
        assertArrayEquals(fixture("new.zip"), out.toByteArray())
    }
}
