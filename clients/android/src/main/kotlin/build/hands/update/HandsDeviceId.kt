package build.hands.update

import android.content.Context
import java.util.UUID

/**
 * Stable per-install device identifier used for staged rollouts.
 *
 * The server buckets clients by hashing (release_id, device_id), so the id
 * only needs to be stable per install — a random UUID persisted in
 * SharedPreferences. It is not derived from hardware identifiers and resets
 * on reinstall / clear-data, which is acceptable for rollout cohorting.
 */
object HandsDeviceId {
    private const val PREFS_NAME = "quiver_update"
    private const val KEY_DEVICE_ID = "device_id"

    @Volatile
    private var cached: String? = null

    fun get(context: Context): String {
        cached?.let { return it }
        synchronized(this) {
            cached?.let { return it }
            val prefs = context.applicationContext
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (!existing.isNullOrBlank()) {
                cached = existing
                return existing
            }
            val created = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, created).apply()
            cached = created
            return created
        }
    }
}
