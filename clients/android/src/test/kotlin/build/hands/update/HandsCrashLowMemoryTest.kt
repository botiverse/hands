package build.hands.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsCrashLowMemoryTest {
    private val mb = 1024L * 1024
    private val max = 384 * mb

    @Test
    fun outOfMemoryErrorIsLowMemoryEvenWithHeadroom() {
        assertTrue(HandsCrash.isLowMemoryCrash(OutOfMemoryError("x"), usedBytes = 10 * mb, maxBytes = max))
    }

    @Test
    fun wrappedOutOfMemoryErrorIsLowMemory() {
        val wrapped = RuntimeException("outer", IllegalStateException("mid", OutOfMemoryError("x")))
        assertTrue(HandsCrash.isLowMemoryCrash(wrapped, usedBytes = 10 * mb, maxBytes = max))
    }

    @Test
    fun exhaustedHeapIsLowMemoryForAnyException() {
        assertTrue(HandsCrash.isLowMemoryCrash(IllegalStateException("x"), usedBytes = 383 * mb, maxBytes = max))
    }

    @Test
    fun ordinaryCrashWithHeadroomCollectsEverything() {
        assertFalse(HandsCrash.isLowMemoryCrash(IllegalStateException("x"), usedBytes = 100 * mb, maxBytes = max))
    }

    @Test
    fun unknownHeapLimitIsNotLowMemory() {
        assertFalse(HandsCrash.isLowMemoryCrash(IllegalStateException("x"), usedBytes = 100 * mb, maxBytes = Long.MAX_VALUE))
    }
}
