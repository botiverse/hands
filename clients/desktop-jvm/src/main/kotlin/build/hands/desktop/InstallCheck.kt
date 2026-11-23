package build.hands.desktop

import java.nio.file.Files
import java.nio.file.Path

/** Whether the running app can be replaced where it is; local checks only. */
internal object InstallCheck {
    fun blocker(installRoot: Path): InstallBlocker? {
        val root = installRoot.toAbsolutePath().normalize()
        // App Translocation runs a quarantined, unmoved app from a randomized read-only
        // mount under .../AppTranslocation/<uuid>/d/<App>.app.
        if (root.toString().contains("/AppTranslocation/")) return InstallBlocker.TRANSLOCATED
        if (!Files.isDirectory(root)) return InstallBlocker.MISSING
        val parent = root.parent ?: return InstallBlocker.MISSING
        val readOnly = runCatching { Files.getFileStore(root).isReadOnly }.getOrDefault(false)
        if (readOnly) return InstallBlocker.READ_ONLY_VOLUME
        if (!Files.isWritable(parent)) return InstallBlocker.NOT_WRITABLE
        return null
    }

    fun describe(blocker: InstallBlocker, installRoot: Path): String = when (blocker) {
        InstallBlocker.TRANSLOCATED -> "the app runs from a translocated path ($installRoot); move it to Applications and open it from there"
        InstallBlocker.READ_ONLY_VOLUME -> "the app runs from a read-only volume ($installRoot), such as the disk image; copy it to Applications first"
        InstallBlocker.NOT_WRITABLE -> "cannot replace $installRoot: ${installRoot.parent} is not writable by this user"
        InstallBlocker.MISSING -> "install root $installRoot does not exist"
    }
}
