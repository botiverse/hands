package io.quiver.update

import android.content.Context
import android.os.Build
import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Feedback submission to the Quiver server (companion to UpdateChecker).
 *
 * Posts `multipart/form-data` to `POST /public/v2/apps/{slug}/feedback` with
 * the message, optional contact, optional attachments (screenshots, logs;
 * server caps: 3 files, 10 MB each), and device/app metadata including the
 * same persistent device id used for staged rollouts so tickets can be
 * correlated with rollout cohorts.
 */
class QuiverFeedback(
    private val context: Context,
    private val baseUrl: String,
    private val appSlug: String,
    private val versionName: String? = null,
    private val versionCode: Long? = null,
    private val channel: String? = null,
    private val httpClient: OkHttpClient = defaultClient(),
) {
    /**
     * @param message  user-visible feedback text (required)
     * @param kind     "feedback" | "bug" | "crash"
     * @param contact  optional reply-to handle (email, Raft name, …)
     * @param attachments up to 3 files, 10 MB each (server enforced)
     * @param extras   extra metadata merged into the ticket's metadata_json
     * @return ticket id
     */
    suspend fun submit(
        message: String,
        kind: String = "feedback",
        contact: String? = null,
        attachments: List<File> = emptyList(),
        extras: Map<String, Any?> = emptyMap(),
    ): String = withContext(Dispatchers.IO) {
        require(message.isNotBlank()) { "message must not be blank" }

        val metadata = JSONObject().apply {
            versionName?.let { put("version_name", it) }
            versionCode?.let { put("version_code", it) }
            channel?.let { put("channel", it) }
            put("device_id", QuiverDeviceId.get(context))
            put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            put("os_version", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString())
            put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            put("locale", Locale.getDefault().toLanguageTag())
            for ((key, value) in extras) put(key, value ?: JSONObject.NULL)
        }

        val bodyBuilder = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("message", message)
            .addFormDataPart("kind", kind)
            .addFormDataPart("metadata", metadata.toString())
        if (!contact.isNullOrBlank()) {
            bodyBuilder.addFormDataPart("contact", contact)
        }
        for (file in attachments.take(3)) {
            if (!file.isFile) continue
            bodyBuilder.addFormDataPart(
                "attachments",
                file.name,
                file.asRequestBody(guessMediaType(file.name).toMediaTypeOrNull()),
            )
        }

        val url = baseUrl.trimEnd('/').toHttpUrl().newBuilder()
            .addPathSegments("public/v2/apps")
            .addPathSegment(appSlug)
            .addPathSegment("feedback")
            .build()
        val request = Request.Builder()
            .url(url)
            .header("accept", "application/json")
            .post(bodyBuilder.build())
            .build()

        httpClient.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (response.code !in 200..299) {
                throw QuiverFeedbackException(response.code, body.take(300))
            }
            // {"id":"…","status":"open","attachments":N}
            JSONObject(body).optString("id").ifBlank {
                throw QuiverFeedbackException(response.code, "missing ticket id in response")
            }
        }
    }

    private fun guessMediaType(name: String): String = when {
        name.endsWith(".png", true) -> "image/png"
        name.endsWith(".jpg", true) || name.endsWith(".jpeg", true) -> "image/jpeg"
        name.endsWith(".webp", true) -> "image/webp"
        name.endsWith(".txt", true) || name.endsWith(".log", true) -> "text/plain"
        name.endsWith(".json", true) || name.endsWith(".jsonl", true) -> "application/json"
        name.endsWith(".zip", true) -> "application/zip"
        else -> "application/octet-stream"
    }

    companion object {
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

class QuiverFeedbackException(val code: Int, detail: String) :
    RuntimeException("feedback submission failed (HTTP $code): $detail")
