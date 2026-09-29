package build.hands.update

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import java.io.File

/**
 * ANR (Application Not Responding) reporting from the system exit history.
 *
 * An ANR kills the process from outside, so no in-process handler ever runs.
 * Android 11+ (API 30) keeps the kill in [ApplicationExitInfo] with
 * `reason = REASON_ANR` and the ART thread dump in `traceInputStream`. On the
 * next launch [uploadPending] reports every ANR exit not yet reported as a
 * `kind=crash` ticket:
 *
 * - `crash_exception_class = "ANR"` and `crash_top_frame` = the first app
 *   frame of the main thread, so the server groups it as `ANR@<frame>` with
 *   the existing crash signature, counts and version stats;
 * - `crash_type = "anr"` for filtering;
 * - the system trace is the first attachment, so the Android R8 retrace lane
 *   deobfuscates it like a Java crash log.
 *
 * Exactly-once is tracked by a persisted watermark (the newest reported exit
 * timestamp). It only advances after the server accepted the ticket; a failed
 * upload is retried on the next launch. Without a watermark (first launch with
 * this SDK) only ANRs from the last [FIRST_RUN_LOOKBACK_MS] are considered.
 * Below API 30 this is a no-op.
 */
internal object HandsAnr {
    private const val TAG = "HandsAnr"
    private const val PREFS_NAME = "quiver_update"
    private const val KEY_WATERMARK = "hands_anr_reported_until"
    private const val MAX_EXITS_QUERIED = 32
    internal const val MAX_REPORTS_PER_LAUNCH = 3
    internal const val FIRST_RUN_LOOKBACK_MS = 7L * 24 * 60 * 60 * 1000
    private const val MAX_TRACE_BYTES = 2L * 1024 * 1024
    private const val MAX_MAIN_FRAMES = 64

    /** Minimal view of an exit record; lets selection run in JVM unit tests. */
    internal data class AnrExit(
        val pid: Int,
        val timestamp: Long,
        val reason: Int,
    )

    /**
     * Picks the ANR exits to report this launch, oldest first: ANR reason only,
     * strictly newer than [watermark] (or within the first-run lookback when
     * there is none), at most [limit], deduplicated by (pid, timestamp).
     */
    internal fun selectPending(
        exits: List<AnrExit>,
        watermark: Long?,
        now: Long,
        limit: Int = MAX_REPORTS_PER_LAUNCH,
    ): List<AnrExit> {
        val floor = watermark ?: (now - FIRST_RUN_LOOKBACK_MS)
        return exits.asSequence()
            .filter { it.reason == ApplicationExitInfo.REASON_ANR }
            .filter { it.timestamp > floor }
            .distinctBy { it.pid to it.timestamp }
            .sortedBy { it.timestamp }
            .toList()
            // Keep the newest when capped; older ones are skipped for good once
            // the watermark passes them (bounded per-launch network cost).
            .takeLast(limit)
    }

    /** Main-thread Java frames (`at …`) from an ART ANR trace, top first. */
    internal fun mainThreadFrames(trace: String): List<String> {
        val lines = trace.lineSequence().iterator()
        while (lines.hasNext()) {
            val line = lines.next()
            // Thread header: "main" prio=5 tid=1 Native
            if (!line.startsWith("\"main\" ")) continue
            val frames = mutableListOf<String>()
            while (lines.hasNext()) {
                val body = lines.next()
                if (body.isBlank()) break
                val trimmed = body.trim()
                if (trimmed.startsWith("at ")) {
                    frames += trimmed.removePrefix("at ").trim()
                    if (frames.size >= MAX_MAIN_FRAMES) break
                }
            }
            return frames
        }
        return emptyList()
    }

    private val FRAMEWORK_PREFIXES = listOf(
        "android.", "androidx.", "com.android.", "java.", "javax.", "kotlin.",
        "kotlinx.", "dalvik.", "libcore.", "sun.", "jdk.", "com.google.android.",
        "org.json.", "okhttp3.", "okio.",
    )

    /**
     * Grouping frame: the first non-framework frame (the app code that blocked
     * the main thread), else the top frame, else "" (e.g. a trace-less exit).
     */
    internal fun groupingFrame(frames: List<String>): String =
        frames.firstOrNull { frame -> FRAMEWORK_PREFIXES.none { frame.startsWith(it) } }
            ?: frames.firstOrNull()
            ?: ""

    internal fun message(description: String?, frame: String): String = buildString {
        append("ANR")
        description?.trim()?.takeIf(String::isNotEmpty)?.let { append(": ").append(it.take(200)) }
        if (frame.isNotEmpty()) append("\nat ").append(frame)
    }

    /** Report pending ANR exits; call off the main thread. */
    suspend fun uploadPending(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
    ) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        val manager = context.getSystemService(ActivityManager::class.java) ?: return
        val infos = runCatching {
            manager.getHistoricalProcessExitReasons(context.packageName, 0, MAX_EXITS_QUERIED)
        }.getOrElse {
            Log.w(TAG, "Exit history unavailable", it)
            return
        }
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val watermark = if (prefs.contains(KEY_WATERMARK)) prefs.getLong(KEY_WATERMARK, 0L) else null
        val byKey = infos.associateBy { it.pid to it.timestamp }
        val pending = selectPending(
            exits = infos.map { AnrExit(it.pid, it.timestamp, it.reason) },
            watermark = watermark,
            now = System.currentTimeMillis(),
        )
        if (pending.isEmpty()) {
            // Establish the baseline so later launches never look back further.
            if (watermark == null) prefs.edit().putLong(KEY_WATERMARK, System.currentTimeMillis() - FIRST_RUN_LOOKBACK_MS).apply()
            return
        }
        val feedback = HandsFeedback(
            context = context,
            baseUrl = baseUrl,
            appSlug = appSlug,
            versionName = versionName,
            versionCode = versionCode,
            channel = channel,
            clientKey = clientKey,
        )
        val dir = File(context.cacheDir, "hands-anr").apply { mkdirs() }
        for (exit in pending) {
            val info = byKey[exit.pid to exit.timestamp] ?: continue
            val traceFile = File(dir, "anr-${exit.timestamp}-${exit.pid}.txt")
            val traceText = persistTrace(info, traceFile)
            val frames = traceText?.let(::mainThreadFrames).orEmpty()
            val frame = groupingFrame(frames)
            val description = info.description?.take(8_192)?.takeIf(String::isNotBlank)
            val result = runCatching {
                feedback.submit(
                    message = message(description, frame),
                    kind = "crash",
                    attachments = listOfNotNull(traceFile.takeIf { traceText != null }),
                    extras = buildMap {
                        put("crash_type", "anr")
                        put("crash_reason", "anr")
                        put("crash_exception_class", "ANR")
                        put("crash_top_frame", frame)
                        put("crash_thread", "main")
                        put("crash_at", exit.timestamp)
                        put("crash_process_id", exit.pid)
                        put("crash_trace_attached", traceText != null)
                        put("crash_exit_reason", "anr")
                        put("crash_exit_status", info.status)
                        put("crash_exit_importance", info.importance)
                        put("crash_exit_pss", info.pss)
                        put("crash_exit_rss", info.rss)
                        put("crash_exit_timestamp", exit.timestamp)
                        description?.let { put("crash_exit_description", it) }
                    },
                )
            }
            traceFile.delete()
            val error = result.exceptionOrNull()
            if (error != null && !isPermanentRejection(error)) {
                Log.w(TAG, "ANR upload failed; will retry next launch", error)
                return
            }
            if (error != null) {
                // A 4xx other than timeout/rate-limit will never succeed; skip it
                // instead of blocking every later ANR behind it.
                Log.w(TAG, "ANR ${exit.pid}@${exit.timestamp} rejected; skipping", error)
                prefs.edit().putLong(KEY_WATERMARK, exit.timestamp).apply()
                continue
            }
            prefs.edit().putLong(KEY_WATERMARK, exit.timestamp).apply()
            Log.i(TAG, "Uploaded ANR ${exit.pid}@${exit.timestamp} as ticket ${result.getOrNull()}")
        }
    }

    internal fun isPermanentRejection(error: Throwable): Boolean =
        error is HandsFeedbackException && error.code in 400..499 && error.code != 408 && error.code != 429

    private fun persistTrace(info: ApplicationExitInfo, destination: File): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return runCatching {
            val stream = info.traceInputStream ?: return null
            val bytes = stream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                var total = 0L
                while (total < MAX_TRACE_BYTES) {
                    val limit = minOf(buffer.size.toLong(), MAX_TRACE_BYTES - total).toInt()
                    val read = input.read(buffer, 0, limit)
                    if (read < 0) break
                    out.write(buffer, 0, read)
                    total += read
                }
                out.toByteArray()
            }
            if (bytes.isEmpty()) return null
            destination.writeBytes(bytes)
            bytes.toString(Charsets.UTF_8)
        }.getOrElse {
            destination.delete()
            null
        }
    }
}
