package build.hands.desktop

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.DisabledOnOs
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

/**
 * Read-only check against the production test app `hands-desktop-smoke`
 * (darwin-arm64, versions 0.0.1 / 0.0.2). Opt in with HANDS_DESKTOP_IT=1.
 */
@EnabledIfEnvironmentVariable(named = "HANDS_DESKTOP_IT", matches = "1")
@DisabledOnOs(OS.WINDOWS)
class SmokeIntegrationTest {
    @TempDir lateinit var tmp: Path

    private fun updater(install: Path, state: Path, code: Long) = HandsDesktopUpdater(
        appSlug = "hands-desktop-smoke",
        apiOrigin = System.getenv("HANDS_API_ORIGIN") ?: "https://hands.build",
        channel = "main",
        target = "darwin-arm64",
        currentVersionCode = code,
        installRoot = install,
        stateDir = state,
    )

    @Test fun `latest version reports no update`() {
        assertTrue(updater(tmp.resolve("Smoke.app"), tmp.resolve("s"), 2).checkForUpdate() is UpdateCheck.NoUpdate)
    }

    @Test fun `prepare from nothing, then from the result, and from the full archive`() {
        val first = updater(tmp.resolve("none/Smoke.app"), tmp.resolve("s1"), 1).apply { archivePolicy = ArchivePolicy.NEVER }
        val check = first.checkForUpdate() as UpdateCheck.Available
        assertEquals(2L, check.release.versionCode)
        val fresh = first.prepare(check)
        assertEquals(2, fresh.downloadedFiles)
        val root = fresh.stagedRoot
        assertEquals(200_000L, Files.size(root.resolve("Contents/runtime/lib.bin")))
        assertEquals("rwxr-xr-x", PosixFilePermissions.toString(Files.getPosixFilePermissions(root.resolve("Contents/MacOS/Smoke"))))
        assertEquals(Path.of("MacOS/Smoke"), Files.readSymbolicLink(root.resolve("Contents/current")))

        // The staged tree as an "installed" copy: everything is reused.
        val second = updater(root, tmp.resolve("s2"), 1)
        val again = second.prepare(second.checkForUpdate() as UpdateCheck.Available)
        assertEquals(0, again.downloadedFiles)
        assertEquals(snapshot(root), snapshot(again.stagedRoot))

        val third = updater(tmp.resolve("none2/Smoke.app"), tmp.resolve("s3"), 1).apply { archivePolicy = ArchivePolicy.ALWAYS }
        val archived = third.prepare(third.checkForUpdate() as UpdateCheck.Available)
        assertTrue(archived.usedFullArchive)
        assertEquals(snapshot(root), snapshot(archived.stagedRoot))
    }
}
