package build.hands.update

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsAnrTest {
    private val now = 1_800_000_000_000L
    private fun anr(pid: Int, ts: Long) = HandsAnr.AnrExit(pid, ts, ApplicationExitInfo.REASON_ANR)

    @Test
    fun selectsOnlyAnrExitsNewerThanTheWatermarkOldestFirst() {
        val picked = HandsAnr.selectPending(
            exits = listOf(
                anr(3, now - 1_000),
                HandsAnr.AnrExit(4, now - 500, ApplicationExitInfo.REASON_CRASH_NATIVE),
                HandsAnr.AnrExit(5, now - 400, ApplicationExitInfo.REASON_CRASH),
                anr(2, now - 5_000),
                anr(1, now - 10_000), // == watermark: already reported
                anr(3, now - 1_000), // duplicate record
            ),
            watermark = now - 10_000,
            now = now,
        )
        assertEquals(listOf(anr(2, now - 5_000), anr(3, now - 1_000)), picked)
    }

    @Test
    fun firstRunLooksBackOnlyABoundedWindow() {
        val picked = HandsAnr.selectPending(
            exits = listOf(
                anr(1, now - HandsAnr.FIRST_RUN_LOOKBACK_MS - 1),
                anr(2, now - HandsAnr.FIRST_RUN_LOOKBACK_MS + 1),
            ),
            watermark = null,
            now = now,
        )
        assertEquals(listOf(anr(2, now - HandsAnr.FIRST_RUN_LOOKBACK_MS + 1)), picked)
    }

    @Test
    fun capsReportsPerLaunchKeepingTheNewest() {
        val exits = (1..10).map { anr(it, now - (100 - it) * 1_000L) }
        val picked = HandsAnr.selectPending(exits, watermark = 0L, now = now)
        assertEquals(HandsAnr.MAX_REPORTS_PER_LAUNCH, picked.size)
        assertEquals(listOf(8, 9, 10), picked.map { it.pid })
    }

    private val trace = """
        ----- pid 4123 at 2026-09-25 12:00:00.000 -----
        Cmd line: com.example.raft

        "Signal Catcher" daemon prio=10 tid=4 Runnable
          at java.lang.Object.wait(Native method)

        "main" prio=5 tid=1 Blocked
          | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72a0 self=0xb400
          at java.lang.Thread.sleep(Native method)
          at android.os.SystemClock.sleep(SystemClock.java:131)
          at com.example.raft.members.MemberTab.bind(MemberTab.kt:88)
          at com.example.raft.members.MemberTab.onCreate(MemberTab.kt:40)
          - locked <0x0af1> (a java.lang.Object)
          at android.app.Activity.performCreate(Activity.java:8000)

        "RenderThread" daemon prio=7 tid=12 Native
          at com.example.raft.Other.run(Other.kt:1)
    """.trimIndent()

    @Test
    fun extractsMainThreadFramesOnly() {
        val frames = HandsAnr.mainThreadFrames(trace)
        assertEquals(5, frames.size)
        assertEquals("java.lang.Thread.sleep(Native method)", frames.first())
        assertFalse(frames.any { it.contains("Other.run") || it.contains("Object.wait") })
    }

    @Test
    fun groupsByFirstAppFrameSkippingFrameworkFrames() {
        val frame = HandsAnr.groupingFrame(HandsAnr.mainThreadFrames(trace))
        assertEquals("com.example.raft.members.MemberTab.bind(MemberTab.kt:88)", frame)
        // All-framework stack falls back to the top frame; no trace → "".
        assertEquals("android.os.MessageQueue.nativePollOnce(Native method)",
            HandsAnr.groupingFrame(listOf("android.os.MessageQueue.nativePollOnce(Native method)")))
        assertEquals("", HandsAnr.groupingFrame(emptyList()))
    }

    @Test
    fun messageCarriesDescriptionAndFrame() {
        assertEquals(
            "ANR: Input dispatching timed out\nat a.B.c(B.kt:1)",
            HandsAnr.message("Input dispatching timed out", "a.B.c(B.kt:1)"),
        )
        assertEquals("ANR", HandsAnr.message(null, ""))
    }

    @Test
    fun onlyNonRetryable4xxIsPermanent() {
        assertTrue(HandsAnr.isPermanentRejection(HandsFeedbackException(400, "bad")))
        assertTrue(HandsAnr.isPermanentRejection(HandsFeedbackException(413, "big")))
        assertFalse(HandsAnr.isPermanentRejection(HandsFeedbackException(429, "slow")))
        assertFalse(HandsAnr.isPermanentRejection(HandsFeedbackException(408, "t")))
        assertFalse(HandsAnr.isPermanentRejection(HandsFeedbackException(503, "down")))
        assertFalse(HandsAnr.isPermanentRejection(java.io.IOException("offline")))
    }
}
