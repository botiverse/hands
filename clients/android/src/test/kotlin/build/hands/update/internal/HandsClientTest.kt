package build.hands.update.internal

import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HandsClientTest {
    @Test
    fun `explicit Chinese locale is sent through both supported headers`() = runBlocking {
        val request = execute("zh-CN")

        assertEquals("zh-CN", request.header("X-Hands-Lang"))
        assertEquals("zh-CN", request.header("Accept-Language"))
    }

    @Test
    fun `explicit Japanese locale is sent unchanged`() = runBlocking {
        val request = execute("ja")

        assertEquals("ja", request.header("X-Hands-Lang"))
        assertEquals("ja", request.header("Accept-Language"))
    }

    @Test
    fun `missing or malformed locale omits locale headers`() = runBlocking {
        listOf<String?>(null, "", "unsupported_locale").forEach { languageTag ->
            val request = execute(languageTag)
            assertNull(request.header("X-Hands-Lang"))
            assertNull(request.header("Accept-Language"))
        }
    }

    @Test
    fun `well formed unsupported locale reaches server for English fallback`() = runBlocking {
        val request = execute("de-DE")

        assertEquals("de-DE", request.header("X-Hands-Lang"))
        assertEquals("de-DE", request.header("Accept-Language"))
    }

    private suspend fun execute(languageTag: String?): Request {
        var captured: Request? = null
        val client = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                captured = chain.request()
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body(NO_UPDATE.toResponseBody("application/json".toMediaType()))
                    .build()
            })
            .build()
        HandsClient("https://hands.example.test", client).checkForUpdate(
            slug = "raft-android",
            currentVersionCode = 1000010,
            languageTag = languageTag,
        )
        return requireNotNull(captured)
    }

    private companion object {
        const val NO_UPDATE = """
            {
              "update_available": false,
              "app": {"slug": "raft-android", "platform": "android"},
              "channel": "main",
              "current_version_code": 1000010,
              "latest_version_code": 1000010,
              "checked_at": 1
            }
        """
    }
}
