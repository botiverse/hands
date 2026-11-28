package build.hands.update.internal

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.io.File
import java.security.MessageDigest

/**
 * SHA-256 of the installed base APK (`applicationInfo.sourceDir`), sent as
 * `X-Hands-Installed-Sha256` on the update check.
 *
 * One version code can ship as several APKs (a universal and an arm64-v8a
 * build), and a delta patch applies only to the exact APK it was made from.
 * With the hash the server offers the patch made from this APK, and the SDK
 * skips a patch whose `from_sha256` names another one.
 *
 * Hashing a 30-100 MB APK takes a moment, so the result is cached in
 * SharedPreferences under (versionCode, lastUpdateTime, file length): it is
 * computed once per install, off the main thread (callers run it on IO).
 * Any failure yields null and the header is simply not sent.
 */
internal object InstalledApkHash {
    private const val PREFS = "build.hands.update.installed_apk"
    private const val KEY_CACHE_KEY = "cache_key"
    private const val KEY_SHA256 = "sha256"
    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")
    private val lock = Any()

    /** Where the cached hash lives; SharedPreferences on device, a fake in tests. */
    internal interface Cache {
        fun read(): Pair<String, String>?
        fun write(key: String, sha256: String)
    }

    /** The hash for this install, or null if the APK cannot be read. Never throws; call off the main thread. */
    fun get(context: Context): String? = try {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val apk = File(context.applicationInfo.sourceDir)
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            packageInfo.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            packageInfo.versionCode.toLong()
        }
        resolve(
            cache = PreferencesCache(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)),
            key = cacheKey(versionCode, packageInfo.lastUpdateTime, apk.length()),
            apk = apk,
        )
    } catch (_: Throwable) {
        null
    }

    /** Identifies one install of one APK: an update or reinstall changes at least one part. */
    internal fun cacheKey(versionCode: Long, lastUpdateTime: Long, lengthBytes: Long): String =
        "$versionCode:$lastUpdateTime:$lengthBytes"

    /**
     * The cached hash when [key] matches, else [hash] of [apk], cached under
     * [key]. Null (and nothing cached) when the file cannot be hashed.
     */
    internal fun resolve(
        cache: Cache,
        key: String,
        apk: File,
        hash: (File) -> String = ::sha256Hex,
    ): String? = synchronized(lock) {
        try {
            cache.read()?.let { (cachedKey, cachedSha) ->
                if (cachedKey == key && SHA256_HEX.matches(cachedSha)) return@synchronized cachedSha
            }
        } catch (_: Throwable) {
            // An unreadable cache only costs a recompute.
        }
        val sha = try {
            if (!apk.isFile) return@synchronized null
            hash(apk).lowercase()
        } catch (_: Throwable) {
            return@synchronized null
        }
        if (!SHA256_HEX.matches(sha)) return@synchronized null
        try {
            cache.write(key, sha)
        } catch (_: Throwable) {
            // Not cached; the next check hashes again.
        }
        sha
    }

    internal fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return DeltaUpdater.toHex(digest.digest())
    }

    private class PreferencesCache(private val prefs: SharedPreferences) : Cache {
        override fun read(): Pair<String, String>? {
            val key = prefs.getString(KEY_CACHE_KEY, null) ?: return null
            val sha = prefs.getString(KEY_SHA256, null) ?: return null
            return key to sha
        }

        override fun write(key: String, sha256: String) {
            prefs.edit().putString(KEY_CACHE_KEY, key).putString(KEY_SHA256, sha256).apply()
        }
    }
}
