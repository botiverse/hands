package build.hands.desktop

import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class ManifestTest {
    private val sha = "a".repeat(64)

    private fun file(path: String, mode: String = "644", size: Int = 1, sha256: String = sha) =
        """{"path":${JsonPrimitive(path)},"sha256":"$sha256","size":$size,"mode":"$mode"}"""

    private fun link(path: String, target: String) = """{"path":"$path","link":"$target"}"""

    private fun manifest(vararg entries: String, target: String = "darwin-arm64", root: String = "App.app", total: String = "") =
        """{"schema":1,"target":"$target","root":"$root","files":[${entries.joinToString(",")}]$total}"""

    private fun parse(text: String, target: String = "darwin-arm64") = DesktopManifest.parse(text.toByteArray(), target)

    private fun refused(text: String, target: String = "darwin-arm64"): String =
        assertThrows<ManifestInvalidException> { parse(text, target) }.message!!

    @Test fun `a valid manifest parses`() {
        val m = parse(manifest(file("Contents/MacOS/App", "755"), link("Contents/current", "MacOS/App"), file("d/f"), link("d/up", ".."), total = ""","total_size":2"""))
        assertEquals(2, m.files.size)
        assertEquals(2, m.links.size)
        assertEquals(2L, m.totalSize)
    }

    @Test fun `paths must be relative and stay inside`() {
        for (bad in listOf("../x", "a/../b", "/abs", "C:/x", "a//b", "./a", "a\\b", "a/")) {
            refused(manifest(file(bad)))
        }
    }

    @Test fun `links are resolved through other links`() {
        // d/up -> .. is harmless alone; l -> d/up/.. climbs out once d/up is followed.
        assertTrue(refused(manifest(file("d/f"), link("d/up", ".."), link("l", "d/up/.."))).contains("outside"))
        refused(manifest(file("a"), link("l", "../a")))
        refused(manifest(file("a"), link("l", "/etc/passwd")))
        assertTrue(refused(manifest(file("a"), link("x", "y"), link("y", "x"))).contains("loops"))
        parse(manifest(file("d/f"), link("d/up", ".."), link("l", "d/up/d/f")))
    }

    @Test fun `modes are three octal digits without special bits`() {
        for (bad in listOf("4755", "75", "789", "rwx", "0755")) refused(manifest(file("a", mode = bad)))
        parse(manifest(file("a", mode = "000")))
    }

    @Test fun `case and normalisation collide on darwin and win32 but not on linux`() {
        refused(manifest(file("App"), file("app")))
        refused(manifest(file("App"), file("app"), target = "win32-x64"), target = "win32-x64")
        parse(manifest(file("App"), file("app"), target = "linux-x64"), target = "linux-x64")
        refused(manifest(file("caf\u00e9"), file("cafe\u0301")))
    }

    @Test fun `windows names are checked on win32 targets`() {
        for (bad in listOf("CON", "nul.txt", "a:b", "trailing.", "q?")) {
            refused(manifest(file(bad), target = "win32-x64"), target = "win32-x64")
        }
        parse(manifest(file("CON"), target = "linux-x64"), target = "linux-x64")
    }

    @Test fun `entries cannot sit under files or links`() {
        refused(manifest(file("a"), file("a/b")))
        refused(manifest(file("x/f"), link("l", "x"), file("l/g")))
    }

    @Test fun `shape errors`() {
        refused(manifest(file("a"), file("a")))
        refused(manifest(file("a", sha256 = "A".repeat(64))))
        refused(manifest(file("a"), file("b", size = 2)))
        refused(manifest(file("a"), total = ""","total_size":5"""))
        refused(manifest(file("a"), root = "a/b"))
        refused(manifest())
        refused("""{"schema":2,"target":"darwin-arm64","root":"R","files":[${file("a")}]}""")
        refused("""{"path":"a","link":"b","sha256":"$sha"}""".let { manifest(file("b"), it) })
        refused("not json")
        refused(manifest(file("a")), target = "darwin-x64")
    }
}
