package build.hands.desktop

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.condition.DisabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

@DisabledOnOs(OS.WINDOWS)
class InstallCheckTest {
    @TempDir lateinit var tmp: Path

    private fun updater(install: Path) = HandsDesktopUpdater(
        appSlug = "x", apiOrigin = "http://127.0.0.1:9", target = "darwin-arm64",
        currentVersionCode = 1, installRoot = install, stateDir = tmp.resolve("state"),
    )

    @Test fun `a writable install has no blocker`() {
        val app = Files.createDirectories(tmp.resolve("Applications/Raft.app"))
        assertNull(updater(app).installBlocker())
    }

    @Test fun `a translocated app is reported before anything else, without touching the network`() {
        val app = tmp.resolve("private/var/folders/xx/T/AppTranslocation/0A1B-2C3D/d/Raft.app")
        val u = updater(app)
        assertEquals(InstallBlocker.TRANSLOCATED, u.installBlocker())
        val update = UpdateCheck.Available(
            release = DesktopRelease("r", "2.0.0", 2, null, false, null),
            manifest = RemoteAsset("http://127.0.0.1:9/m", "0".repeat(64), 10),
            fullArchive = null, installer = null, filesUrlTemplate = "http://127.0.0.1:9/f/{sha256}", expiresAtMillis = 0,
        )
        val e = assertThrows<InstallBlockedException> { u.prepare(update) }
        assertEquals(InstallBlocker.TRANSLOCATED, e.blocker)
    }

    @Test fun `a missing install and an unwritable parent are reported`() {
        assertEquals(InstallBlocker.MISSING, updater(tmp.resolve("gone/Raft.app")).installBlocker())
        val parent = Files.createDirectories(tmp.resolve("locked"))
        val app = Files.createDirectories(parent.resolve("Raft.app"))
        Files.setPosixFilePermissions(parent, PosixFilePermissions.fromString("r-xr-xr-x"))
        try {
            assertEquals(InstallBlocker.NOT_WRITABLE, updater(app).installBlocker())
        } finally {
            Files.setPosixFilePermissions(parent, PosixFilePermissions.fromString("rwxr-xr-x"))
        }
    }
}
