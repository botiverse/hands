package build.hands.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsAnalyticsTest {
    private val day = 86_400_000L
    private val noon = 20_000L * day + day / 2

    @Test
    fun pingsOnFirstLaunch() {
        assertTrue(HandsAnalytics.shouldPing(noon, 0L, null, null, 13000015L, "main"))
    }

    @Test
    fun pingsOncePerUtcDayForTheSameVersion() {
        // Later the same UTC day: no ping.
        assertFalse(HandsAnalytics.shouldPing(noon + day / 3, noon, 13000015L, "main", 13000015L, "main"))
        // Just past UTC midnight, though under 24 hours later: ping.
        assertTrue(HandsAnalytics.shouldPing(21_000L * day + 1, 21_000L * day - 1, 13000015L, "main", 13000015L, "main"))
        // Clock moved back to an earlier day: ping.
        assertTrue(HandsAnalytics.shouldPing(noon - day, noon, 13000015L, "main", 13000015L, "main"))
    }

    @Test
    fun pingsAgainTheSameDayWhenTheVersionOrChannelChanges() {
        assertTrue(HandsAnalytics.shouldPing(noon + 60_000L, noon, 13000015L, "main", 13100019L, "main"))
        assertTrue(HandsAnalytics.shouldPing(noon + 60_000L, noon, 13000015L, "main", 13000015L, "preview"))
        // A ping that sent no version code, then one that does.
        assertTrue(HandsAnalytics.shouldPing(noon + 60_000L, noon, null, "main", 13000015L, "main"))
        assertFalse(HandsAnalytics.shouldPing(noon + 60_000L, noon, null, null, null, null))
    }
}
