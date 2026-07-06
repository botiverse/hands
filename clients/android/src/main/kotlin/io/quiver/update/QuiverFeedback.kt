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
import org.json.JSONArray
import org.json.JSONObject

/**
 * Feedback submission to the Quiver server (companion to UpdateChecker).
 *
 * Posts `multipart/form-data` to `POST /public/v2/apps/{slug}/feedback` with
 * the message, optional contact, optional attachments (screenshots, logs, …),
 * and device/app metadata including the same persistent device id used for
 * staged rollouts so tickets can be correlated with rollout cohorts.
 *
 * Attachments: up to 9 files. Small files (≤ 10 MB) are streamed inline in the
 * multipart body. Larger files (up to 200 MB) are uploaded directly to R2 via
 * a server-issued presigned URL and referenced in the ticket, so big logs /
 * screen recordings never pass through the Worker body limit.
 */
class QuiverFeedback(
    private val context: Context,
    private val baseUrl: String,
    private val appSlug: String,
    private val versionName: String? = null,
    private val versionCode: Long? = null,
    private val channel: String? = null,
    private val clientKey: String? = null,
    private val httpClient: OkHttpClient = defaultClient(),
) {
    /**
     * @param message  user-visible feedback text (required)
     * @param kind     "feedback" | "bug" | "crash"
     * @param contact  optional reply-to handle (email, Raft name, …)
     * @param attachments up to 9 files; ≤ 10 MB inline, up to 200 MB via
     *                    presigned direct-to-R2 upload (server enforced)
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

        val selected = attachments.filter { it.isFile }.take(MAX_ATTACHMENTS)
        for (file in selected) {
            if (file.length() > PRESIGN_MAX_BYTES) {
                throw IllegalArgumentException(
                    "attachment ${file.name} exceeds the ${PRESIGN_MAX_BYTES / (1024 * 1024)} MB limit",
                )
            }
        }
        val inline = selected.filter { it.length() <= MULTIPART_MAX_BYTES }
        val large = selected.filter { it.length() > MULTIPART_MAX_BYTES }

        // Large attachments go straight to R2 via presigned PUT before the
        // ticket is submitted; the ticket then references them by r2_key.
        val presignedRefs = if (large.isNotEmpty()) uploadLargeAttachments(large) else emptyList()

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
        for (file in inline) {
            bodyBuilder.addFormDataPart(
                "attachments",
                file.name,
                file.asRequestBody(guessMediaType(file.name).toMediaTypeOrNull()),
            )
        }
        if (presignedRefs.isNotEmpty()) {
            val arr = JSONArray()
            for (ref in presignedRefs) arr.put(ref)
            bodyBuilder.addFormDataPart("presigned", arr.toString())
        }

        val url = baseUrl.trimEnd('/').toHttpUrl().newBuilder()
            .addPathSegments("public/v2/apps")
            .addPathSegment(appSlug)
            .addPathSegment("feedback")
            .build()
        val requestBuilder = Request.Builder()
            .url(url)
            .header("accept", "application/json")
            .post(bodyBuilder.build())
        if (!clientKey.isNullOrBlank()) {
            requestBuilder.header("X-Quiver-Client-Key", clientKey)
        }
        val request = requestBuilder.build()

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

    /**
     * Presign + PUT each large file directly to R2, returning the `presigned`
     * refs the submit call references. One presign request covers the whole
     * batch; the server returns upload URLs in the same order as the request.
     */
    private fun uploadLargeAttachments(files: List<File>): List<JSONObject> {
        val requestFiles = JSONArray()
        for (file in files) {
            requestFiles.put(
                JSONObject().apply {
                    put("filename", file.name)
                    put("content_type", guessMediaType(file.name))
                    put("size", file.length())
                },
            )
        }
        val presignUrl = baseUrl.trimEnd('/').toHttpUrl().newBuilder()
            .addPathSegments("public/v2/apps")
            .addPathSegment(appSlug)
            .addPathSegment("feedback")
            .addPathSegment("presign")
            .build()
        val presignRequest = Request.Builder()
            .url(presignUrl)
            .header("accept", "application/json")
            .post(
                JSONObject().put("files", requestFiles).toString()
                    .toRequestBody("application/json".toMediaTypeOrNull()),
            )
        if (!clientKey.isNullOrBlank()) {
            presignRequest.header("X-Quiver-Client-Key", clientKey)
        }
        val uploads = httpClient.newCall(presignRequest.build()).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (response.code !in 200..299) {
                throw QuiverFeedbackException(response.code, body.take(300))
            }
            JSONObject(body).optJSONArray("uploads")
                ?: throw QuiverFeedbackException(response.code, "presign response missing uploads")
        }

        val refs = ArrayList<JSONObject>(files.size)
        for (index in files.indices) {
            val file = files[index]
            val upload = uploads.optJSONObject(index)
                ?: throw QuiverFeedbackException(0, "presign response missing entry $index")
            val uploadUrl = upload.optString("upload_url")
            val r2Key = upload.optString("r2_key")
            if (uploadUrl.isBlank() || r2Key.isBlank()) {
                throw QuiverFeedbackException(0, "presign entry $index missing upload_url/r2_key")
            }
            val contentType = guessMediaType(file.name)
            // The presigned PUT signs the content-type, so it must match exactly.
            val putRequest = Request.Builder()
                .url(uploadUrl)
                .put(file.asRequestBody(contentType.toMediaTypeOrNull()))
                .build()
            httpClient.newCall(putRequest).execute().use { response ->
                if (response.code !in 200..299) {
                    throw QuiverFeedbackException(
                        response.code,
                        "R2 upload failed for ${file.name}: ${response.body?.string().orEmpty().take(200)}",
                    )
                }
            }
            refs.add(
                JSONObject().apply {
                    put("r2_key", r2Key)
                    put("filename", file.name)
                    put("content_type", contentType)
                    put("size", file.length())
                },
            )
        }
        return refs
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
        /** Server-enforced: at most 9 attachments per ticket. */
        const val MAX_ATTACHMENTS = 9

        /** Files up to this size are streamed inline in the multipart body. */
        const val MULTIPART_MAX_BYTES = 10L * 1024 * 1024

        /** Files up to this size are uploaded via presigned direct-to-R2 PUT. */
        const val PRESIGN_MAX_BYTES = 200L * 1024 * 1024

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

class QuiverFeedbackException(val code: Int, detail: String) :
    RuntimeException("feedback submission failed (HTTP $code): $detail")
