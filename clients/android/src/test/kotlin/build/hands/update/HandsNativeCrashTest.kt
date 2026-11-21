package build.hands.update

import android.app.ApplicationExitInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

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

    private val minimalFrames = """
        registers
        pc 0x70001234
        frames
        0x70001234 context_pc
        modules
        0x70000000-0x70010000 1de2e1c0bc046f0654f9fdc8173912735aeea751 /data/app/lib/arm64/libraft.so
        maps
        70000000-70010000 r-xp 00000000 00:00 0 /data/app/lib/arm64/libraft.so
    """.trimIndent()

    @Test
    fun parsesProcessIdentityAndRejectsMalformedEventIds() {
        val withIdentity = HandsNativeCrash.parseRecord(
            "QNC2\nsignal 11\ncrash_at 1721810000123\npid 4123\nprocess_start_at 1721809990000\n" +
                "process_event_id 3F2B9C1E-8D4A-4B6E-9C1F-2A7D5E8B0C34\n" + minimalFrames,
        )!!
        assertEquals(1721809990000L, withIdentity.processStartAt)
        assertEquals("3f2b9c1e-8d4a-4b6e-9c1f-2a7d5e8b0c34", withIdentity.processEventId)

        val malformed = HandsNativeCrash.parseRecord(
            "QNC2\nsignal 11\ncrash_at 1\npid 1\nprocess_start_at 0\nprocess_event_id not-a-uuid\n" + minimalFrames,
        )!!
        assertNull(malformed.processStartAt)
        assertNull(malformed.processEventId)

        val legacy = HandsNativeCrash.parseRecord("QNC2\nsignal 11\ncrash_at 1\npid 1\n" + minimalFrames)!!
        assertNull(legacy.processEventId)
    }

    @Test
    fun mergedResponsesAreSuccessWithOrWithoutAnId() {
        assertEquals(HandsFeedback.Submission("t1", false), HandsFeedback.parseSubmission(201, """{"id":"t1","status":"open"}"""))
        assertEquals(HandsFeedback.Submission(null, true), HandsFeedback.parseSubmission(200, """{"merged":true}"""))
        assertEquals(HandsFeedback.Submission("t1", true), HandsFeedback.parseSubmission(200, """{"id":"t1","merged":true}"""))
        assertTrue(runCatching { HandsFeedback.parseSubmission(200, """{"status":"open"}""") }.exceptionOrNull() is HandsFeedbackException)
    }

    @Test
    fun submissionIdPatternMatchesTheServer() {
        assertTrue(HandsFeedback.SUBMISSION_ID_PATTERN.matches(java.util.UUID.randomUUID().toString()))
        assertTrue(!HandsFeedback.SUBMISSION_ID_PATTERN.matches("3f2b9c1e8d4a4b6e9c1f2a7d5e8b0c34"))
    }

    @Test
    fun processBuildRoundTripsAndUnknownWritesNothing() {
        val dir = Files.createTempDirectory("qnc-build").toFile()
        val crashed = "53fdf0b8-23bb-4d17-962c-f700012c6e78"
        val build = HandsHistoricalBuild("1.0.0-alpha+53e35e9f28", 10_000_243L)
        HandsNativeCrash.writeProcessBuild(dir, crashed, build)
        assertEquals(build, HandsNativeCrash.readProcessBuild(dir, crashed))
        assertEquals(
            mapOf("version_name" to "1.0.0-alpha+53e35e9f28", "version_code" to 10_000_243L),
            HandsHistoricalBuildPolicy.versionExtras(HandsNativeCrash.readProcessBuild(dir, crashed)),
        )

        val unknownProcess = "00000000-0000-4000-8000-000000000001"
        HandsNativeCrash.writeProcessBuild(dir, unknownProcess, HandsHistoricalBuild(null, null))
        assertFalse(File(dir, "$unknownProcess.build").exists())
        // No file (or no id): the ticket build stays empty rather than the uploader's.
        assertEquals(emptyMap<String, Any>(), HandsHistoricalBuildPolicy.versionExtras(HandsNativeCrash.readProcessBuild(dir, unknownProcess)))
        assertEquals(HandsHistoricalBuild(null, null), HandsNativeCrash.readProcessBuild(dir, null))
    }

    @Test
    fun processBuildRejectsNonUuidIdsAndPrunesOrphans() {
        val dir = Files.createTempDirectory("qnc-build").toFile()
        val build = HandsHistoricalBuild("1.2.3", 42L)
        HandsNativeCrash.writeProcessBuild(dir, "../escape", build)
        assertEquals(0, dir.listFiles()!!.size)

        val pending = "11111111-1111-4111-8111-111111111111"
        val orphan = "22222222-2222-4222-8222-222222222222"
        HandsNativeCrash.writeProcessBuild(dir, pending, build)
        HandsNativeCrash.writeProcessBuild(dir, orphan, build)
        HandsNativeCrash.writeProcessBuild(dir, HandsNativeCrash.processEventId, build)
        HandsNativeCrash.pruneProcessBuilds(dir, setOf(pending))
        assertTrue(File(dir, "$pending.build").exists())
        assertFalse(File(dir, "$orphan.build").exists())
        // This process's own build file survives: it may still crash.
        assertTrue(File(dir, "${HandsNativeCrash.processEventId}.build").exists())
    }
}
