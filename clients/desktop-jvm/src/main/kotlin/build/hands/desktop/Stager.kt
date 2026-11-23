package build.hands.desktop

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.text.Normalizer
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.ZipFile

/** When to use the full archive instead of single files. */
internal enum class ArchivePolicy { AUTO, NEVER, ALWAYS }

/**
 * Builds a new tree for one update under `stateDir/staging/<version_code>/<root>`, from
 * the installed copy where it has the same bytes and from Hands for the rest, then checks
 * the whole tree against the manifest. Nothing outside stateDir is written.
 */
internal class Stager(
    private val http: Http,
    private val target: String,
    private val installRoot: Path,
    private val stateDir: Path,
    private val parallelism: Int,
    private val archivePolicy: ArchivePolicy,
    /** Bytes one single-file request is assumed to cost beyond its body, when weighing the archive. */
    private val perFileOverheadBytes: Long = 32 * 1024,
) {
    fun prepare(update: UpdateCheck.Available, listener: ProgressListener?): PreparedUpdate {
        val code = update.release.versionCode
        val stagingDir = stateDir.resolve("staging").resolve(code.toString())
        val workDir = stateDir.resolve("work").resolve(code.toString())
        deleteTree(stagingDir)
        deleteTree(workDir)
        Files.createDirectories(stagingDir)
        Files.createDirectories(workDir.resolve("blobs"))
        val pool = Executors.newFixedThreadPool(parallelism) { r ->
            Thread(r, "hands-desktop-update").apply { isDaemon = true }
        }
        try {
            return build(update, stagingDir, workDir, listener, pool)
        } catch (e: Throwable) {
            runCatching { deleteTree(stagingDir) }
            throw when (e) {
                is HandsUpdateException -> e
                is InterruptedException -> e
                else -> HandsUpdateException("prepare failed: $e", e)
            }
        } finally {
            pool.shutdownNow()
            runCatching { deleteTree(workDir) }
        }
    }

    private fun build(
        update: UpdateCheck.Available,
        stagingDir: Path,
        workDir: Path,
        listener: ProgressListener?,
        pool: java.util.concurrent.ExecutorService,
    ): PreparedUpdate {
        // 1. The manifest, checked against the digest Hands answered with.
        listener?.onProgress(PrepareProgress(PreparePhase.MANIFEST, 0, update.manifest.size))
        if (update.manifest.size > DesktopManifest.MAX_BYTES) throw IntegrityException("manifest is larger than ${DesktopManifest.MAX_BYTES} bytes")
        val (status, bytes) = http.getBytes(update.manifest.url, emptyMap(), DesktopManifest.MAX_BYTES)
        if (status != 200) throw HttpStatusException(status, null, "GET manifest: HTTP $status")
        if (bytes.size.toLong() != update.manifest.size) throw IntegrityException("manifest: got ${bytes.size} bytes, expected ${update.manifest.size}")
        val manifestSha = sha256Hex(bytes)
        if (manifestSha != update.manifest.sha256) throw IntegrityException("manifest: SHA-256 $manifestSha, expected ${update.manifest.sha256}")
        val manifest = DesktopManifest.parse(bytes, target)
        listener?.onProgress(PrepareProgress(PreparePhase.MANIFEST, bytes.size.toLong(), update.manifest.size))

        // 2. Which digests the installed copy already has, at the same path with the same size.
        val local = findLocalCopies(manifest, pool, listener)
        val missing = manifest.files.filter { it.sha256 !in local }.associate { it.sha256 to it.size }
        val missingBytes = missing.values.sum()

        // 3. Fetch what is missing: the full archive when that is cheaper, then single files.
        val blobs = workDir.resolve("blobs")
        val have = HashMap<String, Path>()
        var downloadedBytes = 0L
        var downloadedFiles = 0
        var usedArchive = false
        val archive = update.fullArchive
        val archiveCheaper = archive != null &&
            missingBytes + missing.size * perFileOverheadBytes > archive.size
        if (missing.isNotEmpty() && archive != null &&
            (archivePolicy == ArchivePolicy.ALWAYS || (archivePolicy == ArchivePolicy.AUTO && archiveCheaper))
        ) {
            val zip = workDir.resolve("archive.zip")
            val done = AtomicLong()
            http.download(archive.url, zip, archive.size, archive.sha256) {
                listener?.onProgress(PrepareProgress(PreparePhase.DOWNLOADING, done.addAndGet(it), archive.size))
            }
            downloadedBytes += archive.size
            downloadedFiles += 1
            usedArchive = true
            extractFromArchive(zip, manifest, missing, blobs, have)
            Files.deleteIfExists(zip)
        }
        val toFetch = missing.filterKeys { it !in have }
        if (toFetch.isNotEmpty()) {
            val total = toFetch.values.sum()
            val done = AtomicLong()
            val futures = toFetch.map { (sha, size) ->
                pool.submit<Unit> {
                    val out = blobs.resolve(sha)
                    http.download(update.filesUrlTemplate.replace("{sha256}", sha), out, size, sha) {
                        listener?.onProgress(PrepareProgress(PreparePhase.DOWNLOADING, done.addAndGet(it), total))
                    }
                }
            }
            awaitAll(futures)
            toFetch.keys.forEach { have[it] = blobs.resolve(it) }
            downloadedBytes += total
            downloadedFiles += toFetch.size
        }

        // 4. Assemble: regular files, then symlinks, then modes.
        val stagedRoot = stagingDir.resolve(manifest.root)
        Files.createDirectories(stagedRoot)
        val remainingUses = manifest.files.filter { it.sha256 in have }.groupingBy { it.sha256 }.eachCount().toMutableMap()
        var assembled = 0L
        for (entry in manifest.files) {
            val dest = stagedRoot.resolve(entry.path)
            Files.createDirectories(dest.parent)
            val blob = have[entry.sha256]
            if (blob != null) {
                val left = remainingUses.merge(entry.sha256, -1) { a, b -> a + b }!!
                if (left == 0) Files.move(blob, dest, StandardCopyOption.REPLACE_EXISTING) else Files.copy(blob, dest)
            } else {
                copyFile(local.getValue(entry.sha256), dest)
            }
            assembled += entry.size
            listener?.onProgress(PrepareProgress(PreparePhase.ASSEMBLING, assembled, manifest.totalSize))
        }
        for (link in manifest.links) {
            val dest = stagedRoot.resolve(link.path)
            Files.createDirectories(dest.parent)
            Files.createSymbolicLink(dest, Paths.get(link.link))
        }

        // 5. Check the whole tree (hashes before modes: a "400" or "000" file must still be readable),
        // then write the receipt beside (not inside) the root.
        verifyTree(stagedRoot, manifest, pool, listener)
        if (Platform.posix) {
            for (entry in manifest.files) {
                val file = stagedRoot.resolve(entry.path)
                val wanted = modeString(entry.mode)
                Files.setPosixFilePermissions(file, PosixFilePermissions.fromString(wanted))
                val mode = PosixFilePermissions.toString(Files.getPosixFilePermissions(file, LinkOption.NOFOLLOW_LINKS))
                if (mode != wanted) throw IntegrityException("'${entry.path}' has mode $mode, expected $wanted")
            }
        }
        val reused = manifest.files.count { it.sha256 in local }
        val receipt = buildJsonObject {
            put("schema", 1)
            put("release_id", update.release.id)
            put("version", update.release.version)
            put("version_code", update.release.versionCode)
            put("force_update", update.release.forceUpdate)
            put("notes_url", update.release.notesUrl?.let { JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull)
            put("target", manifest.target)
            put("root", manifest.root)
            put("manifest_sha256", manifestSha)
            put("file_count", manifest.files.size + manifest.links.size)
            put("total_size", manifest.totalSize)
            put("prepared_at", System.currentTimeMillis())
        }
        writeAtomically(stagingDir.resolve(RECEIPT), receipt.toString())
        return PreparedUpdate(
            release = update.release,
            stagedRoot = stagedRoot,
            manifestSha256 = manifestSha,
            fileCount = manifest.files.size + manifest.links.size,
            totalBytes = manifest.totalSize,
            reusedFiles = reused,
            downloadedFiles = downloadedFiles,
            downloadedBytes = downloadedBytes,
            usedFullArchive = usedArchive,
        )
    }

    /** sha256 -> an installed regular file with those bytes, among files at a manifest path with the manifest size. */
    private fun findLocalCopies(
        manifest: DesktopManifest,
        pool: java.util.concurrent.ExecutorService,
        listener: ProgressListener?,
    ): Map<String, Path> {
        if (!Files.isDirectory(installRoot)) return emptyMap()
        val realRoot = installRoot.toRealPath()
        val candidates = manifest.files.mapNotNull { entry ->
            val path = realRoot.resolve(entry.path)
            // The real path must be the path itself: no symlinked directory on the way, same letter case.
            val ok = try {
                Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) &&
                    Files.size(path) == entry.size &&
                    path.toRealPath().toString() == path.toString()
            } catch (_: IOException) {
                false
            }
            if (ok) entry to path else null
        }.distinctBy { it.first.sha256 to it.second }
        val total = candidates.sumOf { it.first.size }
        val done = AtomicLong()
        val found = java.util.concurrent.ConcurrentHashMap<String, Path>()
        awaitAll(candidates.map { (entry, path) ->
            pool.submit<Unit> {
                if (!found.containsKey(entry.sha256)) {
                    val digest = try { sha256Of(path) } catch (_: IOException) { null }
                    if (digest == entry.sha256) found.putIfAbsent(entry.sha256, path)
                }
                listener?.onProgress(PrepareProgress(PreparePhase.COMPARING, done.addAndGet(entry.size), total))
                Unit
            }
        })
        return found
    }

    /**
     * Take the still-missing digests out of the verified archive. Contents come from the
     * archive; paths, modes and links always come from the manifest, so a zip entry's own
     * name, attributes or symlink flag never decide what is written where.
     */
    private fun extractFromArchive(
        zip: Path,
        manifest: DesktopManifest,
        missing: Map<String, Long>,
        blobs: Path,
        have: MutableMap<String, Path>,
    ) {
        val byPath = manifest.files.associateBy { DesktopManifest.pathKey(it.path, target) }
        ZipFile(zip.toFile()).use { archive ->
            for (zipEntry in archive.entries()) {
                if (zipEntry.isDirectory) continue
                val name = zipEntry.name
                val rel = if (name.startsWith(manifest.root + "/")) name.substring(manifest.root.length + 1) else name
                val entry = byPath[DesktopManifest.pathKey(rel, target)] ?: continue
                if (entry.sha256 in have || entry.sha256 !in missing) continue
                if (zipEntry.size >= 0 && zipEntry.size != entry.size) continue
                val out = blobs.resolve(entry.sha256)
                val (got, digest) = try {
                    archive.getInputStream(zipEntry).use { copyHashing(it, out, entry.size) {} }
                } catch (_: IntegrityException) {
                    Files.deleteIfExists(out); continue
                }
                if (got == entry.size && digest == entry.sha256) have[entry.sha256] = out else Files.deleteIfExists(out)
            }
        }
    }

    private fun verifyTree(
        stagedRoot: Path,
        manifest: DesktopManifest,
        pool: java.util.concurrent.ExecutorService,
        listener: ProgressListener?,
    ) {
        val norm: (String) -> String = { if (Platform.os == "darwin") Normalizer.normalize(it, Normalizer.Form.NFC) else it }
        val files = manifest.files.associateBy { norm(it.path) }
        val links = manifest.links.associateBy { norm(it.path) }
        val dirs = HashSet<String>()
        (manifest.files.map { it.path } + manifest.links.map { it.path }).forEach { path ->
            val segments = path.split('/')
            for (depth in 1 until segments.size) dirs += norm(segments.subList(0, depth).joinToString("/"))
        }
        val seenFiles = ArrayList<Pair<DesktopManifest.FileEntry, Path>>()
        val seen = HashSet<String>()
        Files.walkFileTree(stagedRoot, object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (dir != stagedRoot) {
                    val rel = norm(rel(stagedRoot, dir))
                    if (rel !in dirs) throw IntegrityException("staged tree has an extra directory '$rel'")
                }
                return FileVisitResult.CONTINUE
            }

            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                val rel = norm(rel(stagedRoot, file))
                seen += rel
                when {
                    attrs.isSymbolicLink -> {
                        val link = links[rel] ?: throw IntegrityException("staged tree has an unexpected symlink '$rel'")
                        val actual = Files.readSymbolicLink(file).toString()
                        if (actual != link.link) throw IntegrityException("'$rel' links to '$actual', expected '${link.link}'")
                    }
                    attrs.isRegularFile -> {
                        val entry = files[rel] ?: throw IntegrityException("staged tree has an extra file '$rel'")
                        if (attrs.size() != entry.size) throw IntegrityException("'$rel' has ${attrs.size()} bytes, expected ${entry.size}")
                        seenFiles += entry to file
                    }
                    else -> throw IntegrityException("staged tree has an unexpected entry '$rel'")
                }
                return FileVisitResult.CONTINUE
            }
        })
        val absent = (files.keys + links.keys).filter { it !in seen }
        if (absent.isNotEmpty()) throw IntegrityException("staged tree lacks ${absent.size} entries, e.g. '${absent.first()}'")
        val done = AtomicLong()
        awaitAll(seenFiles.map { (entry, file) ->
            pool.submit<Unit> {
                val digest = sha256Of(file)
                if (digest != entry.sha256) throw IntegrityException("'${entry.path}' has SHA-256 $digest, expected ${entry.sha256}")
                listener?.onProgress(PrepareProgress(PreparePhase.VERIFYING, done.addAndGet(entry.size), manifest.totalSize))
                Unit
            }
        })
    }

    companion object {
        const val RECEIPT = ".hands-prepared.json"

        fun rel(root: Path, path: Path): String = root.relativize(path).joinToString("/") { it.toString() }

        fun modeString(octal: String): String {
            val bits = "rwx"
            return octal.map { c ->
                val v = c - '0'
                (0..2).joinToString("") { i -> if (v and (4 shr i) != 0) bits[i].toString() else "-" }
            }.joinToString("")
        }

        fun awaitAll(futures: List<Future<*>>) {
            try {
                for (future in futures) future.get()
            } catch (e: ExecutionException) {
                futures.forEach { it.cancel(true) }
                throw e.cause ?: e
            }
        }
    }
}
