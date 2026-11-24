package build.hands.update.internal

import com.google.archivepatcher.shared.DefaultDeflater
import com.google.archivepatcher.shared.IDeflater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.function.BiFunction

class DeflaterSelfCheckTest {
    @Test
    fun `sample is deterministic and pinned`() {
        val a = DeflaterSelfCheck.sample()
        val b = DeflaterSelfCheck.sample()
        assertEquals(DeflaterSelfCheck.SAMPLE_BYTES, a.size)
        assertTrue(a.contentEquals(b))
        // The expected deflate hashes are only meaningful for this exact input.
        assertEquals(DeflaterSelfCheck.SAMPLE_SHA256, DeflaterSelfCheck.sha256Hex(a))
    }

    @Test
    fun `cases cover levels 6 and 9 with distinct expected outputs`() {
        val levels = DeflaterSelfCheck.CASES.map { it.level }.toSet()
        assertTrue(levels.containsAll(listOf(6, 9)))
        assertEquals(
            DeflaterSelfCheck.CASES.size,
            DeflaterSelfCheck.CASES.map { it.expectedSha256 }.toSet().size,
        )
        DeflaterSelfCheck.CASES.forEach { assertTrue(it.expectedSha256.matches(Regex("[0-9a-f]{64}"))) }
    }

    @Test
    fun `a deflater that throws fails the check without throwing`() {
        val factory = BiFunction<Int, Boolean, IDeflater> { _, _ -> throw UnsatisfiedLinkError("no lib") }
        assertFalse(DeflaterSelfCheck.passes(factory))
    }

    @Test
    fun `a deflater with different output fails the check`() {
        // Level 1 output can never equal stock zlib's level 6/9 output.
        val factory = BiFunction<Int, Boolean, IDeflater> { _, nowrap -> DefaultDeflater(1, nowrap) }
        assertFalse(DeflaterSelfCheck.passes(factory))
    }

    @Test
    fun `a deflater that never finishes fails the check`() {
        val stuck = object : IDeflater by DefaultDeflater(6, true) {
            override fun finished() = false
            override fun deflate(output: ByteArray) = 0
        }
        assertFalse(DeflaterSelfCheck.passes(BiFunction { _, _ -> stuck }))
    }
}
