package io.quiver.update.models

import kotlinx.serialization.Serializable

/**
 * Version metadata returned by `/public/apps/:slug/latest`.
 *
 * Mirrors the Worker API's Version schema (see
 * ../../worker/src/routes/public.ts).
 */
@Serializable
data class Version(
    val id: String,
    val version_name: String,
    val version_code: Int,
    val package_name: String,
    val signature_sha256: String,
    val min_sdk: Int? = null,
    val target_sdk: Int? = null,
    val size_bytes: Long,
    val file_hash: String,
    val enabled: Int,
    val created_at: Long,
) {
    /**
     * A version is "newer than installed" when its version_code is strictly
     * greater than the locally-installed versionCode. Returns false if equal
     * or older.
     */
    fun isNewerThan(installedVersionCode: Long): Boolean =
        version_code > installedVersionCode
}

/** Wrapper for the `/public/apps/:slug/latest` response. */
@Serializable
data class LatestVersionResponse(
    val app: App,
    val version: Version,
    val download_url: String,
    val expires_in: Int,
)