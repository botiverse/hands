package build.hands.desktop

import java.nio.file.Path

/** The release Hands offers, as `release` in the update check answer. */
public data class DesktopRelease(
    val id: String,
    val version: String,
    val versionCode: Long,
    val notesUrl: String?,
    /** The publisher asks clients not to keep running the old version. */
    val forceUpdate: Boolean,
    val releasedAtMillis: Long?,
)

/** A signed download (`manifest`, `full_archive`): fetch it before [UpdateCheck.Available.expiresAtMillis]. */
public data class RemoteAsset(val url: String, val sha256: String, val size: Long)

/** The installer for first installs; not used by the updater itself. */
public data class InstallerAsset(val url: String, val sha256: String, val size: Long, val filetype: String?)

public sealed interface UpdateCheck {
    /** Nothing newer than the installed version. [latestVersionCode] is null when no release is eligible. */
    public data class NoUpdate(val latestVersionCode: Long?) : UpdateCheck

    public data class Available(
        val release: DesktopRelease,
        val manifest: RemoteAsset,
        val fullArchive: RemoteAsset?,
        val installer: InstallerAsset?,
        /** `.../files/{sha256}`; Hands answers each digest with a redirect to a signed URL. */
        val filesUrlTemplate: String,
        /** When the signed [manifest] and [fullArchive] URLs stop working; check again after that. */
        val expiresAtMillis: Long,
    ) : UpdateCheck {
        val forceUpdate: Boolean get() = release.forceUpdate
    }
}

/** A new tree fully built and verified under the state directory, ready for [HandsDesktopUpdater.installAndRestart]. */
public data class PreparedUpdate(
    val release: DesktopRelease,
    /** `stateDir/staging/<version_code>/<root>`. */
    val stagedRoot: Path,
    val manifestSha256: String,
    val fileCount: Int,
    val totalBytes: Long,
    /** Regular files copied from the installed copy. */
    val reusedFiles: Int,
    /** Distinct digests fetched from Hands (one request each, retries excluded). */
    val downloadedFiles: Int,
    val downloadedBytes: Long,
    /** True when the full archive was downloaded instead of most single files. */
    val usedFullArchive: Boolean,
)

public enum class PreparePhase { MANIFEST, COMPARING, DOWNLOADING, ASSEMBLING, VERIFYING }

/** Progress of [HandsDesktopUpdater.prepare]. Bytes are those of the current phase. */
public data class PrepareProgress(val phase: PreparePhase, val doneBytes: Long, val totalBytes: Long)

/** Called from worker threads; keep it cheap and thread-safe (e.g. post to the UI thread). */
public fun interface ProgressListener {
    public fun onProgress(progress: PrepareProgress)
}

/** What the swap helper of the last [HandsDesktopUpdater.installAndRestart] did. */
public enum class InstallOutcome {
    /** The new version started and called [HandsDesktopUpdater.markLaunchSucceeded]. */
    INSTALLED,
    /** The new version did not confirm its launch in time; the old tree was restored and relaunched. */
    ROLLED_BACK,
    /** The app did not exit in time, or the swap could not start; the install was not touched. */
    ABORTED,
}

/** The last swap's outcome, for the version it tried to install. */
public data class InstallResult(val outcome: InstallOutcome, val versionCode: Long)

/** Every failure of a check or a prepare. Nothing under the install root has been changed when it is thrown. */
/** Why the running app cannot be replaced where it is (see [HandsDesktopUpdater.installBlocker]). */
public enum class InstallBlocker {
    /** macOS App Translocation: the app was opened from a quarantined download without being moved, and runs from a randomized read-only path. Ask the user to move it to Applications. */
    TRANSLOCATED,
    /** The app runs from a read-only volume, such as the mounted DMG. Ask the user to copy it to Applications. */
    READ_ONLY_VOLUME,
    /** The directory holding the app is not writable by this user. */
    NOT_WRITABLE,
    /** The install root is missing or has no parent directory. */
    MISSING,
}

/** The app cannot be updated in place; [blocker] says why. */
public class InstallBlockedException(public val blocker: InstallBlocker, message: String) : HandsUpdateException(message)

public open class HandsUpdateException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The manifest breaks a rule Hands enforces when it is published (see docs/public/desktop-apps.md). */
public class ManifestInvalidException(message: String) : HandsUpdateException(message)

/** A downloaded file, manifest or archive does not have the size or SHA-256 Hands declared. */
public class IntegrityException(message: String) : HandsUpdateException(message)

/** Hands answered an HTTP error. */
public class HttpStatusException(public val status: Int, public val code: String?, message: String) :
    HandsUpdateException(message)
