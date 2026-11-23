package build.hands.desktop

import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.time.Duration
import java.util.HexFormat
import java.util.Locale

internal object Platform {
    val os: String = System.getProperty("os.name").lowercase(Locale.ROOT).let {
        when {
            it.startsWith("mac") || it.startsWith("darwin") -> "darwin"
            it.startsWith("windows") -> "win32"
            else -> "linux"
        }
    }

    /** `<os>-<arch>` of the running JVM, the way Hands names targets. */
    fun detectTarget(): String {
        val arch = when (System.getProperty("os.arch").lowercase(Locale.ROOT)) {
            "aarch64", "arm64" -> "arm64"
            "x86_64", "amd64", "x64" -> "x64"
            else -> System.getProperty("os.arch")
        }
        return "$os-$arch"
    }

    val posix: Boolean get() = os != "win32"
}

internal fun sha256Hex(bytes: ByteArray): String =
    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes))

/** Streams a file through SHA-256. */
internal fun sha256Of(file: Path): String {
    val digest = MessageDigest.getInstance("SHA-256")
    Files.newInputStream(file).use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
        }
    }
    return HexFormat.of().formatHex(digest.digest())
}

/**
 * Copy [input] into [out], hashing as it goes; refuses more than [expectedSize] bytes so a
 * wrong or hostile answer cannot fill the disk. Returns (bytes, sha256 hex).
 */
internal fun copyHashing(input: InputStream, out: Path, expectedSize: Long, onBytes: (Long) -> Unit): Pair<Long, String> {
    val digest = MessageDigest.getInstance("SHA-256")
    var total = 0L
    Files.newOutputStream(out, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE).use { output ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            total += n
            if (total > expectedSize) throw IntegrityException("$out: more than the declared $expectedSize bytes")
            digest.update(buffer, 0, n)
            output.write(buffer, 0, n)
            onBytes(n.toLong())
        }
    }
    return total to HexFormat.of().formatHex(digest.digest())
}

internal fun deleteTree(path: Path) {
    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) return
    Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
        override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
            Files.deleteIfExists(file); return FileVisitResult.CONTINUE
        }
        override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
            Files.deleteIfExists(file); return FileVisitResult.CONTINUE
        }
        override fun postVisitDirectory(dir: Path, exc: IOException?): FileVisitResult {
            Files.deleteIfExists(dir); return FileVisitResult.CONTINUE
        }
    })
}

/** Write [text] to [file] through a temporary sibling and a rename, so readers never see half of it. */
internal fun writeAtomically(file: Path, text: String) {
    Files.createDirectories(file.parent)
    val tmp = file.resolveSibling(".${file.fileName}.${ProcessHandle.current().pid()}.tmp")
    Files.writeString(tmp, text)
    try {
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
        Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
    }
}

/**
 * Copy one regular file. On macOS a large file is cloned with `cp -c` (APFS clonefile: no
 * bytes copied, no extra space) and falls back to an ordinary copy when that fails.
 */
internal fun copyFile(source: Path, target: Path) {
    if (Platform.os == "darwin" && Files.size(source) >= CLONE_THRESHOLD) {
        try {
            val process = ProcessBuilder("/bin/cp", "-c", source.toString(), target.toString())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start()
            if (process.waitFor() == 0) return
        } catch (_: IOException) {
            // fall through to a plain copy
        }
        Files.deleteIfExists(target)
    }
    Files.copy(source, target, StandardCopyOption.REPLACE_EXISTING, LinkOption.NOFOLLOW_LINKS)
}

/** Spawning `cp` costs a few ms; below this a plain copy is as fast. */
private const val CLONE_THRESHOLD = 1L shl 20

internal class Http(private val client: HttpClient, private val retries: Int, private val backoffMillis: Long) {
    fun getBytes(url: String, headers: Map<String, String>, maxBytes: Int): Pair<Int, ByteArray> {
        val request = request(url, headers)
        val response = client.send(request, HttpResponse.BodyHandlers.ofInputStream())
        response.body().use { body ->
            val bytes = body.readNBytes(maxBytes + 1)
            if (bytes.size > maxBytes) throw HandsUpdateException("$url: answer is larger than $maxBytes bytes")
            return response.statusCode() to bytes
        }
    }

    /** Download [url] into [out], checking size and SHA-256; retried on transfer and integrity errors. */
    fun download(url: String, out: Path, size: Long, sha256: String, onBytes: (Long) -> Unit) {
        var attempt = 0
        while (true) {
            attempt += 1
            var counted = 0L
            try {
                val response = client.send(request(url, emptyMap()), HttpResponse.BodyHandlers.ofInputStream())
                response.body().use { body ->
                    val status = response.statusCode()
                    if (status != 200) {
                        val retryable = status == 408 || status == 429 || status >= 500
                        val error = HttpStatusException(status, null, "GET ${redact(url)}: HTTP $status")
                        if (!retryable) throw NonRetryable(error)
                        throw error
                    }
                    val (got, digest) = copyHashing(body, out, size) { counted += it; onBytes(it) }
                    if (got != size) throw IntegrityException("${redact(url)}: got $got bytes, expected $size")
                    if (digest != sha256) throw IntegrityException("${redact(url)}: SHA-256 $digest, expected $sha256")
                }
                return
            } catch (e: NonRetryable) {
                Files.deleteIfExists(out)
                throw e.error
            } catch (e: Exception) {
                if (e is InterruptedException) throw e
                onBytes(-counted)
                Files.deleteIfExists(out)
                if (attempt > retries) {
                    throw if (e is HandsUpdateException) e else HandsUpdateException("GET ${redact(url)} failed: $e", e)
                }
                Thread.sleep(backoffMillis * (1L shl (attempt - 1)))
            }
        }
    }

    private fun request(url: String, headers: Map<String, String>): HttpRequest {
        val builder = HttpRequest.newBuilder(URI.create(url)).GET().timeout(Duration.ofSeconds(60))
            .header("User-Agent", "hands-desktop-updater")
        headers.forEach { (k, v) -> builder.header(k, v) }
        return builder.build()
    }

    private class NonRetryable(val error: HandsUpdateException) : Exception(error)

    companion object {
        /** Signed URLs carry their signature in the query; keep it out of messages and logs. */
        fun redact(url: String): String = url.substringBefore('?')
    }
}
