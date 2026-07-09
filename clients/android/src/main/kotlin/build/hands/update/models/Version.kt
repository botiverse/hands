package build.hands.update.models

import kotlinx.serialization.Serializable

/**
 * Flat SDK-facing response returned by
 * `/public/v2/apps/{slug}/updates/check`.
 *
 * The server resolves release scopes, rollout, version comparison, and APK
 * asset selection. Android only needs to inspect [update_available].
 */
@Serializable
data class UpdateCheckResponse(
    val update_available: Boolean,
    val app: App,
    val channel: String,
    val current_version_code: Long,
    val latest_version_code: Long? = null,
    val latest: LatestUpdate? = null,
    val asset: UpdateAsset? = null,
    val scoped: ScopedRelease? = null,
    val expires_in: Int? = null,
    val checked_at: Long? = null,
) {
    fun requireUpdate(): Pair<LatestUpdate, UpdateAsset>? {
        if (!update_available) return null
        val next = latest ?: return null
        val nextAsset = asset ?: return null
        if (next.version_code <= current_version_code) return null
        return next to nextAsset
    }
}

@Serializable
data class LatestUpdate(
    val build_id: String,
    val version: String,
    val version_code: Long,
    val changelog: String? = null,
    val force_update: Boolean = false,
    val released_at: Long,
)

@Serializable
data class UpdateAsset(
    val platform: String,
    val arch: String? = null,
    val variant: String? = null,
    val filetype: String,
    val size_bytes: Long,
    val signature: String? = null,
    val download_url: String,
)

@Serializable
data class ScopedRelease(
    val scope_type: String,
    val scope_value: String,
    val release_id: String,
)
