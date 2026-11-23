package build.hands.desktop

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** One bundle: regular files with modes, and symlinks. */
data class Tree(val files: Map<String, Pair<ByteArray, String>>, val links: Map<String, String> = emptyMap()) {
    fun writeTo(root: Path): Path {
        Files.createDirectories(root)
        files.forEach { (path, v) ->
            val file = root.resolve(path)
            Files.createDirectories(file.parent)
            Files.write(file, v.first)
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString(Stager.modeString(v.second)))
        }
        links.forEach { (path, target) ->
            val link = root.resolve(path)
            Files.createDirectories(link.parent)
            Files.createSymbolicLink(link, Path.of(target))
        }
        return root
    }

    fun manifest(root: String, target: String = "darwin-arm64"): JsonObject = buildJsonObject {
        put("schema", 1)
        put("target", target)
        put("root", root)
        putJsonArray("files") {
            files.toSortedMap().forEach { (path, v) ->
                addJsonObject {
                    put("path", path); put("sha256", sha256Hex(v.first)); put("size", v.first.size); put("mode", v.second)
                    put("link", JsonNull)
                }
            }
            links.toSortedMap().forEach { (path, target0) -> addJsonObject { put("path", path); put("link", target0) } }
        }
        put("total_size", files.values.sumOf { it.first.size })
    }

    fun zip(root: String): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            files.toSortedMap().forEach { (path, v) ->
                zip.putNextEntry(ZipEntry("$root/$path")); zip.write(v.first); zip.closeEntry()
            }
        }
        return out.toByteArray()
    }
}

/** Snapshot of a directory: relative path -> content hash, link target, or "dir". */
fun snapshot(root: Path): Map<String, String> {
    val out = sortedMapOf<String, String>()
    Files.walk(root).use { stream ->
        stream.forEach { p ->
            if (p == root) return@forEach
            val rel = Stager.rel(root, p)
            out[rel] = when {
                Files.isSymbolicLink(p) -> "-> " + Files.readSymbolicLink(p)
                Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS) -> "dir"
                else -> sha256Of(p) + " " + PosixFilePermissions.toString(Files.getPosixFilePermissions(p, LinkOption.NOFOLLOW_LINKS))
            }
        }
    }
    return out
}

/**
 * A stand-in for the Hands public desktop routes. `/files/{sha}` answers 302 to `/blob/{sha}`
 * as production does; the manifest and archive are "signed" URLs with a query string.
 */
class FakeHands : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    val origin: String get() = "http://127.0.0.1:${server.address.port}"
    val blobs = ConcurrentHashMap<String, ByteArray>()
    /** Bytes to serve instead of the real ones for a digest (corruption). */
    val overrides = ConcurrentHashMap<String, ByteArray>()
    /** Digest -> number of 500 answers to give before the real one. */
    val failFirst = ConcurrentHashMap<String, AtomicInteger>()
    val requests = ConcurrentHashMap<String, AtomicInteger>()
    val deviceIds = ConcurrentHashMap.newKeySet<String>()
    @Volatile var manifestBytes: ByteArray = ByteArray(0)
    @Volatile var manifestShaOverride: String? = null
    @Volatile var archiveBytes: ByteArray? = null
    @Volatile var latestCode: Long = 2
    @Volatile var forceUpdate: Boolean = false

    init {
        server.createContext("/") { ex -> runCatching { handle(ex) }.onFailure { it.printStackTrace(); ex.sendResponseHeaders(500, -1) }; ex.close() }
        server.executor = java.util.concurrent.Executors.newFixedThreadPool(8)
        server.start()
    }

    fun publish(tree: Tree, root: String, target: String = "darwin-arm64", code: Long = 2) {
        tree.files.values.forEach { blobs[sha256Hex(it.first)] = it.first }
        manifestBytes = tree.manifest(root, target).toString().toByteArray()
        archiveBytes = tree.zip(root)
        latestCode = code
    }

    fun count(prefix: String): Int = requests.filterKeys { it.startsWith(prefix) }.values.sumOf { it.get() }

    private fun handle(ex: HttpExchange) {
        val path = ex.requestURI.path
        requests.computeIfAbsent(path) { AtomicInteger() }.incrementAndGet()
        ex.requestHeaders.getFirst("X-Hands-Device-Id")?.let { deviceIds += it }
        when {
            path.endsWith("/desktop/update") && path != "/public/v2/apps/x/desktop/update" ->
                send(ex, 404, """{"error":"app not found","code":"app_not_found"}""".toByteArray(), "application/json")
            path.endsWith("/desktop/update") -> {
                val query = ex.requestURI.query.split('&').associate { it.substringBefore('=') to it.substringAfter('=') }
                val current = query.getValue("current_version_code").toLong()
                val body = if (latestCode <= current) buildJsonObject {
                    put("update_available", false); put("channel", "main"); put("target", query["target"])
                    put("current_version_code", current); put("latest_version_code", latestCode)
                } else buildJsonObject {
                    put("update_available", true); put("channel", "main"); put("target", query["target"])
                    put("current_version_code", current)
                    putJsonObject("release") {
                        put("id", "rel-$latestCode"); put("version", "0.0.$latestCode"); put("version_code", latestCode)
                        put("notes_url", "$origin/apps/x/v/0.0.$latestCode"); put("force_update", forceUpdate)
                        put("released_at", 1795000000000)
                    }
                    putJsonObject("manifest") {
                        put("url", "$origin/r2/manifest.json?sig=abc")
                        put("sha256", manifestShaOverride ?: sha256Hex(manifestBytes)); put("size", manifestBytes.size)
                    }
                    val archive = archiveBytes
                    if (archive == null) put("full_archive", JsonNull) else putJsonObject("full_archive") {
                        put("url", "$origin/r2/archive.zip?sig=abc"); put("sha256", sha256Hex(archive)); put("size", archive.size)
                    }
                    put("installer", JsonNull)
                    put("files_url_template", "$origin/public/v2/apps/x/files/{sha256}")
                    put("expires_in", 3600)
                }
                send(ex, 200, body.toString().toByteArray(), "application/json")
            }
            path == "/r2/manifest.json" -> send(ex, 200, manifestBytes)
            path == "/r2/archive.zip" -> send(ex, 200, archiveBytes ?: ByteArray(0))
            path.startsWith("/public/v2/apps/x/files/") -> {
                val sha = path.substringAfterLast('/')
                if (!blobs.containsKey(sha)) return send(ex, 404, "{}".toByteArray())
                ex.responseHeaders.add("Location", "$origin/blob/$sha?sig=xyz")
                ex.sendResponseHeaders(302, -1)
            }
            path.startsWith("/blob/") -> {
                val sha = path.substringAfterLast('/')
                val fails = failFirst[sha]
                if (fails != null && fails.getAndDecrement() > 0) return send(ex, 500, ByteArray(0))
                send(ex, 200, overrides[sha] ?: blobs[sha] ?: return send(ex, 404, ByteArray(0)))
            }
            else -> send(ex, 404, ByteArray(0))
        }
    }

    private fun send(ex: HttpExchange, status: Int, body: ByteArray, type: String = "application/octet-stream") {
        ex.responseHeaders.add("Content-Type", type)
        ex.sendResponseHeaders(status, if (body.isEmpty()) -1 else body.size.toLong())
        if (body.isNotEmpty()) ex.responseBody.use { it.write(body) }
    }

    override fun close() = server.stop(0)
}

fun bytes(text: String) = text.toByteArray()

fun randomBytes(n: Int, seed: Long) = ByteArray(n).also { java.util.Random(seed).nextBytes(it) }
