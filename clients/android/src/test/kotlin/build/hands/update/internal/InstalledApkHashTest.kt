package build.hands.update.internal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class InstalledApkHashTest {
    @get:Rule
    val temp = TemporaryFolder()

    private class MemoryCache : InstalledApkHash.Cache {
        var entry: Pair<String, String>? = null
        var writes = 0
        override fun read() = entry
        override fun write(key: String, sha256: String) {
            writes += 1
            entry = key to sha256
        }
    }

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun `hashes the APK once per install and reuses the cached hash`() {
        val apk = temp.newFile("base.apk").apply { writeBytes(ByteArray(200_000) { (it % 251).toByte() }) }
        val cache = MemoryCache()
        var computed = 0
        val counting = { file: java.io.File -> computed += 1; InstalledApkHash.sha256Hex(file) }
        val key = InstalledApkHash.cacheKey(1000010, 1_700_000_000_000, apk.length())

        val first = InstalledApkHash.resolve(cache, key, apk, counting)
        assertEquals(sha256(apk.readBytes()), first)
        assertEquals(first, InstalledApkHash.resolve(cache, key, apk, counting))
        assertEquals(1, computed)
        assertEquals(1, cache.writes)

        // An update (new versionCode / lastUpdateTime / size) hashes again.
        apk.writeBytes(ByteArray(10) { 1 })
        val updatedKey = InstalledApkHash.cacheKey(1000011, 1_700_000_100_000, apk.length())
        val second = InstalledApkHash.resolve(cache, updatedKey, apk, counting)
        assertEquals(sha256(apk.readBytes()), second)
        assertNotEquals(first, second)
        assertEquals(2, computed)
    }

    @Test
    fun `cache key changes with each part of the install identity`() {
        val key = InstalledApkHash.cacheKey(1, 2, 3)
        assertNotEquals(key, InstalledApkHash.cacheKey(9, 2, 3))
        assertNotEquals(key, InstalledApkHash.cacheKey(1, 9, 3))
        assertNotEquals(key, InstalledApkHash.cacheKey(1, 2, 9))
    }

    @Test
    fun `a missing or unreadable APK gives no hash and caches nothing`() {
        val cache = MemoryCache()
        assertNull(InstalledApkHash.resolve(cache, "k", temp.root.resolve("missing.apk")))
        val apk = temp.newFile("base.apk")
        assertNull(InstalledApkHash.resolve(cache, "k", apk) { throw java.io.IOException("EIO") })
        assertNull(cache.entry)
    }

    @Test
    fun `a corrupt cached value is recomputed, and a failing cache never fails the hash`() {
        val apk = temp.newFile("base.apk").apply { writeText("apk") }
        val cache = MemoryCache().apply { entry = "k" to "not-a-hash" }
        assertEquals(sha256("apk".toByteArray()), InstalledApkHash.resolve(cache, "k", apk))
        val broken = object : InstalledApkHash.Cache {
            override fun read(): Pair<String, String>? = throw IllegalStateException("prefs")
            override fun write(key: String, sha256: String) = throw IllegalStateException("prefs")
        }
        assertEquals(sha256("apk".toByteArray()), InstalledApkHash.resolve(broken, "k", apk))
    }
}
