package build.hands.update

import android.content.Context
import android.os.Build
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/**
 * Device registration ping: a lightweight launch heartbeat that powers
 * active-device and version-distribution analytics on the Quiver console.
 *
 * Throttled to at most once per day per install (a timestamp in the same
 * SharedPreferences as the device id), so calling [reportDevice] on every
 * launch is cheap. Carries no PII — only the random per-install device id
 * and build/OS metadata.
 */
object QuiverAnalytics {
    private const val PREFS_NAME = "quiver_update"
    private const val KEY_LAST_PING = "last_device_ping_at"
    private val MIN_INTERVAL_MS = TimeUnit.HOURS.toMillis(24)

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    /**
     * Send a device ping if one hasn't been sent in the last 24h. Safe to
     * call on every launch; runs the network off the caller's thread.
     * Returns true if a ping was actually sent.
     */
    suspend fun reportDevice(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
        force: Boolean = false,
    ): Boolean = withContext(Dispatchers.IO) {
        val appContext = context.applicationContext
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (!force) {
            val last = prefs.getLong(KEY_LAST_PING, 0L)
            if (now - last < MIN_INTERVAL_MS) return@withContext false
        }

        val metadata = JSONObject().apply {
            versionName?.let { put("version_name", it) }
            versionCode?.let { put("version_code", it) }
            channel?.let { put("channel", it) }
            put("platform", "android")
            put("arch", Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
            put("os_version", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString())
            put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
            put("locale", Locale.getDefault().toLanguageTag())
        }

        val url = baseUrl.trimEnd('/').toHttpUrl().newBuilder()
            .addPathSegments("public/v2/apps")
            .addPathSegment(appSlug)
            .addPathSegment("metrics")
            .build()
        val requestBuilder = Request.Builder()
            .url(url)
            .header("accept", "application/json")
            .header("X-Quiver-Device-Id", QuiverDeviceId.get(appContext))
            .post(metadata.toString().toRequestBody("application/json".toMediaTypeOrNull()))
        if (!clientKey.isNullOrBlank()) {
            requestBuilder.header("X-Quiver-Client-Key", clientKey)
        }

        runCatching {
            client.newCall(requestBuilder.build()).execute().use { response ->
                if (response.isSuccessful) {
                    prefs.edit().putLong(KEY_LAST_PING, now).apply()
                    true
                } else {
                    false
                }
            }
        }.getOrDefault(false)
    }
}
