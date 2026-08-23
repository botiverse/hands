package build.hands.update.installer

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import androidx.core.content.FileProvider
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ApkInstallerPlatformTest {
    private val targetContext: Context = ApplicationProvider.getApplicationContext()
    private val authority = "${targetContext.packageName}.hands.fileprovider"

    @Test
    fun platformGateRunsOnAndroid12() {
        assertEquals(Build.VERSION_CODES.S, Build.VERSION.SDK_INT)
    }

    @Test
    fun appScopedDownloadManagerFileUsesMergedFileProviderAndReadOnlyInstallerGrant() {
        val downloadDir = requireNotNull(
            targetContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
        )
        val apk = File(downloadDir, "hands-platform-${System.nanoTime()}.apk")
        apk.writeBytes(byteArrayOf(0x50, 0x4b))

        try {
            val provider = targetContext.packageManager.resolveContentProvider(
                authority,
                PackageManager.GET_META_DATA,
            )
            assertNotNull(provider)
            assertFalse(provider!!.exported)
            assertTrue(provider.grantUriPermissions)

            val capturingContext = CapturingContext(targetContext)
            val result = handleCompletedDownload(
                expectedDownloadId = 42L,
                completedDownloadId = 42L,
                downloadedUri = { apk.toURI().toString() },
                fileProviderUri = {
                    FileProvider.getUriForFile(targetContext, authority, it).toString()
                },
                launchInstaller = {
                    triggerApkInstall(capturingContext, Uri.parse(it))
                },
            )

            assertEquals(DownloadInstallResult.INSTALL_STARTED, result)
            assertEquals(1, capturingContext.startedActivities.size)
            val expectedUri = requireNotNull(capturingContext.startedActivities.single().data)
            assertEquals("content", expectedUri.scheme)
            assertEquals(authority, expectedUri.authority)
            assertTrue(expectedUri.path.orEmpty().startsWith("/hands_downloads/"))
            assertReadOnlyInstallIntent(capturingContext.startedActivities.single(), expectedUri)
        } finally {
            apk.delete()
        }
    }

    @Test
    fun reconstructedDeltaCacheUsesTheSameReadOnlyInstallerContract() {
        val apk = File(targetContext.cacheDir, "hands-delta-${System.nanoTime()}.apk")
        apk.writeBytes(byteArrayOf(0x50, 0x4b))

        try {
            val capturingContext = CapturingContext(targetContext)
            ApkInstaller(capturingContext).installLocalApk(apk)

            assertEquals(1, capturingContext.startedActivities.size)
            val expectedUri = requireNotNull(capturingContext.startedActivities.single().data)
            assertEquals("content", expectedUri.scheme)
            assertEquals(authority, expectedUri.authority)
            assertTrue(expectedUri.path.orEmpty().startsWith("/hands_delta_cache/"))
            assertReadOnlyInstallIntent(capturingContext.startedActivities.single(), expectedUri)
        } finally {
            apk.delete()
        }
    }

    @Test
    fun DownloadManagerContentUriPassesThroughWithReadOnlyInstallerGrant() {
        val downloadedUri = Uri.parse("content://downloads/all_downloads/42")
        var fileProviderCalled = false
        val resolved = resolveDownloadedApkContentUri(downloadedUri.toString()) {
            fileProviderCalled = true
            error("FileProvider must not resolve an existing content URI")
        }

        assertEquals(downloadedUri.toString(), resolved)
        assertFalse(fileProviderCalled)

        val capturingContext = CapturingContext(targetContext)
        triggerApkInstall(capturingContext, Uri.parse(requireNotNull(resolved)))

        assertEquals(1, capturingContext.startedActivities.size)
        assertReadOnlyInstallIntent(capturingContext.startedActivities.single(), downloadedUri)
    }

    @Test
    fun outsideRootAndUnsafeSchemesNeverLaunchInstaller() {
        val outsideRoot = File(
            targetContext.filesDir,
            "hands-outside-root-${System.nanoTime()}.apk",
        )
        outsideRoot.writeBytes(byteArrayOf(0x50, 0x4b))
        val capturingContext = CapturingContext(targetContext)
        var failure: Exception? = null

        try {
            val result = handleCompletedDownload(
                expectedDownloadId = 42L,
                completedDownloadId = 42L,
                downloadedUri = { outsideRoot.toURI().toString() },
                fileProviderUri = {
                    FileProvider.getUriForFile(targetContext, authority, it).toString()
                },
                launchInstaller = {
                    triggerApkInstall(capturingContext, Uri.parse(it))
                },
                onFailure = { failure = it },
            )

            assertEquals(DownloadInstallResult.INSTALL_FAILED, result)
            assertTrue(failure is IllegalArgumentException)
            assertTrue(capturingContext.startedActivities.isEmpty())

            triggerApkInstall(capturingContext, Uri.fromFile(outsideRoot))
            triggerApkInstall(capturingContext, Uri.parse("https://example.test/update.apk"))
            assertTrue(capturingContext.startedActivities.isEmpty())
        } finally {
            outsideRoot.delete()
        }
    }

    private fun assertReadOnlyInstallIntent(intent: Intent, expectedUri: Uri) {
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(expectedUri, intent.data)
        assertEquals("application/vnd.android.package-archive", intent.type)
        assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertFalse(intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
    }

    private class CapturingContext(base: Context) : ContextWrapper(base) {
        val startedActivities = mutableListOf<Intent>()

        override fun startActivity(intent: Intent) {
            startedActivities += Intent(intent)
        }
    }
}
