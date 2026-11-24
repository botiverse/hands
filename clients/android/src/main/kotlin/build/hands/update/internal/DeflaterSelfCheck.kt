package build.hands.update.internal

import com.google.archivepatcher.shared.IDeflater
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.function.BiFunction

/**
 * Proves, before any patch is downloaded, that a deflater reproduces stock
 * zlib's raw-deflate output byte-for-byte.
 *
 * A file-by-file delta patch is only usable when the device recompresses each
 * APK entry exactly as the patch generator (a JVM on stock zlib) did. The check
 * compresses a fixed built-in sample and compares the SHA-256 of each output
 * with constants computed by stock zlib 1.3.1 (the vendored sources, built on
 * the host). Any mismatch or error means the patch would rebuild the wrong APK,
 * so the caller downloads the full APK instead.
 */
internal object DeflaterSelfCheck {
    private const val TEXT_BYTES = 4 * 1024
    const val SAMPLE_BYTES = 40 * 1024

    /** SHA-256 of [sample]; pins the generator so the constants below stay meaningful. */
    const val SAMPLE_SHA256 = "cac329af5e7f3371e67f079f6880d11b17085eef82caa21b3a008129401f3333"

    internal class Case(val level: Int, val strategy: Int, val expectedSha256: String)

    /**
     * Raw deflate (nowrap, memLevel 8) of [sample] by stock zlib (1.2.13 and
     * 1.3.1 agree). Chromium's zlib (Android 12+) produces different bytes for
     * every one of these.
     */
    internal val CASES = listOf(
        Case(6, BundledZlibDeflater.DEFAULT_STRATEGY, "17d1d3d038386856fb3ed23d7fdb5333aacac3fefe170b8b4595f26e7e29c298"),
        Case(9, BundledZlibDeflater.DEFAULT_STRATEGY, "3cdd22413d9407df7453834c36798e2b18763a86d2d57d32756c8ea3d365dc1c"),
        Case(6, BundledZlibDeflater.FILTERED, "542f68ff54ab43d3b6208cd787682b547d178eec75a93e767d4a5d1b27c73634"),
    )

    private val WORDS = arrayOf(
        "update", "install", "package", "version", "release", "channel", "signature",
        "the", "a", "of", "and", "to", "in", "is", "for", "with", "on", "that", "this",
        "device", "archive", "entry", "compressed", "deflate", "window", "match", "length",
        "android", "manifest", "resources", "classes", "dex", "native", "library", "asset",
        "build", "hands", "delta", "patch", "apply", "verify", "sha256", "bytes", "stream",
    )

    /**
     * A deterministic sample driven by one fixed linear congruential generator:
     * [TEXT_BYTES] of pseudo-text (words, numbers, punctuation) followed by
     * binary-looking data (little-endian table records, zero runs, short random
     * runs) like the native libraries and fonts inside an APK. The binary part
     * builds the long hash chains where the two zlibs' match finders diverge.
     */
    fun sample(): ByteArray {
        var seed = 0x48414e44L // "HAND"
        fun next(): Int {
            seed = (seed * 1103515245L + 12345L) and 0x7fffffffL
            return (seed ushr 8).toInt()
        }

        val text = StringBuilder(TEXT_BYTES + 32)
        var wordsInLine = 0
        while (text.length < TEXT_BYTES) {
            val r = next()
            when (r % 11) {
                0 -> text.append(r % 100000)
                1 -> text.append(WORDS[r % WORDS.size].uppercase())
                else -> text.append(WORDS[r % WORDS.size])
            }
            wordsInLine++
            val sep = next() % 23
            text.append(
                when {
                    wordsInLine >= 12 || sep == 0 -> {
                        wordsInLine = 0
                        ".\n"
                    }
                    sep == 1 -> ", "
                    sep == 2 -> " = "
                    sep == 3 -> "/"
                    else -> " "
                }
            )
        }
        val out = ByteArrayOutputStream(SAMPLE_BYTES + 64)
        out.write(text.substring(0, TEXT_BYTES).toByteArray(Charsets.US_ASCII))
        fun writeLe(value: Int, bytes: Int) {
            for (i in 0 until bytes) out.write((value ushr (8 * i)) and 0xff)
        }
        while (out.size() < SAMPLE_BYTES) {
            val r = next()
            when (r % 8) {
                0, 1, 2, 3, 4 -> {
                    writeLe(out.size() / 16, 4)
                    writeLe(next() and 0xffff, 4)
                    writeLe(r % 7, 2)
                    writeLe(0, 4)
                    writeLe(0, 2)
                }
                5, 6 -> repeat(next() % 64) { out.write(0) }
                else -> {
                    val count = next() % 16
                    repeat(count) { out.write(next() and 0xff) }
                }
            }
        }
        return out.toByteArray().copyOf(SAMPLE_BYTES)
    }

    /** True only if every case matches. Never throws. */
    fun passes(factory: BiFunction<Int, Boolean, IDeflater>): Boolean = try {
        val input = sample()
        CASES.all { case -> sha256Hex(compress(factory, case.level, case.strategy, input)) == case.expectedSha256 }
    } catch (_: Throwable) {
        false
    }

    /**
     * Compresses [input] the way archive-patcher's DeflateCompressor does
     * (factory, setStrategy, setInput, finish, deflate until finished), with a
     * small output buffer so the stream is driven through many calls.
     */
    internal fun compress(
        factory: BiFunction<Int, Boolean, IDeflater>,
        level: Int,
        strategy: Int,
        input: ByteArray,
    ): ByteArray {
        val deflater = factory.apply(level, true)
        try {
            deflater.setStrategy(strategy)
            deflater.setInput(input)
            deflater.finish()
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(509)
            var calls = 0
            while (!deflater.finished()) {
                // Stored-block worst case is ~input size; anything far beyond is a broken deflater.
                if (++calls > MAX_DEFLATE_CALLS) throw IllegalStateException("deflater made no progress")
                val n = deflater.deflate(buffer)
                out.write(buffer, 0, n)
            }
            return out.toByteArray()
        } finally {
            deflater.end()
        }
    }

    internal fun sha256Hex(bytes: ByteArray): String =
        DeltaUpdater.toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private const val MAX_DEFLATE_CALLS = 4 * SAMPLE_BYTES / 509 + 64
}
