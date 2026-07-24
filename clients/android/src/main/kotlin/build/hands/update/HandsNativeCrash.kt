package build.hands.update

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.math.abs

/**
 * NDK crash capture and next-launch upload.
 *
 * QNC2 records the kernel-provided crash-thread ucontext (PC/LR/SP + registers),
 * thread identity, siginfo, loaded-image ELF BuildIds, and /proc/self/maps. This
 * parser turns context PCs into `(soname, offset, build_id)` frames; the server
 * refuses to symbolicate any frame whose BuildId cannot be verified exactly.
 *
 * QNC1 remains readable so already-stored crashes are not discarded, but those
 * legacy frames have no BuildId and therefore fail closed at symbolication.
 */
object HandsNativeCrash {

    private const val MAX_STORED = 5
    private const val MAX_FRAMES = 64
    private const val MAX_IMAGES_IN_METADATA = 64
    // ApplicationExitInfo.timestamp is millisecond precision; QNC2 uses
    // CLOCK_REALTIME millisecond timestamps. Five seconds covers scheduling
    // delay without admitting unrelated exits from the same crash loop.
    private const val EXIT_MATCH_WINDOW_MS = 5_000L
    private const val MAX_EXIT_TRACE_BYTES = 2 * 1024 * 1024L

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
        records.dropLast(MAX_STORED).forEach {
            it.delete()
            deleteExitSidecars(it)
        }

        val pending = records.takeLast(MAX_STORED).mapNotNull { record ->
            val parsed = runCatching { parseRecord(record.readText()) }.getOrNull()
            if (parsed == null) {
                record.delete()
                deleteExitSidecars(record)
                null
            } else {
                PendingRecord(record, parsed)
            }
        }
        if (pending.isEmpty()) return

        // Reuse only a sidecar whose recorded QNC coordinates still match.
        // Valid bindings also reserve the system exit identity so another QNC
        // cannot claim the same retained tombstone on this or a later retry.
        val storedByRecord = pending.mapNotNull { item ->
            readStoredExitEvidence(item.record, item.parsed)?.let { item.record.name to it }
        }.toMap().toMutableMap()
        val claimedExitKeys = storedByRecord.values.mapTo(mutableSetOf()) { it.exitKey }
        val liveExits = loadNativeExitEvidence(context)
        val liveByKey = liveExits.associateBy { it.match.exitKey }
        val assignments = assignExitCandidates(
            records = pending
                .filterNot { storedByRecord.containsKey(it.record.name) }
                .map { ExitMatchRecord(it.record.name, it.parsed.pid, it.parsed.crashAt) },
            candidates = liveExits.map { it.match },
            claimedExitKeys = claimedExitKeys,
        )
        for ((recordName, match) in assignments) {
            val item = pending.firstOrNull { it.record.name == recordName } ?: continue
            val live = liveByKey[match.exitKey] ?: continue
            val stored = StoredExitEvidence.from(item.parsed, live.info)
            if (writeStoredExitEvidence(item.record, stored)) {
                storedByRecord[recordName] = stored
                claimedExitKeys += stored.exitKey
                persistExitTrace(live.info, exitTraceFile(item.record))
            }
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
        for ((record, parsed) in pending) {
            val exitEvidence = storedByRecord[record.name]
            val trace = exitEvidence?.let {
                exitTraceFile(record).takeIf { file -> file.isFile && file.length() > 0L }
            }
            val attachments = buildList {
                add(record)
                if (trace != null) add(trace)
            }
            val top = parsed.frames.firstOrNull()
            val result = runCatching {
                feedback.submit(
                    message = buildString {
                        append("Native crash: ").append(parsed.signalName)
                        parsed.threadName?.let { append(" on thread ").append(it) }
                        top?.let { append("\nat ").append(it.soname).append("+0x").append(it.offset.toString(16)) }
                    },
                    kind = "crash",
                    attachments = attachments,
                    extras = buildMap {
                        put("crash_exception_class", parsed.signalName)
                        put("crash_top_frame", top?.let { "${it.soname}+0x${it.offset.toString(16)}" } ?: "")
                        put("crash_reason", "native_signal")
                        put("crash_at", parsed.crashAt.toString())
                        put("crash_native_format", parsed.format)
                        put("crash_native_frames", framesJson(parsed.frames))
                        put("crash_native_images", imagesJson(parsed.modules))
                        put("crash_registers", JSONObject(parsed.registers).toString())
                        parsed.arch?.let { put("crash_arch", it) }
                        parsed.signalCode?.let { put("crash_signal_code", it) }
                        parsed.faultAddress?.let { put("crash_fault_addr", "0x${it.toString(16)}") }
                        parsed.pid?.let { put("crash_process_id", it) }
                        parsed.tid?.let { put("crash_thread_id", it) }
                        parsed.threadName?.let { put("crash_thread_name", it) }
                        parsed.registers["pc"]?.let { put("crash_context_pc", it) }
                        (parsed.registers["lr"] ?: parsed.registers["x30"])
                            ?.let { put("crash_context_lr", it) }
                        (parsed.registers["sp"] ?: parsed.registers["rsp"])
                            ?.let { put("crash_context_sp", it) }
                        put("crash_tombstone_attached", trace != null)
                        exitEvidence?.let {
                            put("crash_exit_reason", exitReasonName(it.reason))
                            put("crash_exit_status", it.status)
                            put("crash_exit_importance", it.importance)
                            put("crash_exit_pss", it.pss)
                            put("crash_exit_rss", it.rss)
                            put("crash_exit_timestamp", it.timestamp)
                            it.description?.takeIf(String::isNotBlank)
                                ?.let { description -> put("crash_exit_description", description) }
                        }
                    },
                )
            }
            if (result.isSuccess) {
                record.delete()
                deleteExitSidecars(record)
            }
        }
    }

    internal data class NativeFrame(
        val index: Int,
        val offset: Long,
        val soname: String,
        val buildId: String? = null,
        val source: String? = null,
    )

    internal data class NativeModule(
        val start: Long,
        val end: Long,
        val buildId: String?,
        val path: String,
    )

    internal data class ParsedRecord(
        val format: String,
        val signalName: String,
        val signalCode: Int?,
        val faultAddress: Long?,
        val crashAt: Long,
        val pid: Long?,
        val tid: Long?,
        val threadName: String?,
        val arch: String?,
        val registers: Map<String, String>,
        val modules: List<NativeModule>,
        val frames: List<NativeFrame>,
    )

    private data class PendingRecord(val record: File, val parsed: ParsedRecord)

    internal data class ExitMatchRecord(
        val id: String,
        val pid: Long?,
        val crashAt: Long,
    )

    internal data class ExitMatchCandidate(
        val pid: Long,
        val timestamp: Long,
        val reason: Int,
    ) {
        val exitKey: String get() = "$pid:$timestamp:$reason"
    }

    internal data class StoredExitEvidence(
        val recordPid: Long,
        val recordCrashAt: Long,
        val exitPid: Long,
        val timestamp: Long,
        val reason: Int,
        val status: Int,
        val importance: Int,
        val pss: Long,
        val rss: Long,
        val description: String?,
    ) {
        val exitKey: String get() = "$exitPid:$timestamp:$reason"

        fun matches(record: ParsedRecord): Boolean =
            record.format == "QNC2" && record.pid == recordPid && record.crashAt == recordCrashAt &&
                exitPid == recordPid && reason == ApplicationExitInfo.REASON_CRASH_NATIVE

        companion object {
            fun from(record: ParsedRecord, info: ApplicationExitInfo): StoredExitEvidence =
                StoredExitEvidence(
                    recordPid = requireNotNull(record.pid),
                    recordCrashAt = record.crashAt,
                    exitPid = info.pid.toLong(),
                    timestamp = info.timestamp,
                    reason = info.reason,
                    status = info.status,
                    importance = info.importance,
                    pss = info.pss,
                    rss = info.rss,
                    description = info.description?.take(8_192)?.takeIf(String::isNotBlank),
                )
        }
    }

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
     * QNC1: signal/fault/crash_at + handler unwind PCs + maps.
     * QNC2: adds siginfo, pid/tid/name, arch, crash ucontext registers, context
     * PC/LR frames, and a loaded-module BuildId snapshot before maps.
     */
    internal fun parseRecord(text: String): ParsedRecord? {
        val lines = text.lines()
        val format = lines.firstOrNull()?.trim().orEmpty()
        if (format != "QNC1" && format != "QNC2") return null
        var signal = 0
        var signalCode: Int? = null
        var faultAddress: Long? = null
        var crashAt = 0L
        var pid: Long? = null
        var tid: Long? = null
        var threadName: String? = null
        var arch: String? = null
        val contextFrames = mutableListOf<Pair<Long, String?>>()
        val maps = mutableListOf<MapEntry>()
        val modules = mutableListOf<NativeModule>()
        val registers = linkedMapOf<String, String>()
        var section = "header"
        for (line in lines.drop(1)) {
            val trimmed = line.trim()
            when {
                trimmed == "registers" -> section = "registers"
                trimmed == "frames" -> section = "frames"
                trimmed == "modules" -> section = "modules"
                trimmed == "maps" -> section = "maps"
                section == "header" && trimmed.startsWith("signal ") ->
                    signal = trimmed.removePrefix("signal ").trim().toIntOrNull() ?: 0
                section == "header" && trimmed.startsWith("signal_code ") ->
                    signalCode = trimmed.removePrefix("signal_code ").trim().toIntOrNull()
                section == "header" && trimmed.startsWith("fault_addr ") ->
                    faultAddress = parseHexLong(trimmed.removePrefix("fault_addr "))
                section == "header" && trimmed.startsWith("crash_at ") ->
                    crashAt = trimmed.removePrefix("crash_at ").trim().toLongOrNull() ?: 0L
                section == "header" && trimmed.startsWith("pid ") ->
                    pid = trimmed.removePrefix("pid ").trim().toLongOrNull()
                section == "header" && trimmed.startsWith("tid ") ->
                    tid = trimmed.removePrefix("tid ").trim().toLongOrNull()
                section == "header" && trimmed.startsWith("thread_name_hex ") ->
                    threadName = decodeHexUtf8(trimmed.removePrefix("thread_name_hex ").trim())
                section == "registers" && trimmed.startsWith("arch ") ->
                    arch = trimmed.removePrefix("arch ").trim().takeIf(String::isNotBlank)
                section == "registers" -> parseRegister(trimmed)?.let { (name, value) ->
                    registers[name] = value
                }
                section == "frames" && trimmed.startsWith("0x") -> {
                    val parts = trimmed.split(Regex("\\s+"), limit = 2)
                    parseHexLong(parts[0])?.let { pc ->
                        contextFrames += pc to parts.getOrNull(1)?.takeIf(String::isNotBlank)
                    }
                }
                section == "modules" && trimmed.isNotEmpty() ->
                    parseModuleLine(trimmed)?.let(modules::add)
                section == "maps" && trimmed.isNotEmpty() ->
                    parseMapLine(trimmed)?.let(maps::add)
            }
        }
        if (signal == 0 || contextFrames.isEmpty()) return null
        val frames = contextFrames.distinctBy { it.first }.take(MAX_FRAMES).mapIndexedNotNull { index, pair ->
            val (pc, source) = pair
            val map = maps.firstOrNull { pc >= it.start && pc < it.end && it.path.contains(".so") }
                ?: return@mapIndexedNotNull null
            val module = modules.firstOrNull { pc >= it.start && pc < it.end }
            NativeFrame(
                index = index,
                offset = pc - map.start + map.fileOffset,
                soname = map.path.substringAfterLast('/'),
                buildId = module?.buildId,
                source = source,
            )
        }
        if (frames.isEmpty()) return null
        return ParsedRecord(
            format = format,
            signalName = SIGNAL_NAMES[signal] ?: "SIG$signal",
            signalCode = signalCode,
            faultAddress = faultAddress,
            crashAt = crashAt,
            pid = pid,
            tid = tid,
            threadName = threadName,
            arch = arch,
            registers = registers,
            modules = modules,
            frames = frames,
        )
    }

    /** "7f0000-7f1000 r-xp 00042000 fd:00 123 /path/libfoo.so" */
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

    /** "0x700000-0x710000 deadbeef /path/libfoo.so" */
    private fun parseModuleLine(line: String): NativeModule? {
        val parts = line.split(Regex("\\s+"), limit = 3)
        if (parts.size != 3) return null
        val range = parts[0].split('-')
        if (range.size != 2) return null
        val buildId = parts[1].lowercase().takeIf { it.matches(Regex("[0-9a-f]{8,64}")) }
        return NativeModule(
            start = parseHexLong(range[0]) ?: return null,
            end = parseHexLong(range[1]) ?: return null,
            buildId = buildId,
            path = parts[2],
        )
    }

    private fun parseRegister(line: String): Pair<String, String>? {
        val parts = line.split(Regex("\\s+"), limit = 2)
        if (parts.size != 2 || !parts[0].matches(Regex("[A-Za-z][A-Za-z0-9_]{0,15}"))) return null
        val value = parts[1].lowercase()
        if (!value.matches(Regex("0x[0-9a-f]{1,16}"))) return null
        return parts[0] to value
    }

    private fun parseHexLong(value: String): Long? =
        value.trim().removePrefix("0x").toLongOrNull(16)

    private fun encodeUtf8Hex(value: String): String = buildString {
        val digits = "0123456789abcdef"
        value.toByteArray(Charsets.UTF_8).forEach { byte ->
            val unsigned = byte.toInt() and 0xff
            append(digits[unsigned ushr 4])
            append(digits[unsigned and 0x0f])
        }
    }

    private fun decodeUtf8Hex(value: String, maxBytes: Int): String? {
        if (
            value.length !in 2..(maxBytes * 2) || value.length % 2 != 0 ||
            !value.matches(Regex("[0-9a-fA-F]+"))
        ) {
            return null
        }
        val bytes = ByteArray(value.length / 2) { index ->
            value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return bytes.toString(Charsets.UTF_8)
    }

    private fun decodeHexUtf8(value: String): String? =
        decodeUtf8Hex(value, 64)?.replace(Regex("[\\r\\n\\u0000]"), " ")?.trim()
            ?.takeIf(String::isNotBlank)

    private fun framesJson(frames: List<NativeFrame>): String = JSONArray().apply {
        frames.forEach { frame ->
            put(JSONObject().apply {
                put("index", frame.index)
                put("offset", "0x${frame.offset.toString(16)}")
                put("soname", frame.soname)
                frame.buildId?.let { put("build_id", it) }
                frame.source?.let { put("source", it) }
            })
        }
    }.toString()

    private fun imagesJson(modules: List<NativeModule>): String = JSONArray().apply {
        modules.asSequence()
            .filter { it.buildId != null && it.path.contains(".so") }
            .distinctBy { it.buildId to it.path.substringAfterLast('/') }
            .take(MAX_IMAGES_IN_METADATA)
            .forEach { module ->
                put(JSONObject().apply {
                    put("soname", module.path.substringAfterLast('/'))
                    put("build_id", module.buildId)
                    put("start", "0x${module.start.toString(16)}")
                    put("end", "0x${module.end.toString(16)}")
                })
            }
    }.toString()

    private data class LiveExitEvidence(
        val info: ApplicationExitInfo,
        val match: ExitMatchCandidate,
    )

    /**
     * Deterministically assigns retained native exits one-to-one to QNC2
     * records. Cross-process exits, ANRs/JVM exits, stale timestamps, and exits
     * already claimed by a persisted retry sidecar are ineligible.
     */
    internal fun assignExitCandidates(
        records: List<ExitMatchRecord>,
        candidates: List<ExitMatchCandidate>,
        claimedExitKeys: Set<String> = emptySet(),
        windowMs: Long = EXIT_MATCH_WINDOW_MS,
    ): Map<String, ExitMatchCandidate> {
        val available = candidates
            .filter { it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE }
            .filterNot { it.exitKey in claimedExitKeys }
            .distinctBy { it.exitKey }
            .toMutableList()
        val assigned = linkedMapOf<String, ExitMatchCandidate>()
        for (record in records.sortedWith(compareBy<ExitMatchRecord> { it.crashAt }.thenBy { it.id })) {
            val pid = record.pid ?: continue
            if (record.crashAt <= 0L) continue
            val candidate = available
                .asSequence()
                .filter { it.pid == pid && abs(it.timestamp - record.crashAt) <= windowMs }
                .sortedWith(
                    compareBy<ExitMatchCandidate> { abs(it.timestamp - record.crashAt) }
                        .thenBy { it.timestamp }
                        .thenBy { it.exitKey },
                )
                .firstOrNull() ?: continue
            assigned[record.id] = candidate
            available.remove(candidate)
        }
        return assigned
    }

    private fun loadNativeExitEvidence(context: Context): List<LiveExitEvidence> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
        return runCatching {
            val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
            manager.getHistoricalProcessExitReasons(context.packageName, 0, 32)
                .asSequence()
                .filter { it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE }
                .map {
                    LiveExitEvidence(
                        info = it,
                        match = ExitMatchCandidate(
                            pid = it.pid.toLong(),
                            timestamp = it.timestamp,
                            reason = it.reason,
                        ),
                    )
                }
                .toList()
        }.getOrDefault(emptyList())
    }

    private fun exitReasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "crash_native"
        ApplicationExitInfo.REASON_CRASH -> "crash"
        ApplicationExitInfo.REASON_ANR -> "anr"
        else -> "reason_$reason"
    }

    private fun exitTraceFile(record: File): File =
        File(record.parentFile, "${record.nameWithoutExtension}.exit-trace.txt")

    private fun exitMetaFile(record: File): File =
        File(record.parentFile, "${record.nameWithoutExtension}.exit-meta")

    private fun deleteExitSidecars(record: File) {
        exitTraceFile(record).delete()
        exitMetaFile(record).delete()
    }

    private fun readStoredExitEvidence(record: File, parsed: ParsedRecord): StoredExitEvidence? {
        val meta = exitMetaFile(record)
        if (!meta.isFile) {
            // A trace without its binding coordinates is not causal evidence.
            exitTraceFile(record).delete()
            return null
        }
        val stored = runCatching { decodeStoredExitEvidence(meta.readText()) }.getOrNull()
        if (stored == null || !stored.matches(parsed)) {
            deleteExitSidecars(record)
            return null
        }
        return stored
    }

    private fun writeStoredExitEvidence(record: File, evidence: StoredExitEvidence): Boolean =
        runCatching {
            exitMetaFile(record).writeText(encodeStoredExitEvidence(evidence))
            true
        }.getOrElse {
            deleteExitSidecars(record)
            false
        }

    internal fun encodeStoredExitEvidence(evidence: StoredExitEvidence): String = buildString {
        appendLine("QNE1")
        appendLine("record_pid ${evidence.recordPid}")
        appendLine("record_crash_at ${evidence.recordCrashAt}")
        appendLine("exit_pid ${evidence.exitPid}")
        appendLine("exit_timestamp ${evidence.timestamp}")
        appendLine("exit_reason ${evidence.reason}")
        appendLine("exit_status ${evidence.status}")
        appendLine("exit_importance ${evidence.importance}")
        appendLine("exit_pss ${evidence.pss}")
        appendLine("exit_rss ${evidence.rss}")
        evidence.description?.let { appendLine("description_hex ${encodeUtf8Hex(it)}") }
    }

    internal fun decodeStoredExitEvidence(text: String): StoredExitEvidence? {
        val lines = text.lineSequence().toList()
        if (lines.firstOrNull()?.trim() != "QNE1") return null
        val fields = lines.drop(1).mapNotNull { line ->
            val separator = line.indexOf(' ')
            if (separator <= 0) null else line.substring(0, separator) to line.substring(separator + 1).trim()
        }.toMap()
        return StoredExitEvidence(
            recordPid = fields["record_pid"]?.toLongOrNull() ?: return null,
            recordCrashAt = fields["record_crash_at"]?.toLongOrNull() ?: return null,
            exitPid = fields["exit_pid"]?.toLongOrNull() ?: return null,
            timestamp = fields["exit_timestamp"]?.toLongOrNull() ?: return null,
            reason = fields["exit_reason"]?.toIntOrNull() ?: return null,
            status = fields["exit_status"]?.toIntOrNull() ?: return null,
            importance = fields["exit_importance"]?.toIntOrNull() ?: return null,
            pss = fields["exit_pss"]?.toLongOrNull() ?: return null,
            rss = fields["exit_rss"]?.toLongOrNull() ?: return null,
            description = fields["description_hex"]?.let { decodeUtf8Hex(it, 8_192) ?: return null },
        )
    }

    private fun persistExitTrace(info: ApplicationExitInfo, destination: File): File? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return runCatching {
            val stream = info.traceInputStream ?: return null
            destination.outputStream().buffered().use { output ->
                stream.use { input ->
                    val buffer = ByteArray(8192)
                    var total = 0L
                    while (total < MAX_EXIT_TRACE_BYTES) {
                        val limit = minOf(buffer.size.toLong(), MAX_EXIT_TRACE_BYTES - total).toInt()
                        val read = input.read(buffer, 0, limit)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        total += read
                    }
                }
            }
            destination.takeIf { it.isFile && it.length() > 0L }
        }.getOrElse {
            destination.delete()
            null
        }
    }
}
