package build.hands.update

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UpdateTransactionPlatformTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun transactionRoundTripsInPrivatePreferencesAndSeparatesAuthorities() {
        val first = authority("main")
        val second = authority("preview")
        val firstStore = UpdateTransactionStore(context, first)
        val secondStore = UpdateTransactionStore(context, second)
        firstStore.clear()
        secondStore.clear()

        try {
            val record = record(first).copy(
                state = HandsUpdateState.DOWNLOADING,
                targetVersionCode = 1000011,
                downloadId = 42,
                localFilePath = context.getExternalFilesDir("Download")
                    ?.resolve("quiver-raft-1000011.apk")
                    ?.absolutePath,
            )
            firstStore.write(record)

            assertEquals(record, firstStore.read())
            assertNull(secondStore.read())
        } finally {
            firstStore.clear()
            secondStore.clear()
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun storeRejectsRecordFromAnotherAuthority() {
        val store = UpdateTransactionStore(context, authority("main"))
        try {
            store.write(record(authority("preview")))
        } finally {
            store.clear()
        }
    }

    private fun authority(channel: String) = UpdateAuthority(
        packageName = context.packageName,
        baseUrl = "https://hands.example.test",
        appSlug = "raft-android",
        channel = channel,
        productType = "android-apk",
        platform = "android",
        arch = "arm64-v8a",
    )

    private fun record(authority: UpdateAuthority) = UpdateTransactionRecord(
        packageName = authority.packageName,
        baseUrl = authority.canonicalBaseUrl,
        appSlug = authority.appSlug,
        channel = authority.channel,
        productType = authority.productType,
        platform = authority.platform,
        arch = authority.arch,
        state = HandsUpdateState.CHECKING,
    )
}
