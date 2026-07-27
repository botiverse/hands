package build.hands.update

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsUpdateTransactionTest {
    @Test
    fun `wire states are stable lower-case constants`() {
        assertEquals(
            listOf(
                "idle",
                "checking",
                "patching",
                "downloading",
                "ready_to_install",
                "installer_opened",
                "failed",
                "stale",
                "installed",
            ),
            HandsUpdateState.entries.map { it.wireValue },
        )
    }

    @Test
    fun `locale resolution matches exact then language prefix and English fallback`() {
        val notes = linkedMapOf(
            "en" to "English",
            "zh-CN" to "中文",
            "ja" to "日本語",
        )

        assertEquals("zh-CN", resolveLanguageTag("zh-CN", notes))
        assertEquals("ja", resolveLanguageTag("ja-JP", notes))
        assertEquals("en", resolveLanguageTag(null, notes))
        assertEquals("en", resolveLanguageTag("de-DE", notes))
    }

    @Test
    fun `malformed locale is omitted instead of entering an HTTP header`() {
        assertEquals("zh-CN", normalizedLanguageTag(" zh-CN "))
        assertNull(normalizedLanguageTag(null))
        assertNull(normalizedLanguageTag(""))
        assertNull(normalizedLanguageTag("zh_CN"))
        assertNull(normalizedLanguageTag("en\r\nX-Injected: yes"))
    }

    @Test
    fun `public status serializes stable state and host telemetry fields`() {
        val status = HandsUpdateStatus(
            state = HandsUpdateState.READY_TO_INSTALL,
            targetVersionCode = 1000011,
            installedVersionCode = 1000010,
            retryable = false,
            targetBuildId = "build-11",
            assetSha256 = "a".repeat(64),
            requestedLanguageTag = "zh-CN",
            resolvedLanguageTag = "zh-CN",
            updatedAt = 1234,
        )

        val encoded = Json.encodeToString(status)
        assertTrue(encoded.contains("\"state\":\"ready_to_install\""))
        assertEquals(status, Json.decodeFromString<HandsUpdateStatus>(encoded))
    }

    @Test
    fun `authority storage keys separate channel and app identities`() {
        fun authority(app: String, channel: String) = UpdateAuthority(
            packageName = "build.raft.app.alpha",
            baseUrl = "https://hands.example.test/",
            appSlug = app,
            channel = channel,
            productType = "android-apk",
            platform = "android",
            arch = null,
        )

        assertEquals(authority("raft", "main").storageKey(), authority("raft", "main").storageKey())
        assertTrue(authority("raft", "main").storageKey() != authority("raft", "alpha").storageKey())
        assertTrue(authority("raft", "main").storageKey() != authority("other", "main").storageKey())
    }
}
