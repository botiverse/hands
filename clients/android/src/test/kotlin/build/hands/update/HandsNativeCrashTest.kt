package build.hands.update

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsNativeCrashTest {

    @Test
    fun parsesQnc2CrashContextThreadRegistersAndBuildIds() {
        val record = """
            QNC2
            signal 6
            signal_code -6
            fault_addr 0x7a001234
            crash_at 1721810000123
            pid 4123
            tid 4177
            thread_name_hex 526166742d776f726b6572
            registers
            arch arm64-v8a
            x0 0x1
            x30 0x70002040
            sp 0x7ff0abcd
            pc 0x70001234
            pstate 0x60000000
            frames
            0x70001234 context_pc
            0x70002040 context_lr
            modules
            0x70000000-0x70010000 1de2e1c0bc046f0654f9fdc8173912735aeea751 /data/app/lib/arm64/libraft.so
            0x71000000-0x71010000 - /apex/com.android.runtime/lib64/bionic/libc.so
            maps
            70000000-70010000 r-xp 00000000 00:00 0 /data/app/lib/arm64/libraft.so
            71000000-71010000 r-xp 00004000 00:00 0 /apex/com.android.runtime/lib64/bionic/libc.so
        """.trimIndent()

        val parsed = HandsNativeCrash.parseRecord(record)!!

        assertEquals("QNC2", parsed.format)
        assertEquals("SIGABRT", parsed.signalName)
        assertEquals(-6, parsed.signalCode)
        assertEquals(0x7a001234L, parsed.faultAddress)
        assertEquals(1721810000123L, parsed.crashAt)
        assertEquals(4123L, parsed.pid)
        assertEquals(4177L, parsed.tid)
        assertEquals("Raft-worker", parsed.threadName)
        assertEquals("arm64-v8a", parsed.arch)
        assertEquals("0x70001234", parsed.registers["pc"])
        assertEquals("0x7ff0abcd", parsed.registers["sp"])
        assertEquals(2, parsed.frames.size)
        assertEquals(
            HandsNativeCrash.NativeFrame(
                index = 0,
                offset = 0x1234,
                soname = "libraft.so",
                buildId = "1de2e1c0bc046f0654f9fdc8173912735aeea751",
                source = "context_pc",
            ),
            parsed.frames[0],
        )
        assertEquals("context_lr", parsed.frames[1].source)
    }

    @Test
    fun keepsQnc1ReadableButDoesNotInventBuildIdOrThreadContext() {
        val record = """
            QNC1
            signal 11
            fault_addr 0x42
            crash_at 1721810000999
            frames
            0x7f004200
            maps
            7f000000-7f010000 r-xp 00002000 00:00 0 /data/app/lib/arm64/libhandscrash.so
        """.trimIndent()

        val parsed = HandsNativeCrash.parseRecord(record)!!

        assertEquals("QNC1", parsed.format)
        assertEquals("SIGSEGV", parsed.signalName)
        assertNull(parsed.tid)
        assertNull(parsed.threadName)
        assertTrue(parsed.registers.isEmpty())
        assertEquals(0x6200L, parsed.frames.single().offset)
        assertNull(parsed.frames.single().buildId)
    }

    @Test
    fun rejectsMalformedOrContextFreeRecords() {
        assertNull(HandsNativeCrash.parseRecord("QNC3\nsignal 6\n"))
        assertNull(HandsNativeCrash.parseRecord("QNC2\nsignal 6\nframes\nmodules\nmaps\n"))
        assertNull(
            HandsNativeCrash.parseRecord(
                "QNC2\nsignal 6\nframes\n0x123 context_pc\nmodules\nmaps\n",
            ),
        )
    }

    @Test
    fun ignoresInvalidModuleBuildIdsAndDeduplicatesContextFrames() {
        val record = """
            QNC2
            signal 7
            crash_at 10
            registers
            arch x86_64
            rip 0x400010
            rsp 0x500000
            frames
            0x400010 context_pc
            0x400010 duplicate
            modules
            0x400000-0x410000 not-a-build-id /data/app/lib/x86_64/libfoo.so
            maps
            400000-410000 r-xp 00000000 00:00 0 /data/app/lib/x86_64/libfoo.so
        """.trimIndent()

        val parsed = HandsNativeCrash.parseRecord(record)!!

        assertEquals(1, parsed.frames.size)
        assertNull(parsed.frames.single().buildId)
        assertEquals("context_pc", parsed.frames.single().source)
    }

    @Test
    fun exitEvidenceRequiresSamePidNativeReasonAndNarrowTimestamp() {
        val assignments = HandsNativeCrash.assignExitCandidates(
            records = listOf(HandsNativeCrash.ExitMatchRecord("record", pid = 42, crashAt = 10_000)),
            candidates = listOf(
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 99,
                    timestamp = 10_000,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 10_001,
                    reason = ApplicationExitInfo.REASON_ANR,
                ),
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 20_000,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 10_002,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
            ),
        )

        assertEquals(1, assignments.size)
        assertEquals(10_002L, assignments.getValue("record").timestamp)
    }

    @Test
    fun twoPendingRecordsCannotConsumeTheSameSystemExit() {
        val assignments = HandsNativeCrash.assignExitCandidates(
            records = listOf(
                HandsNativeCrash.ExitMatchRecord("first", pid = 42, crashAt = 10_000),
                HandsNativeCrash.ExitMatchRecord("second", pid = 42, crashAt = 10_003),
            ),
            candidates = listOf(
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 10_001,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 10_004,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
            ),
        )

        assertEquals(10_001L, assignments.getValue("first").timestamp)
        assertEquals(10_004L, assignments.getValue("second").timestamp)
        assertEquals(2, assignments.values.map { it.exitKey }.toSet().size)
    }

    @Test
    fun retryBindingRoundTripsAndReservesItsExitIdentity() {
        val stored = HandsNativeCrash.StoredExitEvidence(
            recordPid = 42,
            recordCrashAt = 10_000,
            exitPid = 42,
            timestamp = 10_001,
            reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
            status = 6,
            importance = 100,
            pss = 1234,
            rss = 5678,
            description = "Abort message\n第二行",
        )
        val decoded = HandsNativeCrash.decodeStoredExitEvidence(
            HandsNativeCrash.encodeStoredExitEvidence(stored),
        )
        assertEquals(stored, decoded)

        val assignments = HandsNativeCrash.assignExitCandidates(
            records = listOf(HandsNativeCrash.ExitMatchRecord("new-record", pid = 42, crashAt = 10_000)),
            candidates = listOf(
                HandsNativeCrash.ExitMatchCandidate(
                    pid = 42,
                    timestamp = 10_001,
                    reason = ApplicationExitInfo.REASON_CRASH_NATIVE,
                ),
            ),
            claimedExitKeys = setOf(stored.exitKey),
        )
        assertTrue(assignments.isEmpty())
    }
}
