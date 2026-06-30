package io.quiver.update.internal

import io.quiver.update.models.UpdateCheckResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Low-level HTTP client for the quiver public API.
 *
 * No auth needed — the `/public/*` endpoints are intentionally unauthenticated.
 * Designed to be replaceable (e.g. swap OkHttp for Ktor) without touching the
 * higher-level UpdateChecker.
 */
class QuiverClient(
    private val baseUrl: String,
    private val httpClient: OkHttpClient = defaultClient(),
    private val json: Json = defaultJson(),
) {
    /**
     * Ask the server whether this client should update.
     *
     * @throws QuiverException.NoSuchApp        if 404
     * @throws QuiverException.NetworkError     on IO failure
     * @throws QuiverException.InvalidResponse  on parse failure
     */
    suspend fun checkForUpdate(
        slug: String,
        channel: String = "main",
        currentVersionCode: Long,
        productType: String = "android-apk",
        platform: String = "android",
        arch: String? = null,
        filetype: String = "apk",
    ): UpdateCheckResponse = withContext(Dispatchers.IO) {
        val url = buildString {
            append(baseUrl.trimEnd('/'))
            append("/public/v2/apps/")
            append(slug)
            append("/updates/check?channel=")
            append(channel)
            append("&product_type=")
            append(productType)
            append("&current_version_code=")
            append(currentVersionCode)
            append("&platform=")
            append(platform)
            append("&filetype=")
            append(filetype)
            if (!arch.isNullOrBlank()) {
                append("&arch=")
                append(arch)
            }
        }
        val request = Request.Builder()
            .url(url)
            .header("accept", "application/json")
            .build()

        httpClient.newCall(request).execute().use { response ->
            val body = response.body?.string()
                ?: throw QuiverException.NetworkError("empty response body")

            when (response.code) {
                200 -> try {
                    json.decodeFromString(UpdateCheckResponse.serializer(), body)
                } catch (e: Exception) {
                    throw QuiverException.InvalidResponse(body, e)
                }
                404 -> throw QuiverException.NoSuchApp(slug, channel)
                else -> throw QuiverException.HttpError(response.code, body)
            }
        }
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()

        fun defaultJson(): Json = Json {
            ignoreUnknownKeys = true
            isLenient = true
        }
    }
}

sealed class QuiverException(message: String) : RuntimeException(message) {
    class NoSuchApp(slug: String, channel: String) :
        QuiverException("app '$slug' has no enabled version for channel '$channel'")
    class NetworkError(detail: String) :
        QuiverException("network error: $detail")
    class InvalidResponse(body: String, cause: Throwable) :
        QuiverException("invalid server response: ${body.take(200)}", cause)
    class HttpError(code: Int, body: String) :
        QuiverException("server returned HTTP $code: ${body.take(200)}")
}
