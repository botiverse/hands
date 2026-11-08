package build.hands.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsAnrBuildStampTest {
    private val unknown = HandsHistoricalBuild(null, null)

    @Test
    fun exactBuildRoundTripsWithoutUploaderFallback() {
        val old = HandsHistoricalBuild("1.21.0", 12_100_006L)
        val newer = HandsHistoricalBuild("1.22.0", 12_200_001L)
        val oldStamp = HandsAnrBuildStamp.encode(old)!!
        val newerStamp = HandsAnrBuildStamp.encode(newer)!!
        assertEquals(old, HandsAnrBuildStamp.decode(oldStamp))
        assertEquals(newer, HandsAnrBuildStamp.decode(newerStamp))
        assertEquals(unknown, HandsAnrBuildStamp.decode(null))
        assertEquals(emptyMap<String, Any>(), HandsAnr.historicalVersionExtras(null))
        assertEquals(mapOf("version_name" to old.versionName, "version_code" to old.versionCode),
            HandsAnr.historicalVersionExtras(oldStamp))
        assertEquals(mapOf("version_name" to newer.versionName, "version_code" to newer.versionCode),
            HandsAnr.historicalVersionExtras(newerStamp))
    }

    @Test
    fun codeAndNameMayBeIndependentlyAbsent() {
        for (build in listOf(
            HandsHistoricalBuild(null, 123L),
            HandsHistoricalBuild("1.21.0", null),
            HandsHistoricalBuild("1.21.0", 0L),
        )) {
            assertEquals(build, HandsAnrBuildStamp.decode(HandsAnrBuildStamp.encode(build)))
        }
        assertNull(HandsAnrBuildStamp.encode(unknown))
    }

    @Test
    fun overlongNamesNeverProduceATruncatedReleaseName() {
        val name = "1.21-" + "🚀".repeat(100)
        val stamp = HandsAnrBuildStamp.encode(HandsHistoricalBuild(name, 42L))!!
        assertTrue(stamp.size <= HandsAnrBuildStamp.MAX_BYTES)
        assertEquals(HandsHistoricalBuild(null, 42L), HandsAnrBuildStamp.decode(stamp))
        assertNull(HandsAnrBuildStamp.encode(HandsHistoricalBuild(name, null)))
    }

    @Test
    fun utf8LimitIsMeasuredInBytesAndExactBoundaryIsAccepted() {
        val prefix = "hands-build:1\n42\n"
        val name = "é".repeat((HandsAnrBuildStamp.MAX_BYTES - prefix.length) / 2) + "x"
        val bytes = HandsAnrBuildStamp.encode(HandsHistoricalBuild(name, 42L))!!
        assertEquals(HandsAnrBuildStamp.MAX_BYTES, bytes.size)
        assertEquals(HandsHistoricalBuild(name, 42L), HandsAnrBuildStamp.decode(bytes))
    }

    @Test
    fun decodesRaftWorkaroundAndTreatsPossiblyTruncatedLegacyNameAsUnknown() {
        val old = "raft-build:1\n12100006\n1.21.0".toByteArray()
        assertEquals(HandsHistoricalBuild("1.21.0", 12_100_006L), HandsAnrBuildStamp.decode(old))
        val prefix = "raft-build:1\n12100006\n"
        for (size in 125..128) {
            val maybeTruncated = (prefix + "a".repeat(size - prefix.length)).toByteArray()
            assertEquals(HandsHistoricalBuild(null, 12_100_006L), HandsAnrBuildStamp.decode(maybeTruncated))
        }
    }

    @Test
    fun rejectsMalformedForeignOrUnsafeSummaries() {
        val bad = listOf(
            byteArrayOf(),
            ByteArray(129),
            "other:1\n123\n1.0".toByteArray(),
            "hands-build:2\n123\n1.0".toByteArray(),
            "hands-build:1\n-1\n1.0".toByteArray(),
            "hands-build:1\n+1\n1.0".toByteArray(),
            "hands-build:1\n01\n1.0".toByteArray(),
            "hands-build:1\n9007199254740992\n1.0".toByteArray(),
            "hands-build:1\n9223372036854775808\n1.0".toByteArray(),
            "hands-build:1\n1\n1.0\nextra".toByteArray(),
            "hands-build:1\n1\n1.0\u0000".toByteArray(),
            "raft-build:1\n0\n1.0".toByteArray(),
            "raft-build:1\n1\n".toByteArray(),
            "hands-build:1\n1\n".toByteArray() + byteArrayOf(0xc3.toByte(), 0x28),
        )
        bad.forEach { assertEquals(unknown, HandsAnrBuildStamp.decode(it)) }
        assertEquals(unknown, HandsAnrBuildStamp.decode(null))
        assertNull(HandsAnrBuildStamp.encode(HandsHistoricalBuild("\uD800", null)))
        assertEquals(HandsHistoricalBuild(null, 7L),
            HandsAnrBuildStamp.decode(HandsAnrBuildStamp.encode(HandsHistoricalBuild("\uD800", 7L))))
    }

    @Test
    fun unsafeNamesDoNotEnterTheProcessSummary() {
        val stamp = HandsAnrBuildStamp.encode(HandsHistoricalBuild("bad\nline", 7L))!!
        assertFalse(stamp.toString(Charsets.UTF_8).contains("bad"))
        assertEquals(HandsHistoricalBuild(null, 7L), HandsAnrBuildStamp.decode(stamp))
        assertNull(HandsAnrBuildStamp.encode(HandsHistoricalBuild("bad\nline", null)))
    }
}
