package build.hands.update

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * Process-level release-health sessions.
 *
 * Events are committed to SharedPreferences before network delivery and sent
 * in order on a single background executor. A foreground/background bounce
 * shorter than [BACKGROUND_TIMEOUT_MS] remains one session. Fatal crashes add
 * a sticky `crash` event synchronously; the next process launch flushes it.
 */
internal object HandsSessions {
    private const val TAG = "HandsSessions"
    private const val PREFS_NAME = "quiver_update"
    private const val KEY_CURRENT = "hands_current_session"
    private const val KEY_QUEUE = "hands_session_queue"
    private const val MAX_QUEUED_EVENTS = 100
    private const val BACKGROUND_TIMEOUT_MS = 30_000L

    private data class Config(
        val baseUrl: String,
        val appSlug: String,
        val versionName: String?,
        val versionCode: Long?,
        val channel: String?,
        val clientKey: String?,
    )

    private val installed = AtomicBoolean(false)
    private val lock = Any()
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "hands-session-upload").apply { isDaemon = true }
    }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val client by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }

    private lateinit var appContext: Context
    private lateinit var config: Config
    private val endRunnable = Runnable { endCurrentSession() }

    fun install(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String?,
        versionCode: Long?,
        channel: String?,
        clientKey: String?,
    ) {
        if (!installed.compareAndSet(false, true)) return
        appContext = context.applicationContext
        config = Config(baseUrl, appSlug, versionName, versionCode, channel, clientKey)

        recoverStaleSession()
        val lifecycle = ProcessLifecycleOwner.get().lifecycle
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = foreground()

            override fun onStop(owner: LifecycleOwner) {
                mainHandler.removeCallbacks(endRunnable)
                mainHandler.postDelayed(endRunnable, BACKGROUND_TIMEOUT_MS)
            }
        })
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) foreground()
        scheduleFlush()
    }

    /** Called by the uncaught-exception handler; must remain synchronous. */
    fun markCurrentCrashed() {
        if (!installed.get()) return
        synchronized(lock) {
            val prefs = prefs()
            val current = prefs.getString(KEY_CURRENT, null)?.let(::parseObject) ?: return
            val event = copyEvent(current)
                .put("event", "crash")
                .put("duration_ms", elapsed(current))
            enqueueLocked(prefs, event)
            prefs.edit().remove(KEY_CURRENT).commit()
        }
    }

    private fun foreground() {
        mainHandler.removeCallbacks(endRunnable)
        synchronized(lock) {
            val prefs = prefs()
            if (prefs.getString(KEY_CURRENT, null) != null) return
            val now = System.currentTimeMillis()
            val event = baseEvent("start", now)
            prefs.edit().putString(KEY_CURRENT, event.toString()).commit()
            enqueueLocked(prefs, event)
        }
        scheduleFlush()
    }

    private fun endCurrentSession() {
        if (!installed.get()) return
        synchronized(lock) {
            val prefs = prefs()
            val current = prefs.getString(KEY_CURRENT, null)?.let(::parseObject) ?: return
            val event = copyEvent(current)
                .put("event", "end")
                .put("duration_ms", elapsed(current))
            enqueueLocked(prefs, event)
            prefs.edit().remove(KEY_CURRENT).commit()
        }
        scheduleFlush()
    }

    /** Close a session left behind by a process kill, then begin a fresh one. */
    private fun recoverStaleSession() {
        synchronized(lock) {
            val prefs = prefs()
            val stale = prefs.getString(KEY_CURRENT, null)?.let(::parseObject) ?: return
            val event = if (hasNativeCrashSince(stale.optLong("started_at", Long.MAX_VALUE))) {
                "crash"
            } else {
                "end"
            }
            enqueueLocked(prefs, copyEvent(stale).put("event", event))
            prefs.edit().remove(KEY_CURRENT).commit()
        }
    }

    private fun hasNativeCrashSince(startedAt: Long): Boolean =
        (HandsNativeCrash.crashDir(appContext).listFiles { file -> file.name.endsWith(".qnc") }
            ?: emptyArray()).any { record ->
            record.lastModified() >= startedAt ||
                runCatching { HandsNativeCrash.parseRecord(record.readText())?.crashAt ?: 0L }
                    .getOrDefault(0L) >= startedAt
        }

    private fun baseEvent(event: String, startedAt: Long): JSONObject = JSONObject().apply {
        put("_queue_id", UUID.randomUUID().toString())
        put("session_id", UUID.randomUUID().toString())
        put("device_id", HandsDeviceId.get(appContext))
        put("event", event)
        put("started_at", startedAt)
        config.versionName?.let { put("version_name", it) }
        config.versionCode?.let { put("version_code", it) }
        config.channel?.let { put("channel", it) }
        put("platform", "android")
        put("os_version", Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString())
        put("device_model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
    }

    private fun copyEvent(source: JSONObject): JSONObject =
        JSONObject(source.toString()).put("_queue_id", UUID.randomUUID().toString())

    private fun elapsed(event: JSONObject): Long =
        (System.currentTimeMillis() - event.optLong("started_at", System.currentTimeMillis()))
            .coerceAtLeast(0L)

    private fun enqueueLocked(prefs: android.content.SharedPreferences, event: JSONObject) {
        val queue = loadQueue(prefs)
        queue.add(event)
        while (queue.size > MAX_QUEUED_EVENTS) queue.removeAt(0)
        persistQueue(prefs, queue)
    }

    private fun scheduleFlush() {
        if (!installed.get()) return
        executor.execute { flush() }
    }

    private fun flush() {
        while (true) {
            val event = synchronized(lock) { loadQueue(prefs()).firstOrNull() } ?: return
            val queueId = event.optString("_queue_id")
            val payload = JSONObject(event.toString()).apply { remove("_queue_id") }
            val responseCode = runCatching { post(payload) }.getOrElse {
                Log.d(TAG, "Session upload deferred", it)
                return
            }
            val permanentFailure = responseCode in 400..499 && responseCode != 408 && responseCode != 429
            if (responseCode !in 200..299 && !permanentFailure) return
            if (permanentFailure) Log.w(TAG, "Dropping session event rejected with HTTP $responseCode")
            synchronized(lock) {
                val prefs = prefs()
                val queue = loadQueue(prefs)
                queue.removeAll { it.optString("_queue_id") == queueId }
                persistQueue(prefs, queue)
            }
        }
    }

    private fun post(payload: JSONObject): Int {
        val url = config.baseUrl.trimEnd('/').toHttpUrl().newBuilder()
            .addPathSegments("public/v2/apps")
            .addPathSegment(config.appSlug)
            .addPathSegment("sessions")
            .build()
        val request = Request.Builder()
            .url(url)
            .header("accept", "application/json")
            .apply {
                if (!config.clientKey.isNullOrBlank()) {
                    header("X-Hands-Client-Key", config.clientKey!!)
                }
            }
            .post(payload.toString().toRequestBody("application/json".toMediaTypeOrNull()))
            .build()
        return client.newCall(request).execute().use { it.code }
    }

    private fun prefs() = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private fun parseObject(raw: String): JSONObject? = runCatching { JSONObject(raw) }.getOrNull()

    private fun loadQueue(prefs: android.content.SharedPreferences): MutableList<JSONObject> {
        val array = runCatching { JSONArray(prefs.getString(KEY_QUEUE, "[]")) }.getOrElse { JSONArray() }
        return MutableList(array.length()) { index -> array.optJSONObject(index) ?: JSONObject() }
    }

    private fun persistQueue(
        prefs: android.content.SharedPreferences,
        queue: List<JSONObject>,
    ) {
        val array = JSONArray()
        queue.forEach(array::put)
        prefs.edit().putString(KEY_QUEUE, array.toString()).commit()
    }
}
