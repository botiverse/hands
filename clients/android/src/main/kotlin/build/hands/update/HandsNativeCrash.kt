package build.hands.update

import android.content.Context
import java.io.File

/**
 * NDK crash capture (symbolication matrix, task #80). The native handler
 * writes a minimal async-signal-safe record (.qnc: signal, fault address,
 * raw frame PCs, /proc/self/maps snapshot) at crash time; this class turns
 * records into `crash_native_frames` metadata on the NEXT launch and
 * submits them as kind=crash tickets. The server symbolicates against the
 * build's native-symbols asset.
 */
object HandsNativeCrash {

    private const val MAX_STORED = 5
    private const val MAX_FRAMES = 64

    @JvmStatic
    private external fun nativeInstall(crashDir: String)

    internal fun crashDir(context: Context): File =
        File(context.filesDir, "quiver/native-crashes")

    /** Install the native signal handlers. Safe to call once per process. */
    fun install(context: Context): Boolean {
        return runCatching {
            val dir = crashDir(context)
            dir.mkdirs()
            System.loadLibrary("handscrash")
            nativeInstall(dir.absolutePath)
            true
        }.getOrDefault(false)
    }

    /** Parse + upload pending records; call off the launch critical path. */
    suspend fun uploadPending(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
    ) {
        val dir = crashDir(context)
        val records = (dir.listFiles { f -> f.name.endsWith(".qnc") } ?: emptyArray())
            .sortedBy { it.name }
        if (records.isEmpty()) return
        // Retention: newest survive, same policy as HandsCrash.
        records.dropLast(MAX_STORED).forEach { it.delete() }

        val feedback = HandsFeedback(
            context = context,
            baseUrl = baseUrl,
            appSlug = appSlug,
            versionName = versionName,
            versionCode = versionCode,
            channel = channel,
            clientKey = clientKey,
        )
        for (record in records.takeLast(MAX_STORED)) {
            val parsed = runCatching { parseRecord(record.readText()) }.getOrNull()
            if (parsed == null) {
                record.delete()
                continue
            }
            val framesJson = parsed.frames.joinToString(",", "[", "]") { f ->
                """{"index":${f.index},"offset":"0x${f.offset.toString(16)}","soname":"${f.soname}"}"""
            }
            val top = parsed.frames.firstOrNull()
            val result = runCatching {
                feedback.submit(
                    message = "Native crash: ${parsed.signalName}" +
                        (top?.let { "\nat ${it.soname}+0x${it.offset.toString(16)}" } ?: ""),
                    kind = "crash",
                    attachments = listOf(record),
                    extras = mapOf(
                        "crash_exception_class" to parsed.signalName,
                        "crash_top_frame" to (top?.let { "${it.soname}+0x${it.offset.toString(16)}" } ?: ""),
                        "crash_reason" to "native_signal",
                        "crash_at" to parsed.crashAt.toString(),
                        "crash_native_frames" to framesJson,
                    ),
                )
            }
            if (result.isSuccess) record.delete()
        }
    }

    internal data class NativeFrame(val index: Int, val offset: Long, val soname: String)
    internal data class ParsedRecord(
        val signalName: String,
        val crashAt: Long,
        val frames: List<NativeFrame>,
    )

    private val SIGNAL_NAMES = mapOf(
        4 to "SIGILL", 5 to "SIGTRAP", 6 to "SIGABRT",
        7 to "SIGBUS", 8 to "SIGFPE", 11 to "SIGSEGV",
    )

    private data class MapEntry(
        val start: Long,
        val end: Long,
        val fileOffset: Long,
        val path: String,
    )

    /**
     * .qnc format (written by the signal handler):
     *   QNC1 / "signal N" / "fault_addr 0x…" / "crash_at MS" / "frames" /
     *   one 0x<pc> per line / "maps" / raw /proc/self/maps lines.
     * PC → (soname, offset) uses the maps snapshot from the same process, so
     * ASLR is already accounted for: offset = pc - start + file_offset.
     */
    internal fun parseRecord(text: String): ParsedRecord? {
        val lines = text.lines()
        if (lines.firstOrNull()?.trim() != "QNC1") return null
        var signal = 0
        var crashAt = 0L
        val pcs = mutableListOf<Long>()
        val maps = mutableListOf<MapEntry>()
        var section = "header"
        for (line in lines.drop(1)) {
            val trimmed = line.trim()
            when {
                trimmed == "frames" -> section = "frames"
                trimmed == "maps" -> section = "maps"
                section == "header" && trimmed.startsWith("signal ") ->
                    signal = trimmed.removePrefix("signal ").trim().toIntOrNull() ?: 0
                section == "header" && trimmed.startsWith("crash_at ") ->
                    crashAt = trimmed.removePrefix("crash_at ").trim().toLongOrNull() ?: 0L
                section == "frames" && trimmed.startsWith("0x") ->
                    trimmed.removePrefix("0x").toLongOrNull(16)?.let { pcs.add(it) }
                section == "maps" && trimmed.isNotEmpty() -> parseMapLine(trimmed)?.let { maps.add(it) }
            }
        }
        if (signal == 0 || pcs.isEmpty()) return null
        val frames = pcs.take(MAX_FRAMES).mapIndexedNotNull { index, pc ->
            val map = maps.firstOrNull { pc >= it.start && pc < it.end && it.path.endsWith(".so") }
                ?: return@mapIndexedNotNull null
            NativeFrame(
                index = index,
                offset = pc - map.start + map.fileOffset,
                soname = map.path.substringAfterLast('/'),
            )
        }
        if (frames.isEmpty()) return null
        return ParsedRecord(
            signalName = SIGNAL_NAMES[signal] ?: "SIG$signal",
            crashAt = crashAt,
            frames = frames,
        )
    }

    /** "7f0000-7f1000 r-xp 00042000 fd:00 123  /path/libfoo.so" */
    private fun parseMapLine(line: String): MapEntry? {
        val parts = line.split(Regex("\\s+"))
        if (parts.size < 6) return null
        val range = parts[0].split('-')
        if (range.size != 2 || !parts[1].contains('x')) return null
        return MapEntry(
            start = range[0].toLongOrNull(16) ?: return null,
            end = range[1].toLongOrNull(16) ?: return null,
            fileOffset = parts[2].toLongOrNull(16) ?: return null,
            path = parts.subList(5, parts.size).joinToString(" "),
        )
    }
}
