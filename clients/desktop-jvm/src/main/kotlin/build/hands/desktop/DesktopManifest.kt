package build.hands.desktop

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import java.text.Normalizer
import java.util.Locale

/**
 * The manifest of one target of one build, validated with the rules of
 * worker/src/lib/desktop_manifest.ts and desktop_paths.ts. Keep the three in step:
 * Hands refuses to publish what this refuses, so a refusal here means the bytes are
 * not what Hands published.
 */
internal data class DesktopManifest(
    val target: String,
    val root: String,
    val files: List<FileEntry>,
    val links: List<LinkEntry>,
    val totalSize: Long,
) {
    data class FileEntry(val path: String, val sha256: String, val size: Long, val mode: String)
    data class LinkEntry(val path: String, val link: String)

    companion object {
        const val SCHEMA = 1
        const val MAX_BYTES = 8 * 1024 * 1024
        const val FILE_MAX_BYTES = 5L * 1024 * 1024 * 1024
        private const val MAX_PATH_LENGTH = 1024
        private const val MAX_ENTRIES = 100_000
        private const val MAX_LINK_HOPS = 40

        val TARGETS = listOf("darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64")

        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val MODE = Regex("^[0-7]{3}$")
        private val DRIVE = Regex("^[A-Za-z]:")
        private val WIN_RESERVED = Regex("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\..*)?$", RegexOption.IGNORE_CASE)
        private val WIN_FORBIDDEN = Regex("[<>:\"|?*]")
        private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

        fun isSha256(value: String): Boolean = SHA256.matches(value)

        fun parse(bytes: ByteArray, expectedTarget: String): DesktopManifest {
            if (bytes.size > MAX_BYTES) fail("manifest exceeds $MAX_BYTES bytes")
            val text = try {
                Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
            } catch (e: java.nio.charset.CharacterCodingException) {
                fail("manifest is not valid UTF-8 JSON")
            }
            val element = try {
                Json.parseToJsonElement(text.removePrefix("﻿"))
            } catch (e: Exception) {
                fail("manifest is not valid UTF-8 JSON")
            }
            return validate(element, expectedTarget)
        }

        fun validate(raw: JsonElement, expectedTarget: String): DesktopManifest {
            val doc = raw as? JsonObject ?: fail("manifest must be a JSON object")
            if (doc["schema"].asLong() != SCHEMA.toLong()) fail("schema must be $SCHEMA")
            val target = doc["target"].asString()
            if (target == null || target !in TARGETS) fail("target must be one of ${TARGETS.joinToString(", ")}")
            if (target != expectedTarget) fail("target '$target' does not match the requested target '$expectedTarget'")
            val root = checkRelativePath(doc["root"], "root", null)
            if (root.contains('/')) fail("root must be a single path segment")
            segmentProblem(root, target)?.let { fail("root $it") }
            val rawFiles = doc["files"] as? JsonArray
            if (rawFiles == null || rawFiles.isEmpty()) fail("files must be a non-empty array")
            if (rawFiles.size > MAX_ENTRIES) fail("files has more than $MAX_ENTRIES entries")

            val files = ArrayList<FileEntry>()
            val links = ArrayList<LinkEntry>()
            val digests = HashMap<String, Long>()
            val seen = HashSet<String>()
            val entries = ArrayList<Pair<String, String?>>()
            var totalSize = 0L
            rawFiles.forEachIndexed { index, entry ->
                val item = entry as? JsonObject ?: fail("entry must be an object", index)
                val path = checkRelativePath(item["path"], "path", index)
                if (!seen.add(path)) fail("duplicate path '$path'", index)
                val link = item["link"]
                if (link != null && link !is JsonNull) {
                    val sha = item["sha256"]
                    if (sha != null && sha !is JsonNull) fail("a symlink entry carries no sha256", index)
                    val target0 = checkLinkTarget(link, index)
                    links += LinkEntry(path, target0)
                    entries += path to target0
                    return@forEachIndexed
                }
                val sha = item["sha256"].asString()
                if (sha == null || !isSha256(sha)) fail("sha256 must be 64 lowercase hexadecimal characters", index)
                val size = item["size"].asLong()
                if (size == null || size < 0 || size > FILE_MAX_BYTES) fail("size must be an integer 0-$FILE_MAX_BYTES", index)
                val known = digests[sha]
                if (known != null && known != size) fail("sha256 $sha is declared with two different sizes", index)
                digests[sha] = size
                totalSize += size
                val mode = item["mode"].asString()
                if (mode == null || !MODE.matches(mode)) {
                    fail("mode must be three octal digits such as \"644\" or \"755\"", index)
                }
                files += FileEntry(path, sha, size, mode)
                entries += path to null
            }
            checkBundleEntries(target, entries)
            val declaredTotal = doc["total_size"]
            if (declaredTotal != null && declaredTotal.asLong() != totalSize) {
                fail("total_size $declaredTotal does not equal the sum of file sizes $totalSize")
            }
            return DesktopManifest(target, root, files, links, totalSize)
        }

        /** The key two paths collide on: case- and normalisation-insensitive on darwin and win32. */
        fun pathKey(path: String, target: String): String =
            if (target.startsWith("linux-")) path
            else Normalizer.normalize(path, Normalizer.Form.NFC).lowercase(Locale.ROOT)

        fun segmentProblem(segment: String, target: String): String? {
            if (CONTROL.containsMatchIn(segment)) return "contains a control character"
            if (!target.startsWith("win32-")) return null
            if (WIN_FORBIDDEN.containsMatchIn(segment)) return "contains a character Windows does not allow (< > : \" | ? *)"
            if (segment.endsWith('.') || segment.endsWith(' ')) return "ends with a dot or a space, which Windows strips"
            if (WIN_RESERVED.matches(segment)) return "is a reserved Windows device name"
            return null
        }

        private fun checkRelativePath(value: JsonElement?, field: String, index: Int?): String {
            val s = value.asString()
            if (s.isNullOrEmpty()) fail("$field must be a non-empty string", index)
            if (s.length > MAX_PATH_LENGTH) fail("$field is too long", index)
            if (s.contains('\\')) fail("$field must use '/' separators", index)
            if (s.contains('\u0000')) fail("$field contains NUL", index)
            if (s.startsWith("/") || DRIVE.containsMatchIn(s)) fail("$field must be relative", index)
            for (segment in s.split('/')) {
                if (segment == "" || segment == "." || segment == "..") {
                    fail("$field has an empty, '.' or '..' segment", index)
                }
            }
            return s
        }

        private fun checkLinkTarget(value: JsonElement, index: Int): String {
            val s = value.asString()
            if (s.isNullOrEmpty()) fail("link must be a non-empty string", index)
            if (s.length > MAX_PATH_LENGTH) fail("link is too long", index)
            if (s.contains('\\') || s.contains('\u0000')) fail("link must use '/' separators and contain no NUL", index)
            if (s.startsWith("/") || DRIVE.containsMatchIn(s)) fail("link must be relative", index)
            return s
        }

        /** Collisions, nesting under a file or link, and links resolving (through other links) outside the root. */
        private fun checkBundleEntries(target: String, entries: List<Pair<String, String?>>) {
            val keys = HashMap<String, Int>()
            val linkByKey = HashMap<String, String>()
            entries.forEachIndexed { index, (path, link) ->
                for (segment in path.split('/')) {
                    segmentProblem(segment, target)?.let { fail("'$path': segment '$segment' $it", index) }
                }
                val key = pathKey(path, target)
                val other = keys[key]
                if (other != null) fail("'$path' is the same path as '${entries[other].first}' on $target", index)
                keys[key] = index
                if (link != null) linkByKey[key] = link
            }
            entries.forEachIndexed { index, (path, _) ->
                val segments = path.split('/')
                for (depth in 1 until segments.size) {
                    val at = keys[pathKey(segments.subList(0, depth).joinToString("/"), target)]
                    if (at != null) fail("'$path' is nested under the file or symlink '${entries[at].first}'", index)
                }
            }
            fun resolve(base: List<String>, link: String, hops: IntArray, index: Int): List<String> {
                var current = base
                for (segment in link.split('/')) {
                    if (segment == "" || segment == ".") continue
                    if (segment == "..") {
                        if (current.isEmpty()) fail("link resolves outside the bundle root", index)
                        current = current.dropLast(1)
                        continue
                    }
                    segmentProblem(segment, target)?.let { fail("link segment '$segment' $it", index) }
                    current = current + segment
                    val next = linkByKey[pathKey(current.joinToString("/"), target)]
                    if (next != null) {
                        hops[0] += 1
                        if (hops[0] > MAX_LINK_HOPS) fail("link chain is too long or loops", index)
                        current = resolve(current.dropLast(1), next, hops, index)
                    }
                }
                return current
            }
            entries.forEachIndexed { index, (path, link) ->
                if (link != null) resolve(path.split('/').dropLast(1), link, intArrayOf(0), index)
            }
        }

        private fun JsonElement?.asString(): String? =
            (this as? JsonPrimitive)?.takeIf { it.isString }?.content

        /** A JSON integer (also `5.0`, which JavaScript treats as the same number). */
        private fun JsonElement?.asLong(): Long? {
            val p = this as? JsonPrimitive ?: return null
            if (p.isString) return null
            p.content.toLongOrNull()?.let { return it }
            val d = p.content.toDoubleOrNull() ?: return null
            return if (d == Math.floor(d) && Math.abs(d) <= 9007199254740991.0) d.toLong() else null
        }

        private fun fail(message: String, index: Int? = null): Nothing =
            throw ManifestInvalidException(if (index == null) message else "files[$index]: $message")
    }
}
