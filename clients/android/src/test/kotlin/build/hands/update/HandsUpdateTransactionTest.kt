package build.hands.update

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HandsUpdateTransactionTest {
    private fun target(
        versionCode: Long = 1000011,
        buildId: String = "build-11",
        sha256: String = "a".repeat(64),
        sizeBytes: Long = 42,
        filetype: String = "apk",
        signature: String = "signature-11",
    ) = PendingInstallerTargetIdentity(
        versionCode = versionCode,
        buildId = buildId,
        sha256 = sha256,
        sizeBytes = sizeBytes,
        filetype = filetype,
        signature = signature,
    )

    @Test
    fun `wire states are stable lower-case constants`() {
        assertEquals(
            listOf(
                "idle",
                "checking",
                "patching",
                "downloading",
                "ready_to_install",
                "installer_opened",
                "failed",
                "stale",
                "installed",
            ),
            HandsUpdateState.entries.map { it.wireValue },
        )
    }

    @Test
    fun `locale resolution matches exact then language prefix and English fallback`() {
        val notes = linkedMapOf(
            "en" to "English",
            "zh-CN" to "中文",
            "ja" to "日本語",
        )

        assertEquals("zh-CN", resolveLanguageTag("zh-CN", notes))
        assertEquals("ja", resolveLanguageTag("ja-JP", notes))
        assertEquals("en", resolveLanguageTag(null, notes))
        assertEquals("en", resolveLanguageTag("de-DE", notes))
    }

    @Test
    fun `malformed locale is omitted instead of entering an HTTP header`() {
        assertEquals("zh-CN", normalizedLanguageTag(" zh-CN "))
        assertNull(normalizedLanguageTag(null))
        assertNull(normalizedLanguageTag(""))
        assertNull(normalizedLanguageTag("zh_CN"))
        assertNull(normalizedLanguageTag("en\r\nX-Injected: yes"))
    }

    @Test
    fun `public status serializes stable state and host telemetry fields`() {
        val status = HandsUpdateStatus(
            state = HandsUpdateState.READY_TO_INSTALL,
            targetVersionCode = 1000011,
            installedVersionCode = 1000010,
            retryable = false,
            targetBuildId = "build-11",
            assetSha256 = "a".repeat(64),
            requestedLanguageTag = "zh-CN",
            resolvedLanguageTag = "zh-CN",
            updatedAt = 1234,
        )

        val encoded = Json.encodeToString(status)
        assertTrue(encoded.contains("\"state\":\"ready_to_install\""))
        assertEquals(status, Json.decodeFromString<HandsUpdateStatus>(encoded))
    }

    @Test
    fun `authority storage keys separate channel and app identities`() {
        fun authority(app: String, channel: String) = UpdateAuthority(
            packageName = "build.raft.app.alpha",
            baseUrl = "https://hands.example.test/",
            appSlug = app,
            channel = channel,
            productType = "android-apk",
            platform = "android",
            arch = null,
        )

        assertEquals(authority("raft", "main").storageKey(), authority("raft", "main").storageKey())
        assertTrue(authority("raft", "main").storageKey() != authority("raft", "alpha").storageKey())
        assertTrue(authority("raft", "main").storageKey() != authority("other", "main").storageKey())
    }

    @Test
    fun `installer never opens when READY authority commit fails`() {
        var launched = false
        var openedPersisted = false

        val result = launchWithDurableInstallerAuthority(
            persistReady = { error("disk full") },
            launchInstaller = { launched = true },
            persistOpened = { openedPersisted = true },
        )

        assertEquals(DurableInstallerLaunchResult.READY_PERSIST_FAILED, result)
        assertTrue(!launched)
        assertTrue(!openedPersisted)
    }

    @Test
    fun `OPENED commit failure retains the durable READY authority`() {
        val order = mutableListOf<String>()

        val result = launchWithDurableInstallerAuthority(
            persistReady = { order += "ready" },
            launchInstaller = { order += "launch" },
            persistOpened = {
                order += "opened"
                error("commit failed")
            },
        )

        assertEquals(DurableInstallerLaunchResult.OPENED_WITH_READY_AUTHORITY, result)
        assertEquals(listOf("ready", "launch", "opened"), order)
    }

    @Test
    fun `same authority gate prevents stale reconcile from overtaking a command`() = runBlocking {
        val gate = AuthorityTransactionGate(Mutex())
        val firstEntered = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val order = mutableListOf<String>()

        val first = async {
            gate.run {
                order += "command-start"
                firstEntered.complete(Unit)
                releaseFirst.await()
                order += "command-opened"
            }
        }
        firstEntered.await()
        val staleStatus = async {
            gate.run { order += "status-reconcile" }
        }
        yield()
        assertEquals(listOf("command-start"), order)
        releaseFirst.complete(Unit)
        awaitAll(first, staleStatus)
        assertEquals(listOf("command-start", "command-opened", "status-reconcile"), order)
    }

    @Test
    fun `cleanup delete false retains authority and a later retry proves absence`() {
        var exists = true
        var deleteAttempts = 0
        val first = performExactCleanup(
            downloadId = 42,
            localFilePath = "/owned/update.apk",
            removeDownload = { true },
            isOwnedFile = { true },
            fileExists = { exists },
            deleteFile = {
                deleteAttempts += 1
                false
            },
        )
        assertTrue(!first.succeeded)
        assertTrue(exists)

        val second = performExactCleanup(
            downloadId = 42,
            localFilePath = "/owned/update.apk",
            removeDownload = { true },
            isOwnedFile = { true },
            fileExists = { exists },
            deleteFile = {
                deleteAttempts += 1
                exists = false
                true
            },
        )
        assertTrue(second.succeeded)
        assertTrue(!exists)
        assertEquals(2, deleteAttempts)
    }

    @Test
    fun `cleanup delete exception is a stable failure rather than false absence`() {
        val result = performExactCleanup(
            downloadId = null,
            localFilePath = "/owned/update.apk",
            removeDownload = { true },
            isOwnedFile = { true },
            fileExists = { true },
            deleteFile = { error("filesystem busy") },
        )

        assertTrue(!result.succeeded)
        assertTrue(!result.fileAbsent)
    }

    @Test
    fun `cleanup failure transition preserves exact download and file authority`() {
        val failed = exactCleanupTransition(
            cleanup = ExactCleanupResult(downloadAbsent = true, fileAbsent = false),
            successState = HandsUpdateState.STALE,
            successErrorCode = "target_changed",
            successRetryable = true,
        )
        assertEquals(HandsUpdateState.FAILED, failed.state)
        assertEquals("cleanup_failed", failed.errorCode)
        assertTrue(failed.retryable)
        assertTrue(!failed.clearLocalAuthority)

        val succeeded = exactCleanupTransition(
            cleanup = ExactCleanupResult(downloadAbsent = true, fileAbsent = true),
            successState = HandsUpdateState.STALE,
            successErrorCode = "target_changed",
            successRetryable = true,
        )
        assertEquals(HandsUpdateState.STALE, succeeded.state)
        assertEquals("target_changed", succeeded.errorCode)
        assertTrue(succeeded.clearLocalAuthority)
    }

    @Test
    fun `ready target only reopens for the same fresh authoritative offer`() {
        assertEquals(
            PendingInstallerOfferAction.REOPEN_CURRENT,
            pendingInstallerOfferAction(
                persistedTarget = target(sha256 = "A".repeat(64), filetype = "APK"),
                offeredTarget = target(),
            ),
        )
        assertEquals(
            PendingInstallerOfferAction.REPLACE_CURRENT,
            pendingInstallerOfferAction(
                persistedTarget = target(),
                offeredTarget = target(versionCode = 1000012, buildId = "build-12"),
            ),
        )
        assertEquals(
            PendingInstallerOfferAction.WITHDRAW_CURRENT,
            pendingInstallerOfferAction(
                persistedTarget = target(),
                offeredTarget = null,
            ),
        )
    }

    @Test
    fun `same version with different build or SHA never reopens stale APK`() {
        assertEquals(
            PendingInstallerOfferAction.REPLACE_CURRENT,
            pendingInstallerOfferAction(
                persistedTarget = target(buildId = "build-A"),
                offeredTarget = target(buildId = "build-B"),
            ),
        )
        assertEquals(
            PendingInstallerOfferAction.REPLACE_CURRENT,
            pendingInstallerOfferAction(
                persistedTarget = target(sha256 = "a".repeat(64)),
                offeredTarget = target(sha256 = "b".repeat(64)),
            ),
        )
    }

    @Test
    fun `ready A with offer B cleans A then starts B without reopening A`() {
        val effects = mutableListOf<String>()

        reconcilePendingInstallerOffer(
            persistedTarget = target(),
            offeredTarget = target(versionCode = 1000012, buildId = "build-12"),
            reopenCurrent = { effects += "reopen-A" },
            replaceCurrent = {
                effects += "cleanup-A"
                effects += "start-B"
            },
            withdrawCurrent = { effects += "withdraw-A" },
        )

        assertEquals(listOf("cleanup-A", "start-B"), effects)
    }

    @Test
    fun `ready A with cancelled offer cleans A without reopen or replacement`() {
        val effects = mutableListOf<String>()

        reconcilePendingInstallerOffer(
            persistedTarget = target(),
            offeredTarget = null,
            reopenCurrent = { effects += "reopen-A" },
            replaceCurrent = { effects += "start-other" },
            withdrawCurrent = { effects += "cleanup-A" },
        )

        assertEquals(listOf("cleanup-A"), effects)
    }

    @Test
    fun `installer launch failure retains READY locator and same-offer retry reopens it`() {
        val failure = installerLaunchFailureTransition()
        assertEquals(HandsUpdateState.READY_TO_INSTALL, failure.state)
        assertEquals("installer_open_failed", failure.errorCode)
        assertTrue(failure.retryable)
        assertTrue(!failure.clearLocalAuthority)
        assertTrue(!shouldCleanupRestartableAuthority(
            state = failure.state,
            downloadId = 42,
            localFilePath = "/owned/update.apk",
        ))
        assertEquals(
            PendingInstallerOfferAction.REOPEN_CURRENT,
            pendingInstallerOfferAction(target(), target()),
        )
    }

    @Test
    fun `restartable records with any locator require exact cleanup before a new check`() {
        assertTrue(shouldCleanupRestartableAuthority(
            state = HandsUpdateState.FAILED,
            downloadId = 42,
            localFilePath = null,
        ))
        assertTrue(shouldCleanupRestartableAuthority(
            state = HandsUpdateState.STALE,
            downloadId = null,
            localFilePath = "/owned/update.apk",
        ))
        assertTrue(!shouldCleanupRestartableAuthority(
            state = HandsUpdateState.FAILED,
            downloadId = null,
            localFilePath = null,
        ))
    }

    @Test
    fun `prepared download crash windows recover zero one and uncertain ledger states`() {
        assertEquals(
            PreparedDownloadRecoveryAction.NO_MATCH,
            preparedDownloadRecovery(readable = true, matchingDownloadIds = emptyList()).action,
        )
        assertEquals(
            PreparedDownloadRecovery(
                action = PreparedDownloadRecoveryAction.RECOVER_ONE,
                downloadId = 42,
            ),
            preparedDownloadRecovery(readable = true, matchingDownloadIds = listOf(42)),
        )
        assertEquals(
            PreparedDownloadRecoveryAction.KEEP_UNCERTAIN,
            preparedDownloadRecovery(readable = true, matchingDownloadIds = listOf(42, 43)).action,
        )
        assertEquals(
            PreparedDownloadRecoveryAction.KEEP_UNCERTAIN,
            preparedDownloadRecovery(readable = false, matchingDownloadIds = emptyList()).action,
        )
    }
}
