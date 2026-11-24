package build.hands.update

import android.app.DownloadManager
import build.hands.update.installer.ApkDownloadStatus
import build.hands.update.installer.DownloadState
import build.hands.update.internal.DeltaUpdater
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

class HandsUpdateProgressTest {
    @Test
    fun `running download reports bytes and percent`() {
        val progress = downloadProgress(
            ApkDownloadStatus(DownloadState.RUNNING, reason = 0, downloadedBytes = 250, totalBytes = 1000),
        )!!
        assertEquals(250L, progress.downloadedBytes)
        assertEquals(1000L, progress.totalBytes)
        assertEquals(25, progress.percent)
        assertFalse(progress.paused)
        assertNull(progress.pauseReason)
    }

    @Test
    fun `unknown total has no percent`() {
        val progress = downloadProgress(
            ApkDownloadStatus(DownloadState.PENDING, downloadedBytes = 0, totalBytes = -1),
        )!!
        assertNull(progress.totalBytes)
        assertNull(progress.percent)
    }

    @Test
    fun `paused download names why`() {
        val progress = downloadProgress(
            ApkDownloadStatus(
                DownloadState.PAUSED,
                reason = DownloadManager.PAUSED_WAITING_FOR_NETWORK,
                downloadedBytes = 10,
                totalBytes = 100,
            ),
        )!!
        assertTrue(progress.paused)
        assertEquals("waiting_for_network", progress.pauseReason)
        assertEquals("waiting_for_wifi", pauseReason(DownloadManager.PAUSED_QUEUED_FOR_WIFI))
        assertEquals("waiting_to_retry", pauseReason(DownloadManager.PAUSED_WAITING_TO_RETRY))
        assertEquals("unknown", pauseReason(null))
    }

    @Test
    fun `finished or unreadable downloads carry no progress`() {
        listOf(
            DownloadState.SUCCESSFUL,
            DownloadState.FAILED,
            DownloadState.MISSING,
            DownloadState.READ_UNAVAILABLE,
            DownloadState.UNKNOWN,
        ).forEach { assertNull(downloadProgress(ApkDownloadStatus(it, downloadedBytes = 1, totalBytes = 2))) }
    }

    @Test
    fun `percent stays within bounds`() {
        assertEquals(100, HandsUpdateProgress(downloadedBytes = 2000, totalBytes = 1000).percent)
        assertEquals(0, HandsUpdateProgress(downloadedBytes = -5, totalBytes = 1000).percent)
    }

    @Test
    fun `failed check reopens only an unchanged pending installer`() {
        val ready = HandsUpdateState.READY_TO_INSTALL
        val opened = HandsUpdateState.INSTALLER_OPENED
        assertTrue(shouldReopenAfterFailedCheck(ready, ready))
        assertTrue(shouldReopenAfterFailedCheck(opened, opened))
        assertFalse(shouldReopenAfterFailedCheck(ready, HandsUpdateState.STALE))
        assertFalse(shouldReopenAfterFailedCheck(HandsUpdateState.IDLE, HandsUpdateState.FAILED))
        assertFalse(shouldReopenAfterFailedCheck(HandsUpdateState.FAILED, ready))
    }

    @Test
    fun `install permission is only checked from Android 8`() {
        assertTrue(installPermissionGranted(25) { false })
        assertFalse(installPermissionGranted(26) { false })
        assertTrue(installPermissionGranted(34) { true })
    }

    @Test
    fun `active states are the ones that move bytes`() {
        val active = HandsUpdateState.entries.filter(::isActiveUpdateState).toSet()
        assertEquals(
            setOf(HandsUpdateState.CHECKING, HandsUpdateState.PATCHING, HandsUpdateState.DOWNLOADING),
            active,
        )
    }

    @Test
    fun `observers ignore timestamp-only changes`() {
        val a = HandsUpdateStatus(HandsUpdateState.DOWNLOADING, updatedAt = 1)
        assertTrue(sameStatusForObservers(a, a.copy(updatedAt = 2)))
        assertFalse(sameStatusForObservers(a, a.copy(progress = HandsUpdateProgress(1))))
    }

    @Test
    fun `stale sweep keeps active, current and newer downloads`() {
        val rows = listOf(
            SdkDownloadRow(1, DownloadState.SUCCESSFUL, "/d/installed.apk"),
            SdkDownloadRow(2, DownloadState.SUCCESSFUL, "/d/newer.apk"),
            SdkDownloadRow(3, DownloadState.FAILED, null),
            SdkDownloadRow(4, DownloadState.RUNNING, "/d/running.apk"),
            SdkDownloadRow(5, DownloadState.SUCCESSFUL, null),
            SdkDownloadRow(6, DownloadState.SUCCESSFUL, "/d/current.apk"),
            SdkDownloadRow(7, DownloadState.SUCCESSFUL, "/d/not-an-apk.apk"),
        )
        val versions = mapOf("/d/installed.apk" to 100L, "/d/newer.apk" to 101L, "/d/current.apk" to 90L)
        assertEquals(
            listOf(1L, 3L, 5L, 7L),
            staleSdkDownloadIds(rows, keepId = 6, installedVersionCode = 100, archiveVersionCode = versions::get),
        )
    }

    @Test
    fun `stale sweep keeps finished rows when the installed version is unknown`() {
        val rows = listOf(SdkDownloadRow(1, DownloadState.SUCCESSFUL, "/d/a.apk"))
        assertEquals(emptyList<Long>(), staleSdkDownloadIds(rows, null, null) { 5L })
    }

    @Test
    fun `only SDK update file names are swept`() {
        assertTrue(isSdkDownloadFileName("hands-update-123e4567-e89b-12d3-a456-426614174000.apk"))
        assertFalse(isSdkDownloadFileName("raft-hands-11601002.apk"))
        assertFalse(isSdkDownloadFileName("hands-update-x.apk"))
    }

    @Test
    fun `language tags accept POSIX spelling and drop non-languages`() {
        assertEquals("zh-CN", normalizedLanguageTag("zh_CN"))
        assertEquals("en", normalizedLanguageTag(" en "))
        assertNull(normalizedLanguageTag("system"))
        assertNull(normalizedLanguageTag("POSIX"))
        assertNull(normalizedLanguageTag("C"))
        assertNull(normalizedLanguageTag("C.UTF-8"))
    }

    @Test
    fun `patch copy reports throttled progress and the final count`() {
        val bytes = ByteArray(200_000) { it.toByte() }
        val reports = mutableListOf<Long>()
        val out = ByteArrayOutputStream()
        val copied = DeltaUpdater.copyWithProgress(
            ByteArrayInputStream(bytes),
            out,
            reportEveryBytes = 64L * 1024L,
            onProgress = reports::add,
        )
        assertEquals(200_000L, copied)
        assertEquals(bytes.toList(), out.toByteArray().toList())
        assertEquals(0L, reports.first())
        assertEquals(200_000L, reports.last())
        assertTrue(reports.size in 4..6)
        assertEquals(reports.sorted(), reports)
    }

    @Test
    fun `a patching record with no patch running in this process is abandoned`() {
        // Process killed mid-patch: the record survives, the patch does not.
        assertTrue(isPatchingAbandoned(activeInThisProcess = false, expired = false))
        assertTrue(isPatchingAbandoned(activeInThisProcess = true, expired = true))
        assertFalse(isPatchingAbandoned(activeInThisProcess = true, expired = false))
    }

    @Test
    fun `active patch registry tracks begin and end per authority`() {
        val key = "test-authority-active-patch"
        assertFalse(ActivePatchRegistry.isActive(key))
        ActivePatchRegistry.begin(key)
        assertTrue(ActivePatchRegistry.isActive(key))
        assertFalse(ActivePatchRegistry.isActive("$key-other"))
        assertTrue(ActivePatchRegistry.isAnyActive())
        ActivePatchRegistry.end(key)
        assertFalse(ActivePatchRegistry.isActive(key))
    }

    @Test
    fun `delta temp file names cover patch downloads and rebuilt apks only`() {
        assertTrue(isDeltaTempFileName("hands-delta-13000005-123456789.patch"))
        assertTrue(isDeltaTempFileName("hands-delta-raft-android-13000005-123456789.apk"))
        assertFalse(isDeltaTempFileName("hands-update-0f8fad5b-d9cb-469f-a165-70867728950e.apk"))
        assertFalse(isDeltaTempFileName("hands-delta-13000005.patch.tmp"))
        assertFalse(isDeltaTempFileName("other.patch"))
    }
}
