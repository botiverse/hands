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
 * active-device and version-distribution analytics on the Hands console.
 *
 * Sent at most once per UTC day per install, and again as soon as the app's
 * version code or channel changes (an upgrade), so the new version counts as
 * active on the day it is installed. The last successful ping is kept in the
 * same SharedPreferences as the device id, so calling [reportDevice] on every
 * launch is cheap. Carries no PII — only the random per-install device id
 * and build/OS metadata.
 */
object HandsAnalytics {
    private const val PREFS_NAME = "quiver_update"
    private const val KEY_LAST_PING = "last_device_ping_at"
    private const val KEY_LAST_VERSION_CODE = "last_device_ping_version_code"
    private const val KEY_LAST_CHANNEL = "last_device_ping_channel"
    private val DAY_MS = TimeUnit.DAYS.toMillis(1)

    /**
     * Whether to ping: never pinged, a different UTC day than the last ping
     * (also when the clock went backwards), or a different version code or
     * channel than the last ping reported.
     */
    internal fun shouldPing(
        now: Long,
        lastPingAt: Long,
        lastVersionCode: Long?,
        lastChannel: String?,
        versionCode: Long?,
        channel: String?,
    ): Boolean {
        if (lastPingAt <= 0L) return true
        if (Math.floorDiv(now, DAY_MS) != Math.floorDiv(lastPingAt, DAY_MS)) return true
        return lastVersionCode != versionCode || lastChannel != channel
    }

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    /**
     * Send a device ping unless one was already sent this UTC day for the
     * same version code and channel. Safe to call on every launch; runs the
     * network off the caller's thread.
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
            val lastVersionCode = if (prefs.contains(KEY_LAST_VERSION_CODE)) prefs.getLong(KEY_LAST_VERSION_CODE, 0L) else null
            val shouldSend = shouldPing(
                now = now,
                lastPingAt = prefs.getLong(KEY_LAST_PING, 0L),
                lastVersionCode = lastVersionCode,
                lastChannel = prefs.getString(KEY_LAST_CHANNEL, null),
                versionCode = versionCode,
                channel = channel,
            )
            if (!shouldSend) return@withContext false
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
            .header("X-Hands-Device-Id", HandsDeviceId.get(appContext))
            .post(metadata.toString().toRequestBody("application/json".toMediaTypeOrNull()))
        if (!clientKey.isNullOrBlank()) {
            requestBuilder.header("X-Hands-Client-Key", clientKey)
        }

        runCatching {
            client.newCall(requestBuilder.build()).execute().use { response ->
                if (response.isSuccessful) {
                    prefs.edit().apply {
                        putLong(KEY_LAST_PING, now)
                        if (versionCode != null) putLong(KEY_LAST_VERSION_CODE, versionCode) else remove(KEY_LAST_VERSION_CODE)
                        if (channel != null) putString(KEY_LAST_CHANNEL, channel) else remove(KEY_LAST_CHANNEL)
                    }.apply()
                    true
                } else {
                    false
                }
            }
        }.getOrDefault(false)
    }
}
