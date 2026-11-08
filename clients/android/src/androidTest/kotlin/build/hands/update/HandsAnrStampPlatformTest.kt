package build.hands.update

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Real process-exit records; the upload and actual ANR paths need separate tests. */
@RunWith(AndroidJUnit4::class)
class HandsAnrStampPlatformTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val testContext: Context = instrumentation.context
    private val manager = testContext.getSystemService(ActivityManager::class.java)

    @Test
    fun earlyStampIsRetainedForTheProcessThatExits() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        val summary = runProbe(optOut = false)
        val expected = HandsAnrBuildStamp.encode(HandsCrash.installedBuild(testContext))
        assertNotNull("The test APK must have an identifiable installed build", expected)
        assertArrayEquals(expected, summary)
        assertEquals(HandsCrash.installedBuild(testContext), HandsAnrBuildStamp.decode(summary))
    }

    @Test
    fun hostCanOptOutWithoutOverwritingItsProcessSummary() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
        assertArrayEquals(
            AnrStampProbeService.OTHER_SUMMARY.toByteArray(Charsets.UTF_8),
            runProbe(optOut = true),
        )
    }

    private fun runProbe(optOut: Boolean): ByteArray? {
        val previous = manager.getHistoricalProcessExitReasons(testContext.packageName, 0, 32)
            .map { it.pid to it.timestamp }.toSet()
        val intent = Intent(testContext, AnrStampProbeService::class.java)
            .putExtra(AnrStampProbeService.EXTRA_OPT_OUT, optOut)
        assertNotNull("Failed to start the isolated test service", testContext.startService(intent))

        val timeout = SystemClock.elapsedRealtime() + 20_000L
        do {
            val exit = manager.getHistoricalProcessExitReasons(testContext.packageName, 0, 32)
                .firstOrNull {
                    it.processName == "${testContext.packageName}:hands_anr_stamp_probe" &&
                        (it.pid to it.timestamp) !in previous
                }
            if (exit != null) return exit.processStateSummary
            SystemClock.sleep(200)
        } while (SystemClock.elapsedRealtime() < timeout)
        throw AssertionError("No exit record for the isolated test process")
    }
}
