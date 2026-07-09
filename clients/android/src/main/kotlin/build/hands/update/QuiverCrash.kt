package build.hands.update

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.app.ActivityManager
import android.content.Context.ACTIVITY_SERVICE
import android.os.Build
import android.os.Debug
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.json.JSONObject

/**
 * Crash capture + deferred reporting (Bugly-style store-then-send).
 *
 * On crash: chain into any existing default handler, write a structured
 * crash log to `<externalFilesDir>/crashes/` (with an internal-files
 * fallback), write a metadata sidecar for later upload, and optionally copy
 * the log to the clipboard. No network happens in the dying process.
 *
 * On the next launch, [install] schedules [uploadPending] on a background
 * thread: each stored crash is submitted through the Quiver feedback channel
 * (`kind=crash`, full log attached, signature fields in metadata) and the
 * local files are removed on success. At most [MAX_STORED_CRASHES] recent
 * crashes are kept.
 *
 * This replaces the app-side SlockCrashReporter; app-specific context (e.g.
 * recent diagnostics) is injected via [extraContext].
 */
object QuiverCrash {
    private const val TAG = "QuiverCrash"
    private const val CRASH_LOG_MAX_CHARS = 180_000
    private const val MAX_STORED_CRASHES = 5
    private val installed = AtomicBoolean(false)
    private val processStartMs = System.currentTimeMillis()

    fun install(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
        copyToClipboard: Boolean = true,
        uploadOnLaunch: Boolean = true,
        captureNativeCrashes: Boolean = true,
        reportDeviceAnalytics: Boolean = true,
        extraContext: (() -> String)? = null,
    ) {
        if (captureNativeCrashes) {
            QuiverNativeCrash.install(context.applicationContext)
        }
        if (!installed.compareAndSet(false, true)) return
        val appContext = context.applicationContext
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            val crashLog =
                runCatching { buildCrashLog(appContext, thread, throwable, extraContext) }
                    .getOrElse { buildFallbackCrashLog(thread, throwable, it) }
                    .take(CRASH_LOG_MAX_CHARS)

            runCatching { writeCrash(appContext, thread, throwable, crashLog) }
                .onFailure { Log.e(TAG, "Failed to write crash log", it) }
            if (copyToClipboard) {
                runCatching {
                    val clipboard =
                        appContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("Crash log", crashLog))
                }
                    .onSuccess { Log.e(TAG, "Crash log copied to clipboard") }
                    .onFailure { Log.e(TAG, "Failed to copy crash log to clipboard", it) }
            }

            defaultHandler?.uncaughtException(thread, throwable)
                ?: run {
                    Log.e(TAG, "Unhandled crash", throwable)
                    kotlin.system.exitProcess(2)
                }
        }

        if (uploadOnLaunch || reportDeviceAnalytics) {
            thread(name = "quiver-crash-upload", isDaemon = true) {
                if (reportDeviceAnalytics) {
                    runCatching {
                        kotlinx.coroutines.runBlocking {
                            QuiverAnalytics.reportDevice(
                                appContext, baseUrl, appSlug, versionName, versionCode, channel, clientKey,
                            )
                        }
                    }
                }
                if (uploadOnLaunch) runCatching {
                    uploadPending(appContext, baseUrl, appSlug, versionName, versionCode, channel, clientKey)
                    if (captureNativeCrashes) {
                        // Dedicated background thread — blocking here is fine.
                        runCatching {
                            kotlinx.coroutines.runBlocking {
                                QuiverNativeCrash.uploadPending(
                                    appContext, baseUrl, appSlug, versionName, versionCode, channel, clientKey,
                                )
                            }
                        }
                    }
                }
                    .onFailure { Log.w(TAG, "Crash upload pass failed", it) }
            }
        }
    }

    /**
     * Upload stored crashes through the feedback channel and delete them on
     * success. Safe to call repeatedly; runs synchronously on the calling
     * thread.
     */
    fun uploadPending(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
    ) {
        val dir = crashDir(context) ?: return
        val sidecars =
            dir.listFiles { f -> f.name.endsWith(".meta.json") }?.sortedBy { it.name } ?: return
        if (sidecars.isEmpty()) return
        val feedback =
            QuiverFeedback(
                context = context,
                baseUrl = baseUrl,
                appSlug = appSlug,
                versionName = versionName,
                versionCode = versionCode,
                channel = channel,
                clientKey = clientKey,
            )
        for (sidecar in sidecars) {
            val logFile = File(sidecar.absolutePath.removeSuffix(".meta.json") + ".txt")
            if (!logFile.isFile) {
                sidecar.delete()
                continue
            }
            val meta = runCatching { JSONObject(sidecar.readText()) }.getOrNull() ?: JSONObject()
            val exceptionClass = meta.optString("exception_class", "UnknownException")
            val topFrame = meta.optString("top_frame", "")
            val message =
                buildString {
                    append("Crash: ").append(exceptionClass)
                    val detail = meta.optString("exception_message", "")
                    if (detail.isNotBlank()) append(": ").append(detail.take(200))
                    if (topFrame.isNotBlank()) append("\nat ").append(topFrame)
                }
            val result =
                runCatching {
                    runBlocking {
                        feedback.submit(
                            message = message,
                            kind = "crash",
                            attachments = listOf(logFile),
                            extras =
                                mapOf(
                                    "crash_exception_class" to exceptionClass,
                                    "crash_top_frame" to topFrame,
                                    "crash_thread" to meta.optString("thread", ""),
                                    "crash_at" to meta.optLong("crash_at", 0L),
                                    "crash_process_uptime_ms" to meta.optLong("process_uptime_ms", -1L),
                                ),
                        )
                    }
                }
            if (result.isSuccess) {
                logFile.delete()
                sidecar.delete()
                Log.i(TAG, "Uploaded crash ${logFile.name} as ticket ${result.getOrNull()}")
            } else {
                Log.w(TAG, "Crash upload failed for ${logFile.name}", result.exceptionOrNull())
            }
        }
    }

    private fun crashDir(context: Context): File? {
        val dir =
            context.getExternalFilesDir(null)?.resolve("crashes")
                ?: context.filesDir?.resolve("crashes")
                ?: return null
        dir.mkdirs()
        return dir
    }

    private fun writeCrash(
        context: Context,
        thread: Thread,
        throwable: Throwable,
        crashLog: String,
    ) {
        val dir = crashDir(context) ?: return
        // Cap retention: keep the newest MAX_STORED_CRASHES - 1 before adding.
        val existing =
            dir.listFiles { f -> f.name.startsWith("crash-") && f.name.endsWith(".txt") }
                ?.sortedByDescending { it.name } ?: emptyList()
        for (old in existing.drop(MAX_STORED_CRASHES - 1)) {
            old.delete()
            File(old.absolutePath.removeSuffix(".txt") + ".meta.json").delete()
        }
        val timestamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val base = dir.resolve("crash-$timestamp")
        File("${base.absolutePath}.txt").writeText(crashLog)
        val topFrame =
            throwable.stackTrace.firstOrNull()?.let { "${it.className}.${it.methodName}(${it.fileName}:${it.lineNumber})" }
                ?: ""
        val meta =
            JSONObject()
                .put("exception_class", throwable.javaClass.name)
                .put("exception_message", throwable.message ?: "")
                .put("top_frame", topFrame)
                .put("thread", thread.name)
                .put("crash_at", System.currentTimeMillis())
                .put("process_uptime_ms", System.currentTimeMillis() - processStartMs)
        File("${base.absolutePath}.meta.json").writeText(meta.toString())
        Log.e(TAG, "Crash log written to: ${base.absolutePath}.txt")
    }

    private fun buildCrashLog(
        context: Context,
        thread: Thread,
        throwable: Throwable,
        extraContext: (() -> String)?,
    ): String =
        buildString {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            appendLine("Crash log")
            appendLine("Crash at: ${Date()}")
            appendLine("Package: ${context.packageName}")
            appendLine("Version name: ${packageInfo.versionName.orEmpty()}")
            appendLine(
                "Version code: " +
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        packageInfo.longVersionCode.toString()
                    } else {
                        @Suppress("DEPRECATION") packageInfo.versionCode.toString()
                    },
            )
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}".trim())
            appendLine("Android: ${Build.VERSION.RELEASE} / SDK ${Build.VERSION.SDK_INT}")
            appendLine("Device id: ${QuiverDeviceId.get(context)}")
            appendLine("Thread: ${thread.name}")
            appendLine("Exception: ${throwable.javaClass.name}")
            appendLine("Message: ${throwable.message.orEmpty()}")
            appendLine()
            appendLine("Stack trace:")
            appendLine(Log.getStackTraceString(throwable))
            appendLine()
            appendLine("Process uptime: ${System.currentTimeMillis() - processStartMs} ms")
            appendLine()
            appendLine("Process info:")
            appendProcessInfo(context)
            appendLine()
            appendLine("Open file descriptors:")
            appendFdInfo()
            appendLine()
            appendLine("Recent logcat:")
            appendLogcatTail()
            appendLine()
            appendLine("All threads:")
            runCatching {
                for ((t, frames) in Thread.getAllStackTraces()) {
                    if (t === thread) continue
                    appendLine("  Thread ${t.name} (${t.state}):")
                    frames.take(24).forEach { frame -> appendLine("    at $frame") }
                }
            }
            extraContext?.let { provider ->
                runCatching {
                    val extra = provider()
                    if (extra.isNotBlank()) {
                        appendLine()
                        appendLine("App context:")
                        appendLine(extra)
                    }
                }
            }
        }

    /** Memory/thread/foreground snapshot — the "scene data" tab equivalent. */
    private fun StringBuilder.appendProcessInfo(context: Context) {
        runCatching {
            val runtime = Runtime.getRuntime()
            appendLine("  JVM heap: used ${(runtime.totalMemory() - runtime.freeMemory()) / 1048576} MB / " +
                "max ${runtime.maxMemory() / 1048576} MB")
            val mi = Debug.MemoryInfo()
            Debug.getMemoryInfo(mi)
            appendLine("  Native PSS: ${mi.nativePss / 1024} MB · Dalvik PSS: ${mi.dalvikPss / 1024} MB · " +
                "Total PSS: ${mi.totalPss / 1024} MB")
            val am = context.getSystemService(ACTIVITY_SERVICE) as? ActivityManager
            if (am != null) {
                val sys = ActivityManager.MemoryInfo()
                am.getMemoryInfo(sys)
                appendLine("  System RAM: avail ${sys.availMem / 1048576} MB / total ${sys.totalMem / 1048576} MB" +
                    if (sys.lowMemory) " (LOW MEMORY)" else "")
            }
            appendLine("  Active threads: ${Thread.activeCount()}")
        }.onFailure { appendLine("  (unavailable: ${it.javaClass.simpleName})") }
    }

    /** Open file descriptor count + a bounded sample of their targets. */
    private fun StringBuilder.appendFdInfo() {
        runCatching {
            val fdDir = File("/proc/self/fd")
            val fds = fdDir.listFiles()
            if (fds == null) {
                appendLine("  (unavailable)")
                return
            }
            appendLine("  Count: ${fds.size}")
            fds.sortedBy { it.name.toIntOrNull() ?: Int.MAX_VALUE }.take(40).forEach { fd ->
                val target = runCatching { fd.canonicalPath }.getOrDefault("?")
                appendLine("  ${fd.name} -> $target")
            }
            if (fds.size > 40) appendLine("  … ${fds.size - 40} more")
        }.onFailure { appendLine("  (unavailable: ${it.javaClass.simpleName})") }
    }

    /** Tail of this process's logcat (own-process only on modern Android). */
    private fun StringBuilder.appendLogcatTail() {
        runCatching {
            val process = ProcessBuilder("logcat", "-d", "-v", "time", "-t", "200")
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            process.waitFor()
            val trimmed = if (output.length > 20_000) output.takeLast(20_000) else output
            appendLine(if (trimmed.isBlank()) "  (empty)" else trimmed.trimEnd())
        }.onFailure { appendLine("  (unavailable: ${it.javaClass.simpleName})") }
    }

    private fun buildFallbackCrashLog(
        thread: Thread,
        throwable: Throwable,
        buildError: Throwable,
    ): String =
        buildString {
            appendLine("Crash log")
            appendLine("Crash at: ${Date()}")
            appendLine("Thread: ${thread.name}")
            appendLine("Exception: ${throwable.javaClass.name}")
            appendLine("Message: ${throwable.message.orEmpty()}")
            appendLine()
            appendLine("Stack trace:")
            appendLine(Log.getStackTraceString(throwable))
            appendLine()
            appendLine("Crash log build error:")
            appendLine(Log.getStackTraceString(buildError))
        }
}
