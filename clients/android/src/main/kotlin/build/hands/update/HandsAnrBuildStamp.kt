package build.hands.update

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

/**
 * Version identity stored in Android's process-state summary, not in the
 * uploading process. The format uses no user data and is bounded by Android's
 * 128-byte limit. A bad or foreign summary must not become a guessed build.
 */
internal object HandsAnrBuildStamp {
    internal const val MAX_BYTES = 128
    private const val HANDS_PREFIX = "hands-build:1\n"
    private const val RAFT_PREFIX = "raft-build:1\n"
    private val CODE = Regex("(?:0|[1-9][0-9]*)")
    private val UNKNOWN = HandsHistoricalBuild(null, null)

    /** Never truncate a name: a prefix could identify a different release. */
    fun encode(build: HandsHistoricalBuild): ByteArray? {
        val code = HandsHistoricalBuildPolicy.versionCodeOrNull(build.versionCode)
        val name = validName(build.versionName)
        val head = "$HANDS_PREFIX${code ?: ""}\n"
        val full = name?.let { utf8(head + it) }
        if (full != null && full.size <= MAX_BYTES) return full
        // Preserve the useful exact code if the name is missing or won't fit.
        return if (code != null) utf8(head) else null
    }

    /**
     * Accept our format and Raft's temporary pre-SDK format. Raft's encoder
     * truncates long names to fit; at 125–128 bytes its name may be truncated,
     * so preserve only the exact code in that ambiguous case.
     */
    fun decode(bytes: ByteArray?): HandsHistoricalBuild {
        if (bytes == null || bytes.size > MAX_BYTES) return UNKNOWN
        val text = runCatching {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        }.getOrNull() ?: return UNKNOWN
        val legacy = text.startsWith(RAFT_PREFIX)
        val prefix = when {
            legacy -> RAFT_PREFIX
            text.startsWith(HANDS_PREFIX) -> HANDS_PREFIX
            else -> return UNKNOWN
        }
        val fields = text.removePrefix(prefix).split('\n')
        if (fields.size != 2) return UNKNOWN
        val rawCode = fields[0]
        val code = if (rawCode.isEmpty()) null else {
            if (!CODE.matches(rawCode)) return UNKNOWN
            HandsHistoricalBuildPolicy.versionCodeOrNull(rawCode.toLongOrNull()) ?: return UNKNOWN
        }
        val rawName = fields[1]
        val name = if (rawName.isEmpty()) null else validName(rawName) ?: return UNKNOWN
        // The original Raft format required both a positive code and a name.
        if (legacy && (code == null || code <= 0 || name == null)) return UNKNOWN
        return HandsHistoricalBuild(
            versionName = if (legacy && bytes.size >= MAX_BYTES - 3) null else name,
            versionCode = code,
        )
    }

    private fun validName(value: String?): String? {
        val name = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (name.any { Character.isISOControl(it) }) return null
        return if (utf8(name) == null) null else name
    }

    private fun utf8(text: String): ByteArray? = runCatching {
        val encoded = Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .encode(CharBuffer.wrap(text))
        ByteArray(encoded.remaining()).also(encoded::get)
    }.getOrNull()
}
