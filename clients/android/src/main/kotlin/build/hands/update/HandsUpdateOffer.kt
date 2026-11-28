package build.hands.update

import build.hands.update.internal.DeltaUpdater
import build.hands.update.models.Patch
import build.hands.update.models.UpdateCheckResponse
import kotlinx.serialization.Serializable

/**
 * What an update page shows before the person taps Install: the offered
 * version, its release notes already picked for the requested language, and
 * how much will be downloaded.
 *
 * [downloadSizeBytes] is the patch size when this device can apply the
 * offered patch, otherwise the full APK size ([fullSizeBytes]). Since 0.16.2 a
 * patch made from a different APK of the installed version code (universal vs
 * arm64-v8a) does not count: [patchSizeBytes] is then null.
 */
@Serializable
data class HandsUpdateOffer(
    val versionCode: Long,
    val versionName: String,
    val buildId: String,
    val releaseNotes: String? = null,
    val releaseNotesLanguageTag: String? = null,
    val downloadSizeBytes: Long,
    val fullSizeBytes: Long,
    val patchSizeBytes: Long? = null,
    val forceUpdate: Boolean = false,
    val releasedAt: Long? = null,
)

/** Result of [UpdateChecker.check]: the offer, if any, and the current transaction status. */
@Serializable
data class HandsUpdateCheck(
    val updateAvailable: Boolean,
    val offer: HandsUpdateOffer? = null,
    val status: HandsUpdateStatus,
)

/**
 * Whether this device can apply [patch] on top of [installedVersionCode] and
 * the installed APK whose hash is [installedSha256] (null if unknown).
 */
internal fun patchApplies(
    patch: Patch?,
    installedVersionCode: Long,
    deltaEnabled: Boolean,
    installedSha256: String? = null,
): Boolean =
    patch != null &&
        deltaEnabled &&
        installedVersionCode > 0L &&
        patch.from_version_code == installedVersionCode &&
        DeltaUpdater.compressionFor(patch.algorithm) != null &&
        !patch.target_sha256.isNullOrBlank() &&
        patch.size_bytes > 0L &&
        DeltaUpdater.sourceMatches(patch, installedSha256)

/**
 * Release notes for [requestedLanguageTag]: the matching or closest
 * per-language entry, else the release's plain changelog.
 */
internal fun releaseNotesFor(
    response: UpdateCheckResponse,
    requestedLanguageTag: String?,
): Pair<String?, String?> {
    val latest = response.latest ?: return null to null
    val tag = resolveLanguageTag(requestedLanguageTag, latest.release_notes)
    val notes = tag?.let { latest.release_notes?.get(it) }?.takeIf { it.isNotBlank() }
    if (notes != null) return notes to tag
    return latest.changelog?.takeIf { it.isNotBlank() } to null
}

internal fun updateOffer(
    response: UpdateCheckResponse,
    installedVersionCode: Long,
    deltaEnabled: Boolean,
    requestedLanguageTag: String?,
    installedSha256: String? = null,
): HandsUpdateOffer? {
    val (latest, asset) = response.requireUpdate() ?: return null
    val patch = response.patch?.takeIf { patchApplies(it, installedVersionCode, deltaEnabled, installedSha256) }
    val (notes, notesTag) = releaseNotesFor(response, requestedLanguageTag)
    return HandsUpdateOffer(
        versionCode = latest.version_code,
        versionName = latest.version,
        buildId = latest.build_id,
        releaseNotes = notes,
        releaseNotesLanguageTag = notesTag,
        downloadSizeBytes = patch?.size_bytes ?: asset.size_bytes,
        fullSizeBytes = asset.size_bytes,
        patchSizeBytes = patch?.size_bytes,
        forceUpdate = latest.force_update,
        releasedAt = latest.released_at,
    )
}
