package build.hands.update

import build.hands.update.models.App
import build.hands.update.models.LatestUpdate
import build.hands.update.models.Patch
import build.hands.update.models.UpdateAsset
import build.hands.update.models.UpdateCheckResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsUpdateOfferTest {
    private fun response(
        notes: Map<String, String>? = mapOf("en" to "Fixes", "zh-CN" to "修复"),
        changelog: String? = "Plain changelog",
        patch: Patch? = null,
        available: Boolean = true,
    ) = UpdateCheckResponse(
        update_available = available,
        app = APP,
        channel = "main",
        current_version_code = 100,
        latest = LatestUpdate(
            build_id = "b1",
            version = "0.2.0",
            version_code = 200,
            changelog = changelog,
            release_notes = notes,
            force_update = true,
            released_at = 1_700_000_000_000,
        ),
        asset = UpdateAsset(platform = "android", filetype = "apk", size_bytes = 9_000, download_url = "https://x/a.apk"),
        patch = patch,
    )

    private val goodPatch = Patch(
        from_version_code = 100,
        algorithm = "archive-patcher-v1+gzip",
        download_url = "https://x/p",
        size_bytes = 1_000,
        target_sha256 = "ab",
    )

    @Test
    fun `offer carries notes in the requested language`() {
        val offer = updateOffer(response(), 100, deltaEnabled = true, requestedLanguageTag = "zh-CN")!!
        assertEquals("修复", offer.releaseNotes)
        assertEquals("zh-CN", offer.releaseNotesLanguageTag)
        assertEquals(200L, offer.versionCode)
        assertEquals("0.2.0", offer.versionName)
        assertTrue(offer.forceUpdate)
        assertEquals(9_000L, offer.downloadSizeBytes)
        assertNull(offer.patchSizeBytes)
    }

    @Test
    fun `unknown language falls back to English notes`() {
        val offer = updateOffer(response(), 100, true, "de-DE")!!
        assertEquals("Fixes", offer.releaseNotes)
        assertEquals("en", offer.releaseNotesLanguageTag)
    }

    @Test
    fun `without per-language notes the changelog is used`() {
        val offer = updateOffer(response(notes = null), 100, true, "zh-CN")!!
        assertEquals("Plain changelog", offer.releaseNotes)
        assertNull(offer.releaseNotesLanguageTag)
        assertNull(updateOffer(response(notes = null, changelog = " "), 100, true, null)!!.releaseNotes)
    }

    @Test
    fun `an applicable patch sets the download size`() {
        val offer = updateOffer(response(patch = goodPatch), 100, true, null)!!
        assertEquals(1_000L, offer.downloadSizeBytes)
        assertEquals(1_000L, offer.patchSizeBytes)
        assertEquals(9_000L, offer.fullSizeBytes)
    }

    @Test
    fun `a patch this device cannot apply is ignored`() {
        assertFalse(patchApplies(goodPatch, 100, deltaEnabled = false))
        assertFalse(patchApplies(goodPatch.copy(from_version_code = 99), 100, true))
        assertFalse(patchApplies(goodPatch.copy(algorithm = "bsdiff"), 100, true))
        assertFalse(patchApplies(goodPatch.copy(algorithm = "archive-patcher-v1+zstd"), 100, true))
        assertFalse(patchApplies(goodPatch.copy(target_sha256 = null), 100, true))
        assertFalse(patchApplies(goodPatch.copy(size_bytes = 0), 100, true))
        assertEquals(9_000L, updateOffer(response(patch = goodPatch), 99, true, null)!!.downloadSizeBytes)
    }

    @Test
    fun `an xz patch applies like a gzip one`() {
        assertTrue(patchApplies(goodPatch.copy(algorithm = "archive-patcher-v1+xz"), 100, true))
        assertTrue(patchApplies(goodPatch.copy(algorithm = "archive-patcher-v1"), 100, true))
    }

    @Test
    fun `no update means no offer`() {
        assertNull(updateOffer(response(available = false), 100, true, null))
    }

    private companion object {
        val APP = App(slug = "deck", platform = "android")
    }
}
