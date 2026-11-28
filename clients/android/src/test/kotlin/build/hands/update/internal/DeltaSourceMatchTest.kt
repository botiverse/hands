package build.hands.update.internal

import build.hands.update.models.Patch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A patch from another APK of the installed version code is never downloaded. */
class DeltaSourceMatchTest {
    private val installed = "ab".repeat(32)
    private val other = "cd".repeat(32)
    private val patch = Patch(
        from_version_code = 100,
        algorithm = "archive-patcher-v1+gzip",
        download_url = "https://x/p",
        size_bytes = 1_000,
        target_sha256 = "ef".repeat(32),
        from_sha256 = installed,
    )

    private fun reason(p: Patch, sha: String?, enabled: Boolean = true) =
        DeltaUpdater.preflightFallbackReason(p, installedVersionCode = 100, deltaEnabled = enabled, installedSha256 = sha)

    @Test
    fun `a patch from another APK falls back with source_mismatch before any download`() {
        assertEquals("source_mismatch", reason(patch.copy(from_sha256 = other), installed))
        assertFalse(DeltaUpdater.sourceMatches(patch.copy(from_sha256 = other), installed))
    }

    @Test
    fun `a patch from the installed APK, in any hex case, is tried`() {
        assertNull(reason(patch, installed))
        assertNull(reason(patch.copy(from_sha256 = installed.uppercase()), installed))
        assertTrue(DeltaUpdater.sourceMatches(patch, installed.uppercase()))
    }

    @Test
    fun `no recorded source or no installed hash gives no evidence, so the patch is tried`() {
        assertNull(reason(patch.copy(from_sha256 = null), installed))
        assertNull(reason(patch.copy(from_sha256 = ""), installed))
        assertNull(reason(patch.copy(from_sha256 = other), null))
    }

    @Test
    fun `earlier checks keep their own reasons`() {
        assertEquals("flag_off", reason(patch.copy(from_sha256 = other), installed, enabled = false))
        assertEquals("offer_invalid", reason(patch.copy(from_version_code = 99, from_sha256 = other), installed))
        assertEquals("offer_invalid", reason(patch.copy(target_sha256 = null), installed))
    }
}
