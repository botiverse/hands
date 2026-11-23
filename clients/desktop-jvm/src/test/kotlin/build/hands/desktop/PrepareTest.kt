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

@DisabledOnOs(OS.WINDOWS)
class PrepareTest {
    @TempDir lateinit var tmp: Path
    private val hands = FakeHands()

    @AfterEach fun stop() = hands.close()

    private val runtime = randomBytes(300_000, 1)
    private val oldTree = Tree(
        files = mapOf(
            "Contents/MacOS/App" to (bytes("#!/bin/sh\necho v1\n") to "755"),
            "Contents/runtime/lib.bin" to (runtime to "644"),
            "Contents/Resources/a.txt" to (bytes("same") to "644"),
            "Contents/Resources/gone.txt" to (bytes("removed in v2") to "644"),
        ),
        links = mapOf("Contents/current" to "MacOS/App"),
    )
    private val newTree = Tree(
        files = mapOf(
            "Contents/MacOS/App" to (bytes("#!/bin/sh\necho v2\n") to "755"),
            "Contents/runtime/lib.bin" to (runtime to "644"),
            "Contents/Resources/a.txt" to (bytes("same") to "644"),
            "Contents/Resources/copy-of-a.txt" to (bytes("same") to "600"),
            "Contents/Resources/new.txt" to (bytes("added") to "644"),
            "Contents/Resources/empty" to (ByteArray(0) to "444"),
        ),
        links = mapOf("Contents/current" to "MacOS/App", "Contents/Res" to "Resources"),
    )

    private fun updater(install: Path, code: Long = 1) = HandsDesktopUpdater(
        appSlug = "x",
        apiOrigin = hands.origin,
        target = "darwin-arm64",
        currentVersionCode = code,
        installRoot = install,
        stateDir = tmp.resolve("state"),
        deviceId = "device-1",
    ).apply { retryBackoffMillis = 10 }

    private fun available(u: HandsDesktopUpdater) = u.checkForUpdate() as UpdateCheck.Available

    @Test fun `only changed files are downloaded and the tree matches the manifest`() {
        val install = oldTree.writeTo(tmp.resolve("Test.app"))
        val before = snapshot(install)
        hands.publish(newTree, "Test.app")
        val u = updater(install)
        val events = java.util.concurrent.CopyOnWriteArrayList<PrepareProgress>()
        val prepared = u.prepare(available(u)) { events += it }

        // App (changed), new.txt and empty are new digests; lib.bin and a.txt (twice) are reused.
        assertEquals(3, hands.count("/public/v2/apps/x/files/"))
        assertEquals(3, hands.count("/blob/"))
        assertEquals(0, hands.count("/r2/archive.zip"))
        assertEquals(3, prepared.downloadedFiles)
        assertEquals(3, prepared.reusedFiles)
        assertFalse(prepared.usedFullArchive)
        val expected = snapshot(newTree.writeTo(tmp.resolve("expected/Test.app")))
        assertEquals(expected, snapshot(prepared.stagedRoot))
        assertEquals(tmp.resolve("state/staging/2/Test.app"), prepared.stagedRoot)
        assertTrue(Files.isRegularFile(tmp.resolve("state/staging/2/.hands-prepared.json")))
        assertEquals(before, snapshot(install))
        assertTrue(events.any { it.phase == PreparePhase.DOWNLOADING })
        assertTrue(events.any { it.phase == PreparePhase.VERIFYING })
        // One bar for the whole prepare(): starts near 0, ends at 1, and each phase sits
        // after the one before it.
        assertTrue(events.first().fraction < 0.05)
        assertEquals(1.0, events.last().fraction, 1e-9)
        val byPhase = events.groupBy { it.phase }
        val order = PreparePhase.values().filter { it in byPhase }
        order.zipWithNext().forEach { (a, b) ->
            assertTrue(byPhase.getValue(a).maxOf { it.fraction } <= byPhase.getValue(b).minOf { it.fraction } + 1e-9, "$a before $b")
        }
        assertEquals(setOf("device-1"), hands.deviceIds.toSet())
        assertEquals(2L, u.loadPrepared()?.release?.versionCode)
        assertFalse(Files.exists(tmp.resolve("state/work/2")))
    }

    @Test fun `an empty install downloads everything once per digest`() {
        hands.publish(newTree, "Test.app")
        val u = updater(tmp.resolve("Missing.app")).apply { archivePolicy = ArchivePolicy.NEVER }
        val prepared = u.prepare(available(u))
        assertEquals(5, hands.count("/blob/")) // a.txt and copy-of-a.txt share one digest
        assertEquals(snapshot(newTree.writeTo(tmp.resolve("e/Test.app"))), snapshot(prepared.stagedRoot))
    }

    @Test fun `the full archive is used when it is cheaper and modes and links still come from the manifest`() {
        hands.publish(newTree, "Test.app")
        val u = updater(tmp.resolve("Missing.app")).apply { archivePolicy = ArchivePolicy.ALWAYS }
        val prepared = u.prepare(available(u))
        assertTrue(prepared.usedFullArchive)
        assertEquals(1, hands.count("/r2/archive.zip"))
        assertEquals(0, hands.count("/blob/"))
        assertEquals(snapshot(newTree.writeTo(tmp.resolve("e/Test.app"))), snapshot(prepared.stagedRoot))
    }

    @Test fun `AUTO picks the archive when single files would cost more`() {
        val many = Tree((1..20).associate { "f$it" to (bytes("file $it") to "644") })
        hands.publish(many, "M")
        val prepared = updater(tmp.resolve("M")).let { it.prepare(available(it)) }
        assertTrue(prepared.usedFullArchive)
        assertEquals(0, hands.count("/blob/"))
    }

    @Test fun `transient 500s are retried`() {
        hands.publish(newTree, "Test.app")
        hands.failFirst[sha256Hex(bytes("added"))] = java.util.concurrent.atomic.AtomicInteger(2)
        val install = oldTree.writeTo(tmp.resolve("Test.app"))
        val u = updater(install)
        u.prepare(available(u))
        assertEquals(5, hands.count("/blob/"))
    }

    @Test fun `a hash mismatch fails, removes staging and leaves the install untouched`() {
        val install = oldTree.writeTo(tmp.resolve("Test.app"))
        val before = snapshot(install)
        hands.publish(newTree, "Test.app")
        hands.overrides[sha256Hex(bytes("added"))] = bytes("adder") // same size, other bytes
        val u = updater(install)
        val e = assertThrows<IntegrityException> { u.prepare(available(u)) }
        assertTrue(e.message!!.contains("SHA-256"), e.message)
        assertFalse(Files.exists(tmp.resolve("state/staging/2")))
        assertEquals(before, snapshot(install))
        assertEquals(null, u.loadPrepared())
    }

    @Test fun `a size mismatch fails`() {
        val install = oldTree.writeTo(tmp.resolve("Test.app"))
        hands.publish(newTree, "Test.app")
        hands.overrides[sha256Hex(bytes("added"))] = bytes("added and more")
        val u = updater(install)
        assertThrows<IntegrityException> { u.prepare(available(u)) }
        assertFalse(Files.exists(tmp.resolve("state/staging/2")))
    }

    @Test fun `a manifest whose digest does not match is refused`() {
        hands.publish(newTree, "Test.app")
        hands.manifestShaOverride = "0".repeat(64)
        val u = updater(tmp.resolve("Test.app"))
        assertThrows<IntegrityException> { u.prepare(available(u)) }
        assertEquals(0, hands.count("/blob/"))
    }

    @Test fun `a manifest for another target is refused`() {
        hands.publish(newTree, "Test.app", target = "linux-x64")
        val u = updater(tmp.resolve("Test.app"))
        assertThrows<ManifestInvalidException> { u.prepare(available(u)) }
    }

    @Test fun `an escaping symlink in a served manifest is refused before any download`() {
        hands.publish(Tree(mapOf("d/f" to (bytes("x") to "644")), mapOf("d/up" to "..", "l" to "d/up/..")), "R")
        val u = updater(tmp.resolve("R"))
        assertThrows<ManifestInvalidException> { u.prepare(available(u)) }
        assertEquals(0, hands.count("/blob/"))
        assertFalse(Files.exists(tmp.resolve("state/staging/2")))
    }

    @Test fun `no update and force update are reported`() {
        hands.publish(newTree, "Test.app", code = 2)
        assertEquals(UpdateCheck.NoUpdate(2), updater(tmp.resolve("Test.app"), code = 2).checkForUpdate())
        hands.forceUpdate = true
        val check = available(updater(tmp.resolve("Test.app"), code = 1))
        assertTrue(check.forceUpdate)
        assertEquals(2L, check.release.versionCode)
        assertEquals("0.0.2", check.release.version)
    }

    @Test fun `an HTTP error names the server code`() {
        val u = HandsDesktopUpdater(appSlug = "nope", apiOrigin = hands.origin, target = "darwin-arm64",
            currentVersionCode = 1, installRoot = tmp.resolve("A"), stateDir = tmp.resolve("s"))
        val e = assertThrows<HttpStatusException> { u.checkForUpdate() }
        assertEquals(404, e.status)
        assertEquals("app_not_found", e.code)
    }
}
