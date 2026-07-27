package build.hands.update

import android.content.Context
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

/** Stable states exposed to host applications and cross-platform bridges. */
@Serializable
enum class HandsUpdateState(val wireValue: String) {
    @SerialName("idle")
    IDLE("idle"),

    @SerialName("checking")
    CHECKING("checking"),

    @SerialName("patching")
    PATCHING("patching"),

    @SerialName("downloading")
    DOWNLOADING("downloading"),

    @SerialName("ready_to_install")
    READY_TO_INSTALL("ready_to_install"),

    @SerialName("installer_opened")
    INSTALLER_OPENED("installer_opened"),

    @SerialName("failed")
    FAILED("failed"),

    @SerialName("stale")
    STALE("stale"),

    @SerialName("installed")
    INSTALLED("installed"),
}

/**
 * Immutable, secret-free view of the SDK's persisted update transaction.
 *
 * [targetVersionCode] is null only while the first update check is in flight.
 * Signed download URLs are deliberately never exposed or persisted here.
 */
@Serializable
data class HandsUpdateStatus(
    val state: HandsUpdateState,
    val targetVersionCode: Long? = null,
    val installedVersionCode: Long? = null,
    val retryable: Boolean = false,
    val errorCode: String? = null,
    val targetBuildId: String? = null,
    val assetSha256: String? = null,
    val requestedLanguageTag: String? = null,
    val resolvedLanguageTag: String? = null,
    val updatedAt: Long? = null,
)

/** Structured update events that hosts can include in their own diagnostics. */
@Serializable
data class HandsUpdateEvent(
    val name: String,
    val state: HandsUpdateState,
    val targetVersionCode: Long? = null,
    val errorCode: String? = null,
    val requestedLanguageTag: String? = null,
    val resolvedLanguageTag: String? = null,
    val timestamp: Long = System.currentTimeMillis(),
)

/** The listener must return quickly; events are emitted on the calling thread. */
fun interface HandsUpdateEventListener {
    fun onEvent(event: HandsUpdateEvent)
}

@Serializable
internal data class UpdateTransactionRecord(
    val schemaVersion: Int = TRANSACTION_SCHEMA_VERSION,
    val packageName: String,
    val baseUrl: String,
    val appSlug: String,
    val channel: String,
    val productType: String,
    val platform: String,
    val arch: String? = null,
    val state: HandsUpdateState,
    val installedVersionCodeAtStart: Long? = null,
    val targetVersionCode: Long? = null,
    val targetBuildId: String? = null,
    val assetSizeBytes: Long? = null,
    val assetSha256: String? = null,
    val assetSignature: String? = null,
    val filetype: String? = null,
    val downloadId: Long? = null,
    val localFilePath: String? = null,
    val retryable: Boolean = false,
    val errorCode: String? = null,
    val requestedLanguageTag: String? = null,
    val resolvedLanguageTag: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = System.currentTimeMillis(),
) {
    fun status(installedVersionCode: Long?): HandsUpdateStatus = HandsUpdateStatus(
        state = state,
        targetVersionCode = targetVersionCode,
        installedVersionCode = installedVersionCode,
        retryable = retryable,
        errorCode = errorCode,
        targetBuildId = targetBuildId,
        assetSha256 = assetSha256,
        requestedLanguageTag = requestedLanguageTag,
        resolvedLanguageTag = resolvedLanguageTag,
        updatedAt = updatedAt,
    )
}

internal data class UpdateAuthority(
    val packageName: String,
    val baseUrl: String,
    val appSlug: String,
    val channel: String,
    val productType: String,
    val platform: String,
    val arch: String?,
) {
    val canonicalBaseUrl: String = baseUrl.trimEnd('/')

    fun matches(record: UpdateTransactionRecord): Boolean =
        record.schemaVersion == TRANSACTION_SCHEMA_VERSION &&
            record.packageName == packageName &&
            record.baseUrl == canonicalBaseUrl &&
            record.appSlug == appSlug &&
            record.channel == channel &&
            record.productType == productType &&
            record.platform == platform &&
            record.arch == arch

    fun storageKey(): String {
        val canonical = listOf(
            packageName,
            canonicalBaseUrl,
            appSlug,
            channel,
            productType,
            platform,
            arch.orEmpty(),
        ).joinToString("\n")
        val bytes = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray())
        return "transaction_" + bytes.joinToString("") { "%02x".format(it) }
    }
}

internal class UpdateTransactionStore(
    context: Context,
    private val authority: UpdateAuthority,
    private val json: Json = Json { ignoreUnknownKeys = false },
) {
    private val preferences = context.getSharedPreferences(TRANSACTION_PREFERENCES, Context.MODE_PRIVATE)
    private val key = authority.storageKey()

    @Synchronized
    fun read(): UpdateTransactionRecord? {
        val encoded = preferences.getString(key, null) ?: return null
        val decoded = try {
            json.decodeFromString(UpdateTransactionRecord.serializer(), encoded)
        } catch (_: Exception) {
            preferences.edit().remove(key).apply()
            return null
        }
        if (!authority.matches(decoded)) {
            preferences.edit().remove(key).apply()
            return null
        }
        return decoded
    }

    @Synchronized
    fun write(record: UpdateTransactionRecord) {
        require(authority.matches(record)) { "update transaction authority mismatch" }
        preferences.edit()
            .putString(key, json.encodeToString(UpdateTransactionRecord.serializer(), record))
            .apply()
    }

    @Synchronized
    fun clear() {
        preferences.edit().remove(key).apply()
    }
}

internal fun normalizedLanguageTag(languageTag: String?): String? {
    val value = languageTag?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    if (value.length > 64) return null
    if (!value.matches(Regex("^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$"))) return null
    return value
}

internal fun resolveLanguageTag(
    requestedLanguageTag: String?,
    releaseNotes: Map<String, String>?,
): String? {
    val entries = releaseNotes.orEmpty().filterValues { it.isNotBlank() }.keys
    if (entries.isEmpty()) return null
    val requested = normalizedLanguageTag(requestedLanguageTag)?.lowercase().orEmpty()
    entries.firstOrNull { it.lowercase() == requested }?.let { return it }
    val prefix = requested.substringBefore('-').takeIf { it.isNotBlank() }
    if (prefix != null) {
        entries.firstOrNull { it.lowercase().substringBefore('-') == prefix }?.let { return it }
    }
    return entries.firstOrNull { it.lowercase().substringBefore('-') == "en" }
        ?: entries.first()
}

private const val TRANSACTION_SCHEMA_VERSION = 1
private const val TRANSACTION_PREFERENCES = "hands_update_transactions_v1"
