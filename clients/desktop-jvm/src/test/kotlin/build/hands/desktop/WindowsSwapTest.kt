package build.hands.desktop

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledOnOs
import org.junit.jupiter.api.condition.OS
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** Quoting and the generated script, on every OS. */
class WindowsSwapScriptTest {
    @TempDir lateinit var tmp: Path

    @Test fun `relaunch arguments are quoted for the Windows command line`() {
        assertEquals("--updated \"a b\" \"\" \"say \\\"hi\\\"\" \"C:\\dir with space\\\\\" plain",
            WindowsSwapHelper.commandLine(listOf("--updated", "a b", "", "say \"hi\"", "C:\\dir with space\\", "plain")))
        assertEquals("", WindowsSwapHelper.commandLine(emptyList()))
    }

    @Test fun `the script bakes in every path as a single-quoted literal and starts with a BOM`() {
        val script = tmp.resolve("hands-swap.ps1")
        val root = tmp.resolve("it's here")
        WindowsSwapHelper.write(SwapHelper.Spec(
            appPid = 42, installRoot = root.resolve("App"), stagedRoot = root.resolve("staging/2/App"),
            stagingDir = root.resolve("staging/2"), backupDir = root.resolve("backup"), backup = root.resolve("backup/App-1-0"),
            failedDir = root.resolve("failed-2"), marker = root.resolve("hands-launch-ok"), lock = root.resolve("lock"),
            result = root.resolve("result"), log = root.resolve("log"), newVersionCode = 2, mode = RelaunchMode.EXEC,
            launcher = root.resolve("App/app.exe"), relaunchArgs = listOf("a b"), timeouts = SwapTimeouts(),
        ), script)
        val bytes = Files.readAllBytes(script)
        assertEquals(listOf(0xEF, 0xBB, 0xBF), bytes.take(3).map { it.toInt() and 0xFF })
        val text = String(bytes, 3, bytes.size - 3, Charsets.UTF_8)
        assertTrue(text.contains("\$InstallRoot = '${root.resolve("App").toString().replace("'", "''")}'"), text)
        assertTrue(text.contains("\$ArgLine = '\"a b\"'"), text)
        assertTrue(text.contains("\$AppPid = 42"))
        assertTrue(text.trimEnd().endsWith("Finish 'installed'"))
    }
}

/** The PowerShell swap helper end to end, with a fake app whose launcher is a .cmd script. */
@EnabledOnOs(OS.WINDOWS)
class WindowsSwapTest {
    @TempDir lateinit var tmp: Path
    private val hands = FakeHands()
    private val started = mutableListOf<Process>()

    @AfterEach fun stop() {
        hands.close()
        started.forEach { it.destroyForcibly() }
    }

    private val state get() = tmp.resolve("state")
    private val install get() = tmp.resolve("apps/Fake")
    private val log get() = tmp.resolve("launches.log")

    private fun app(launcher: String, version: String) = Tree(
        files = mapOf(
            "Fake.cmd" to (bytes("@echo off\r\n$launcher\r\n") to "755"),
            "version.txt" to (bytes(version) to "644"),
        ),
    )

    private val oldApp get() = app(">> \"$log\" echo old %*", "1")

    private fun updater() = HandsDesktopUpdater(
        appSlug = "x", apiOrigin = hands.origin, target = "win32-x64",
        currentVersionCode = 1, installRoot = install, stateDir = state,
    )

    private fun fakeAppProcess(seconds: Int): Long =
        ProcessBuilder("ping", "-n", (seconds + 1).toString(), "127.0.0.1").redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start().also { started += it }.pid()

    private fun awaitResult(u: HandsDesktopUpdater): InstallResult {
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            u.lastInstallResult()?.let { return it }
            Thread.sleep(100)
        }
        error("helper did not finish; log:\n" + runCatching { Files.readString(state.resolve("hands-swap.log")) }.getOrDefault(""))
    }

    private fun awaitLog(line: String) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (runCatching { Files.readAllLines(log).map { it.trim() } }.getOrDefault(emptyList()).contains(line)) return
            Thread.sleep(100)
        }
        error("no '$line' in launches log: ${runCatching { Files.readString(log) }.getOrDefault("<none>")}\nhelper log:\n" +
            runCatching { Files.readString(state.resolve("hands-swap.log")) }.getOrDefault("<none>"))
    }

    private fun prepareAndSwap(newApp: Tree, timeouts: SwapTimeouts, appPid: Long): HandsDesktopUpdater {
        oldApp.writeTo(install)
        hands.publish(newApp, "Fake", target = "win32-x64")
        val u = updater().apply { swapTimeouts = timeouts }
        val prepared = u.prepare(u.checkForUpdate() as UpdateCheck.Available)
        u.installAndRestart(prepared, listOf("--updated", "a b"), "Fake.cmd", appPid, RelaunchMode.EXEC)
        return u
    }

    @Test fun `a new version that confirms its launch stays installed`() {
        val newApp = app(">> \"$log\" echo new %*\r\n<nul set /p=\"2\" > \"${state.resolve("hands-launch-ok")}\"", "2")
        val u = prepareAndSwap(newApp, SwapTimeouts(appExitMillis = 20_000, launchConfirmMillis = 20_000, tickMillis = 100), fakeAppProcess(1))
        assertEquals(InstallResult(InstallOutcome.INSTALLED, 2), awaitResult(u))
        awaitLog("new --updated \"a b\"")
        assertEquals(snapshot(newApp.writeTo(tmp.resolve("expected/Fake"))), snapshot(install))
        val backups = Files.list(state.resolve("backup")).use { it.toList() }
        assertEquals(1, backups.size)
        assertFalse(Files.exists(state.resolve("staging/2")))
        assertFalse(Files.exists(state.resolve(HandsDesktopUpdater.LOCK)))
    }

    @Test fun `a new version that never confirms is rolled back and the old one relaunched`() {
        val newApp = app(">> \"$log\" echo new-started\r\nping -n 30 127.0.0.1 > nul", "2")
        val u = prepareAndSwap(
            newApp,
            SwapTimeouts(appExitMillis = 20_000, launchConfirmMillis = 3_000, killGraceMillis = 500, tickMillis = 100),
            fakeAppProcess(1),
        )
        assertEquals(InstallResult(InstallOutcome.ROLLED_BACK, 2), awaitResult(u))
        awaitLog("new-started")
        awaitLog("old --updated \"a b\"")
        assertEquals(snapshot(oldApp.writeTo(tmp.resolve("old/Fake"))), snapshot(install))
        assertFalse(Files.exists(state.resolve("staging/2")))
    }

    @Test fun `an app that does not exit aborts the swap and leaves the install alone`() {
        val newApp = app("<nul set /p=\"2\" > \"${state.resolve("hands-launch-ok")}\"", "2")
        val u = prepareAndSwap(newApp, SwapTimeouts(appExitMillis = 1_000, tickMillis = 100), fakeAppProcess(30))
        assertEquals(InstallResult(InstallOutcome.ABORTED, 2), awaitResult(u))
        assertEquals(snapshot(oldApp.writeTo(tmp.resolve("old/Fake"))), snapshot(install))
        assertTrue(Files.isDirectory(state.resolve("staging/2/Fake")), "staged tree kept for a retry")
    }
}
