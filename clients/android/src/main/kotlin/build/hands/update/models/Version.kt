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
    val patch: Patch? = null,
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

/**
 * Optional incremental-update offer. When present, the client MAY reconstruct
 * the target APK by applying [download_url]'s binary patch on top of the
 * currently-installed base APK, instead of downloading the full asset.
 *
 * Purely an optimization: the client falls back to the full download whenever
 * the patch is missing, disabled, invalid, or fails any safety verification.
 *
 *  - [from_version_code] MUST equal the installed version_code (the patch is
 *    built against that exact base APK).
 *  - [algorithm] identifies the delta engine; today `archive-patcher-v1` or
 *    `archive-patcher-v1+gzip` (the `+gzip` suffix means the patch bytes are
 *    gzip-wrapped and must be gunzipped before applying).
 *  - [target_sha256] is the SHA-256 (hex) of the full TARGET APK; the client
 *    verifies the reconstructed file against it before installing.
 */
@Serializable
data class Patch(
    val from_version_code: Long,
    val algorithm: String,
    val download_url: String,
    val size_bytes: Long,
    val target_sha256: String? = null,
)

@Serializable
data class ScopedRelease(
    val scope_type: String,
    val scope_value: String,
    val release_id: String,
)
