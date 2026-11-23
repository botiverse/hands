package build.hands.desktop

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.condition.DisabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** The sh swap helper end to end, with a fake app whose launcher is a shell script. */
@DisabledOnOs(OS.WINDOWS)
class SwapTest {
    @TempDir lateinit var tmp: Path
    private val hands = FakeHands()
    private val started = mutableListOf<Process>()

    @AfterEach fun stop() {
        hands.close()
        started.forEach { it.destroyForcibly() }
    }

    private val state get() = tmp.resolve("state")
    private val install get() = tmp.resolve("apps/Fake.app")
    private val log get() = tmp.resolve("launches.log")

    private fun app(launcher: String, version: String) = Tree(
        files = mapOf(
            "Contents/MacOS/Fake" to (bytes("#!/bin/sh\n$launcher\n") to "755"),
            "Contents/Resources/version.txt" to (bytes(version) to "644"),
        ),
        links = mapOf("Contents/current" to "MacOS/Fake"),
    )

    private val oldApp get() = app("echo \"old \$*\" >> '$log'", "1")

    private fun updater() = HandsDesktopUpdater(
        appSlug = "x", apiOrigin = hands.origin, target = "darwin-arm64",
        currentVersionCode = 1, installRoot = install, stateDir = state,
    )

    private fun fakeAppProcess(seconds: Int): Long =
        ProcessBuilder("sleep", seconds.toString()).start().also { started += it }.pid()

    private fun awaitResult(u: HandsDesktopUpdater): InstallResult {
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline) {
            u.lastInstallResult()?.let { return it }
            Thread.sleep(50)
        }
        error("helper did not finish; log:\n" + runCatching { Files.readString(state.resolve("hands-swap.log")) }.getOrDefault(""))
    }

    private fun awaitLog(line: String) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { Files.readAllLines(log) }.getOrDefault(emptyList()).contains(line)) return
            Thread.sleep(50)
        }
        error("no '$line' in launches log: ${runCatching { Files.readString(log) }.getOrDefault("<none>")}")
    }

    private fun prepareAndSwap(newApp: Tree, timeouts: SwapTimeouts, appPid: Long): HandsDesktopUpdater {
        oldApp.writeTo(install)
        hands.publish(newApp, "Fake.app")
        val u = updater().apply { swapTimeouts = timeouts }
        val prepared = u.prepare(u.checkForUpdate() as UpdateCheck.Available)
        u.installAndRestart(prepared, listOf("--updated", "a b"), "Contents/MacOS/Fake", appPid, RelaunchMode.EXEC)
        return u
    }

    @Test fun `a new version that confirms its launch stays installed`() {
        val newApp = app("echo \"new \$*\" >> '$log'\nprintf 2 > '${state.resolve("hands-launch-ok")}'", "2")
        val u = prepareAndSwap(newApp, SwapTimeouts(appExitMillis = 10_000, launchConfirmMillis = 10_000, tickMillis = 50), fakeAppProcess(1))
        assertEquals(InstallResult(InstallOutcome.INSTALLED, 2), awaitResult(u))
        awaitLog("new --updated a b")
        assertEquals(snapshot(newApp.writeTo(tmp.resolve("expected/Fake.app"))), snapshot(install))
        val backups = Files.list(state.resolve("backup")).use { it.toList() }
        assertEquals(1, backups.size)
        assertEquals(snapshot(oldApp.writeTo(tmp.resolve("old/Fake.app"))), snapshot(backups.single()))
        assertFalse(Files.exists(state.resolve("staging/2")))
        assertFalse(Files.exists(state.resolve(HandsDesktopUpdater.LOCK)))
    }

    @Test fun `a new version that never confirms is rolled back and the old one relaunched`() {
        val newApp = app("echo new-started >> '$log'\nexec sleep 30", "2")
        val u = prepareAndSwap(
            newApp,
            SwapTimeouts(appExitMillis = 10_000, launchConfirmMillis = 1_500, killGraceMillis = 500, tickMillis = 50),
            fakeAppProcess(1),
        )
        assertEquals(InstallResult(InstallOutcome.ROLLED_BACK, 2), awaitResult(u))
        awaitLog("new-started")
        awaitLog("old --updated a b")
        assertEquals(snapshot(oldApp.writeTo(tmp.resolve("old/Fake.app"))), snapshot(install))
        assertFalse(Files.exists(state.resolve("staging/2")))
        assertFalse(Files.exists(state.resolve("failed-2")))
        val backups = Files.list(state.resolve("backup")).use { it.toList() }
        assertTrue(backups.isEmpty(), "backup was moved back: $backups")
    }

    @Test fun `an app that does not exit aborts the swap and leaves the install alone`() {
        val newApp = app("printf 2 > '${state.resolve("hands-launch-ok")}'", "2")
        val u = prepareAndSwap(newApp, SwapTimeouts(appExitMillis = 500, tickMillis = 50), fakeAppProcess(30))
        assertEquals(InstallResult(InstallOutcome.ABORTED, 2), awaitResult(u))
        assertEquals(snapshot(oldApp.writeTo(tmp.resolve("old/Fake.app"))), snapshot(install))
        assertTrue(Files.isDirectory(state.resolve("staging/2/Fake.app")), "staged tree kept for a retry")
    }

    @Test fun `install refuses a tree that was not prepared`() {
        oldApp.writeTo(install)
        val u = updater()
        val fake = PreparedUpdate(DesktopRelease("r", "0.0.2", 2, null, false, null), state.resolve("staging/2/Fake.app"),
            "0".repeat(64), 0, 0, 0, 0, 0, false)
        assertThrows<HandsUpdateException> { u.installAndRestart(fake, emptyList(), "Contents/MacOS/Fake", 1, RelaunchMode.EXEC) }
    }

    @Test fun `markLaunchSucceeded writes the marker and cleans old staging and backups`() {
        val u = HandsDesktopUpdater(appSlug = "x", apiOrigin = hands.origin, target = "darwin-arm64",
            currentVersionCode = 2, installRoot = install, stateDir = state)
        Files.createDirectories(state.resolve("staging/1/A.app"))
        Files.createDirectories(state.resolve("staging/2/A.app"))
        Files.createDirectories(state.resolve("staging/5/A.app"))
        Files.writeString(state.resolve("staging/5/.hands-prepared.json"), "{}")
        Files.createDirectories(state.resolve("backup/A.app-0-1"))
        Thread.sleep(20)
        Files.createDirectories(state.resolve("backup/A.app-1-2"))
        Files.setLastModifiedTime(state.resolve("backup/A.app-0-1"), java.nio.file.attribute.FileTime.fromMillis(1000))
        Files.createDirectories(state.resolve("work/3"))
        u.markLaunchSucceeded()
        assertEquals("2", Files.readString(state.resolve(HandsDesktopUpdater.MARKER)))
        assertFalse(Files.exists(state.resolve("staging/1")))
        assertFalse(Files.exists(state.resolve("staging/2")))
        assertTrue(Files.exists(state.resolve("staging/5")))
        assertFalse(Files.exists(state.resolve("backup/A.app-0-1")))
        assertTrue(Files.exists(state.resolve("backup/A.app-1-2")))
        assertFalse(Files.exists(state.resolve("work")))
    }

    @Test fun `markLaunchSucceeded leaves state alone while a swap helper runs`() {
        val u = HandsDesktopUpdater(appSlug = "x", apiOrigin = hands.origin, target = "darwin-arm64",
            currentVersionCode = 2, installRoot = install, stateDir = state)
        Files.createDirectories(state.resolve("staging/1/A.app"))
        Files.writeString(state.resolve(HandsDesktopUpdater.LOCK), fakeAppProcess(30).toString())
        u.markLaunchSucceeded()
        assertTrue(Files.exists(state.resolve("staging/1")))
        assertTrue(Files.exists(state.resolve(HandsDesktopUpdater.MARKER)))
    }
}
