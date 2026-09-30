package build.hands.update

/**
 * Build identity for a crash uploaded by a later process.
 *
 * The uploading install is intentionally not an input. A stored sidecar key
 * is explicit, including an empty name or a null code. An older sidecar with
 * neither key is recovered from its log. Otherwise the ticket build stays
 * empty, so symbolication cannot attach the wrong package.
 */
internal data class HandsHistoricalBuild(
    val versionName: String?,
    val versionCode: Long?,
)

internal object HandsHistoricalBuildPolicy {
    private const val MAX_SAFE_INTEGER = 9007199254740991L

    /** Version lines written into a Java crash log. Empty values stay on their own line. */
    fun crashLogVersionLines(build: HandsHistoricalBuild): String = buildString {
        append("Version name: ")
        append(build.versionName.orEmpty())
        append('\n')
        append("Version code: ")
        append(build.versionCode?.toString().orEmpty())
        append('\n')
    }

    fun fromLog(text: String): HandsHistoricalBuild {
        val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
        return ticket(
            name = firstMatch(normalized, HEADER_NAME, REPORTED_NAME, BUNDLE_NAME),
            code = firstCode(normalized, HEADER_CODE, REPORTED_CODE),
        )
    }

    /**
     * Recorded keys win as a pair: if either key was stored, the missing one
     * stays missing. Only a sidecar with neither key is recovered from [logText].
     */
    fun resolve(
        versionNamePresent: Boolean,
        versionName: String?,
        versionCodePresent: Boolean,
        versionCode: Long?,
        logText: String,
    ): HandsHistoricalBuild {
        if (!versionNamePresent && !versionCodePresent) {
            return fromLog(logText)
        }
        val name = if (versionNamePresent) versionName?.trim().orEmpty() else ""
        val code = if (versionCodePresent) versionCode?.takeIf(::isReportableCode) else null
        return ticket(name, code)
    }

    /** Metadata fields for one historical ticket. Absent fields are omitted, never backfilled. */
    fun versionExtras(build: HandsHistoricalBuild): Map<String, Any> = buildMap {
        build.versionName?.let { put("version_name", it) }
        build.versionCode?.let { put("version_code", it) }
    }

    fun versionCodeOrNull(value: Any?): Long? {
        val number = value as? Number ?: return null
        val asLong = when (number) {
            is Long -> number
            is Int, is Short, is Byte -> number.toLong()
            else -> {
                val doubleValue = number.toDouble()
                if (!doubleValue.isFinite() || doubleValue % 1.0 != 0.0) return null
                if (doubleValue < 0.0 || doubleValue > MAX_SAFE_INTEGER.toDouble()) return null
                doubleValue.toLong()
            }
        }
        return asLong.takeIf(::isReportableCode)
    }

    private fun ticket(name: String, code: Long?): HandsHistoricalBuild =
        HandsHistoricalBuild(
            versionName = name.trim().takeIf { it.isNotEmpty() },
            versionCode = code,
        )

    private fun isReportableCode(code: Long): Boolean = code in 0..MAX_SAFE_INTEGER

    private fun firstMatch(text: String, vararg patterns: Regex): String {
        for (pattern in patterns) {
            val value = pattern.find(text)?.groupValues?.getOrNull(1)?.trim().orEmpty()
            if (value.isNotEmpty()) return value
        }
        return ""
    }

    private fun firstCode(text: String, vararg patterns: Regex): Long? {
        for (pattern in patterns) {
            val raw = pattern.find(text)?.groupValues?.getOrNull(1) ?: continue
            versionCodeOrNull(raw.toLongOrNull())?.let { return it }
        }
        return null
    }

    // Whitespace stays on the same line. `\s` would cross the newline and
    // treat the next field as the version.
    private val HEADER_NAME = Regex("(?m)^Version:[ \\t]*(\\S.*?)[ \\t]*\$")
    private val REPORTED_NAME = Regex("(?m)^Version name:[ \\t]*(\\S.*?)[ \\t]*\$")
    private val BUNDLE_NAME = Regex("(?m)^Bundle version:[ \\t]*(\\S.*?)[ \\t]*\$")
    private val HEADER_CODE = Regex("(?m)^VersionCode:[ \\t]*(\\d+)[ \\t]*\$")
    private val REPORTED_CODE = Regex("(?m)^Version code:[ \\t]*(\\d+)[ \\t]*\$")
}
