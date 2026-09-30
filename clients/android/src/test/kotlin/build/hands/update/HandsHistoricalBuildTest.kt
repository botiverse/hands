package build.hands.update

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsHistoricalBuildTest {
    private val crashed = HandsHistoricalBuild("1.12.0-alpha.77", 10000077L)
    private val uploading = HandsHistoricalBuild("1.12.0-alpha.81", 10000081L)

    @Test
    fun oldSidecarKeepsTheCrashedBuildFromTheLog() {
        val log = "Crash log\nPackage: build.hands.raft\n" +
            HandsHistoricalBuildPolicy.crashLogVersionLines(crashed) +
            "Device: test\n"
        val ticket = HandsHistoricalBuildPolicy.resolve(
            versionNamePresent = false,
            versionName = null,
            versionCodePresent = false,
            versionCode = null,
            logText = log,
        )

        assertEquals(crashed, ticket)
        assertFalse(ticket == uploading)
        val extras = HandsHistoricalBuildPolicy.versionExtras(ticket)
        assertEquals("1.12.0-alpha.77", extras["version_name"])
        assertEquals(10000077L, extras["version_code"])
        assertTrue(extras["version_code"] is Long)
    }

    @Test
    fun emptyVersionLineDoesNotConsumeTheNextLine() {
        val log = "Version name: \nPid/Uid: 123/456\nVersion code: \n10000081\nBundle version: \nPid/Uid: 123/456\n"
        assertEquals(HandsHistoricalBuild(null, null), HandsHistoricalBuildPolicy.fromLog(log))
        assertTrue(HandsHistoricalBuildPolicy.versionExtras(HandsHistoricalBuildPolicy.fromLog(log)).isEmpty())
    }

    @Test
    fun sameLineWhitespaceStillReadsTheVersion() {
        val log = "Version name:\t1.12.0-alpha.77   \nVersion code:   10000077\t\n"
        assertEquals(crashed, HandsHistoricalBuildPolicy.fromLog(log))
    }

    @Test
    fun versionCodeWithTrailingJunkStaysMissing() {
        val log = "Version name: 1.12.0-alpha.77\nVersion code: 10000077 extra\n"
        assertEquals(HandsHistoricalBuild("1.12.0-alpha.77", null), HandsHistoricalBuildPolicy.fromLog(log))
    }

    @Test
    fun headerFormsDoNotStealTheLabeledLines() {
        val log = "Version: 1.0.0-kuikly228\nVersionCode: 10000971\n"
        assertEquals(
            HandsHistoricalBuild("1.0.0-kuikly228", 10000971L),
            HandsHistoricalBuildPolicy.fromLog(log),
        )
    }

    @Test
    fun recordedKeysWinAndDoNotFillGapsFromTheLog() {
        val log = HandsHistoricalBuildPolicy.crashLogVersionLines(uploading)
        val recorded = HandsHistoricalBuildPolicy.resolve(
            versionNamePresent = true,
            versionName = "1.12.0-alpha.77",
            versionCodePresent = false,
            versionCode = null,
            logText = log,
        )
        assertEquals(HandsHistoricalBuild("1.12.0-alpha.77", null), recorded)
    }

    @Test
    fun explicitUnknownDoesNotFallBackToTheLogOrTheUploadingBuild() {
        val log = HandsHistoricalBuildPolicy.crashLogVersionLines(crashed)
        val ticket = HandsHistoricalBuildPolicy.resolve(
            versionNamePresent = true,
            versionName = "",
            versionCodePresent = true,
            versionCode = null,
            logText = log,
        )
        assertEquals(HandsHistoricalBuild(null, null), ticket)
        assertTrue(HandsHistoricalBuildPolicy.versionExtras(ticket).isEmpty())
    }

    @Test
    fun unknownLogStaysEmpty() {
        assertNull(HandsHistoricalBuildPolicy.fromLog("Crash log\nNo version here\n").versionName)
        assertNull(HandsHistoricalBuildPolicy.fromLog("Crash log\nNo version here\n").versionCode)
    }

    @Test
    fun stringAndFractionalCodesAreNotNumbers() {
        assertNull(HandsHistoricalBuildPolicy.versionCodeOrNull("10000077"))
        assertNull(HandsHistoricalBuildPolicy.versionCodeOrNull(10000077.5))
        assertEquals(10000077L, HandsHistoricalBuildPolicy.versionCodeOrNull(10000077))
        assertEquals(10000077L, HandsHistoricalBuildPolicy.versionCodeOrNull(10000077L))
    }

    @Test
    fun writtenLinesRoundTripAndABlankBuildDoesNotCaptureTheFollowingField() {
        assertEquals(crashed, HandsHistoricalBuildPolicy.fromLog(HandsHistoricalBuildPolicy.crashLogVersionLines(crashed)))
        val blank = HandsHistoricalBuildPolicy.crashLogVersionLines(HandsHistoricalBuild(null, null)) +
            "Pid/Uid: 123/456\n"
        assertEquals(HandsHistoricalBuild(null, null), HandsHistoricalBuildPolicy.fromLog(blank))
    }

    @Test
    fun sidecarJsonUsesRecordedNullInsteadOfTheLog() {
        val meta = JSONObject()
            .put("version_name", "")
            .put("version_code", JSONObject.NULL)
        val ticket = HandsCrash.historicalBuildFromSidecar(
            meta,
            HandsHistoricalBuildPolicy.crashLogVersionLines(uploading),
        )
        assertEquals(HandsHistoricalBuild(null, null), ticket)
    }

    @Test
    fun sidecarNumberWinsOverADifferentLog() {
        val meta = JSONObject()
            .put("version_name", "1.12.0-alpha.77")
            .put("version_code", 10000077L)
        val ticket = HandsCrash.historicalBuildFromSidecar(
            meta,
            HandsHistoricalBuildPolicy.crashLogVersionLines(uploading),
        )
        assertEquals(crashed, ticket)
        assertTrue(HandsHistoricalBuildPolicy.versionExtras(ticket).getValue("version_code") is Long)
    }

    @Test
    fun sidecarStringCodeIsNotAVersionNumber() {
        val meta = JSONObject()
            .put("version_name", "1.12.0-alpha.77")
            .put("version_code", "10000077")
        val ticket = HandsCrash.historicalBuildFromSidecar(
            meta,
            HandsHistoricalBuildPolicy.crashLogVersionLines(uploading),
        )
        assertEquals(HandsHistoricalBuild("1.12.0-alpha.77", null), ticket)
    }

    @Test
    fun sidecarWithoutKeysRecoversTheLogBuild() {
        val ticket = HandsCrash.historicalBuildFromSidecar(
            JSONObject(),
            HandsHistoricalBuildPolicy.crashLogVersionLines(crashed),
        )
        assertEquals(crashed, ticket)
        assertEquals(10000077L, HandsHistoricalBuildPolicy.versionExtras(ticket).getValue("version_code"))
    }
}
