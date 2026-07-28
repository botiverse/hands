package build.hands.update

import android.content.Context
import java.io.PrintWriter
import java.io.StringWriter
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONArray
import org.json.JSONObject

/**
 * Unified error capture and breadcrumb API (P0-1/P0-2).
 *
 * `captureException` submits a handled exception as `kind = "error"` through
 * the existing feedback channel, with structured exception metadata and the
 * current breadcrumb trail. `addBreadcrumb` records an in-memory ring buffer
 * (max [MAX_BREADCRUMBS]) that is automatically attached to both captured
 * errors and fatal crashes (via [snapshotBreadcrumbs]).
 *
 * Usage:
 * ```kotlin
 * HandsCapture.init(context, baseUrl, appSlug, versionName, versionCode, clientKey = key)
 * HandsCapture.addBreadcrumb("network", "GET /servers 200")
 * try { risky() } catch (e: Exception) { HandsCapture.captureException(e) }
 * ```
 */
object HandsCapture {

    const val MAX_BREADCRUMBS = 100
    private const val MAX_STACKTRACE_CHARS = 50_000

    private val breadcrumbs = CopyOnWriteArrayList<Breadcrumb>()

    @Volatile private var feedback: HandsFeedback? = null

    data class Breadcrumb(
        val timestamp: Long = System.currentTimeMillis(),
        val category: String,
        val message: String,
        val level: String = "info",
        val data: Map<String, Any?> = emptyMap(),
    )

    /**
     * Initialize the capture singleton. Must be called before
     * [captureException]. Safe to call multiple times (last wins).
     */
    fun init(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
    ) {
        feedback = HandsFeedback(
            context = context.applicationContext,
            baseUrl = baseUrl,
            appSlug = appSlug,
            versionName = versionName,
            versionCode = versionCode,
            channel = channel,
            clientKey = clientKey,
        )
    }

    /**
     * Record a breadcrumb. Thread-safe. Oldest entries are evicted when the
     * buffer exceeds [MAX_BREADCRUMBS].
     */
    fun addBreadcrumb(
        category: String,
        message: String,
        level: String = "info",
        data: Map<String, Any?> = emptyMap(),
    ) {
        breadcrumbs.add(Breadcrumb(category = category, message = message, level = level, data = data))
        while (breadcrumbs.size > MAX_BREADCRUMBS) {
            breadcrumbs.removeAt(0)
        }
    }

    /**
     * Capture a handled exception and submit it as `kind = "error"`.
     * Includes the current breadcrumb trail and structured exception metadata.
     *
     * @param throwable the caught exception
     * @param message   optional human-readable context (defaults to exception message)
     * @param tags      optional key-value tags merged into metadata
     * @param extras    optional extra metadata merged into metadata
     * @return ticket id
     */
    suspend fun captureException(
        throwable: Throwable,
        message: String? = null,
        tags: Map<String, String> = emptyMap(),
        extras: Map<String, Any?> = emptyMap(),
    ): String {
        val fb = feedback ?: throw IllegalStateException(
            "HandsCapture.init() must be called before captureException()",
        )

        val exceptionClass = throwable.javaClass.name
        val exceptionMessage = throwable.message ?: exceptionClass
        val stacktrace = stacktraceToString(throwable)
        val topFrame = extractTopAppFrame(throwable)

        val metadata = mutableMapOf<String, Any?>(
            "exception_class" to exceptionClass,
            "exception_message" to exceptionMessage,
            "stacktrace" to stacktrace,
            "top_frame" to topFrame,
            "handled" to true,
            "breadcrumbs" to breadcrumbsToJson(),
        )
        if (tags.isNotEmpty()) {
            metadata["tags"] = JSONObject(tags as Map<*, *>).toString()
        }
        metadata.putAll(extras)

        val ticketMessage = message
            ?: "$exceptionClass: $exceptionMessage"

        return fb.submit(
            message = ticketMessage.take(10_000),
            kind = "error",
            extras = metadata,
        )
    }

    /**
     * Snapshot current breadcrumbs as a JSON array string.
     * Used by [HandsCrash] to attach breadcrumbs to fatal crash reports.
     */
    fun snapshotBreadcrumbs(): String = breadcrumbsToJson()

    /** Clear all breadcrumbs (e.g. on logout / session boundary). */
    fun clearBreadcrumbs() {
        breadcrumbs.clear()
    }

    private fun breadcrumbsToJson(): String {
        val arr = JSONArray()
        for (bc in breadcrumbs) {
            arr.put(
                JSONObject().apply {
                    put("timestamp", bc.timestamp)
                    put("category", bc.category)
                    put("message", bc.message)
                    put("level", bc.level)
                    if (bc.data.isNotEmpty()) {
                        put("data", JSONObject(bc.data as Map<*, *>))
                    }
                },
            )
        }
        return arr.toString()
    }

    private fun stacktraceToString(throwable: Throwable): String {
        val sw = StringWriter()
        throwable.printStackTrace(PrintWriter(sw))
        return sw.toString().take(MAX_STACKTRACE_CHARS)
    }

    /**
     * Extract the topmost application frame for crash grouping signature.
     * Skips android.*, java.*, kotlin.*, kotlinx.* frames.
     */
    private fun extractTopAppFrame(throwable: Throwable): String? {
        val frame = throwable.stackTrace?.firstOrNull { element ->
            val cls = element.className
            !cls.startsWith("android.") &&
                !cls.startsWith("java.") &&
                !cls.startsWith("javax.") &&
                !cls.startsWith("kotlin.") &&
                !cls.startsWith("kotlinx.") &&
                !cls.startsWith("dalvik.") &&
                !cls.startsWith("com.android.")
        } ?: return null
        return "${frame.className}.${frame.methodName}"
    }
}
