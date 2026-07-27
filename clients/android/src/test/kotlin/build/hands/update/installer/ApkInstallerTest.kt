package build.hands.update.installer

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ApkInstallerTest {
    @Test
    fun `DownloadManager read exception cannot prove absence and later active read recovers`() {
        var reads = 0
        val first = readDownloadStatus {
            reads += 1
            throw IllegalStateException("binder unavailable")
        }
        val second = readDownloadStatus {
            reads += 1
            ApkDownloadStatus(DownloadState.RUNNING, downloadedBytes = 10, totalBytes = 100)
        }

        assertEquals(DownloadState.READ_UNAVAILABLE, first.state)
        assertEquals(DownloadState.RUNNING, second.state)
        assertEquals(2, reads)
    }

    @Test
    fun `null cursor and unknown status cannot prove DownloadManager absence`() {
        assertEquals(
            DownloadState.READ_UNAVAILABLE,
            readDownloadStatus { null }.state,
        )
        assertEquals(DownloadState.UNKNOWN, downloadStateFromRawStatus(Int.MAX_VALUE))
        assertEquals(
            DownloadState.MISSING,
            readDownloadStatus { ApkDownloadStatus(DownloadState.MISSING) }.state,
        )
    }

    @Test
    fun `DownloadManager file URI converts through FileProvider before installer launch`() {
        val expectedContentUri =
            "content://build.raft.app.alpha.hands.fileprovider/hands_downloads/update.apk"
        var providerFile: File? = null
        var launchedUri: String? = null

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = {
                "file:///storage/emulated/0/Android/data/build.raft.app.alpha/files/Download/update.apk"
            },
            fileProviderUri = {
                providerFile = it
                expectedContentUri
            },
            launchInstaller = { launchedUri = it },
        )

        assertEquals(DownloadInstallResult.INSTALL_STARTED, result)
        assertEquals(
            File(
                "/storage/emulated/0/Android/data/build.raft.app.alpha/files/Download/update.apk"
            ),
            providerFile,
        )
        assertEquals(expectedContentUri, launchedUri)
    }

    @Test
    fun `DownloadManager content URI launches installer with the exact URI`() {
        val expectedUri = "content://downloads/all_downloads/42"
        var launchedUri: String? = null
        var fileProviderCalled = false

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = { expectedUri },
            fileProviderUri = {
                fileProviderCalled = true
                "content://unused"
            },
            launchInstaller = { launchedUri = it },
        )

        assertEquals(DownloadInstallResult.INSTALL_STARTED, result)
        assertEquals(expectedUri, launchedUri)
        assertFalse(fileProviderCalled)
    }

    @Test
    fun `unrelated completion never resolves or launches an APK`() {
        var resolved = false
        var launched = false

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 41L,
            downloadedUri = {
                resolved = true
                "content://downloads/all_downloads/41"
            },
            fileProviderUri = { "content://unused" },
            launchInstaller = { launched = true },
        )

        assertEquals(DownloadInstallResult.IGNORED, result)
        assertFalse(resolved)
        assertFalse(launched)
    }

    @Test
    fun `receiver contains installer exceptions instead of crashing the host`() {
        val failure = IllegalStateException("installer unavailable")
        var captured: Exception? = null

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = { "content://downloads/all_downloads/42" },
            fileProviderUri = { "content://unused" },
            launchInstaller = { throw failure },
            onFailure = { captured = it },
        )

        assertEquals(DownloadInstallResult.INSTALL_FAILED, result)
        assertSame(failure, captured)
    }

    @Test
    fun `receiver also contains failure reporter exceptions`() {
        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = { "content://downloads/all_downloads/42" },
            fileProviderUri = { "content://unused" },
            launchInstaller = { throw IllegalStateException("installer unavailable") },
            onFailure = { throw IllegalStateException("logger unavailable") },
        )

        assertEquals(DownloadInstallResult.INSTALL_FAILED, result)
    }

    @Test
    fun `unsafe FileProvider output fails closed before installer launch`() {
        var launched = false

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = { "file:///storage/emulated/0/Download/update.apk" },
            fileProviderUri = { it.toURI().toString() },
            launchInstaller = { launched = true },
        )

        assertEquals(DownloadInstallResult.UNAVAILABLE_OR_UNSAFE_URI, result)
        assertFalse(launched)
    }

    @Test
    fun `FileProvider exceptions are contained by the receiver boundary`() {
        val failure = IllegalArgumentException("outside configured roots")
        var captured: Exception? = null

        val result = handleCompletedDownload(
            expectedDownloadId = 42L,
            completedDownloadId = 42L,
            downloadedUri = { "file:///storage/emulated/0/Download/update.apk" },
            fileProviderUri = { throw failure },
            launchInstaller = { error("must not launch") },
            onFailure = { captured = it },
        )

        assertEquals(DownloadInstallResult.INSTALL_FAILED, result)
        assertSame(failure, captured)
    }

    @Test
    fun `only authority-backed content URIs are accepted`() {
        assertEquals(
            "content://downloads/all_downloads/42",
            validatedApkContentUri("content://downloads/all_downloads/42"),
        )
        assertNull(validatedApkContentUri(null))
        assertNull(validatedApkContentUri(""))
        assertNull(validatedApkContentUri("content:missing-authority"))
        assertNull(validatedApkContentUri("file:///storage/emulated/0/Download/update.apk"))
        assertNull(validatedApkContentUri("https://example.test/update.apk"))
        assertNull(validatedApkContentUri("not a URI"))
    }

    @Test
    fun `installer intent contract grants read access and starts outside an Activity`() {
        val flags = apkInstallIntentFlags()

        assertTrue(flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertTrue(flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertFalse(flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0)
    }
}
