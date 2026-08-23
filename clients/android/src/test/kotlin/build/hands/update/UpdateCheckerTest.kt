package build.hands.update

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckerTest {
    @Test
    fun `API 33 and newer export the receiver for privileged download senders`() {
        assertEquals(
            Context.RECEIVER_EXPORTED,
            downloadReceiverRegistrationFlags(33),
        )
        assertEquals(
            Context.RECEIVER_EXPORTED,
            downloadReceiverRegistrationFlags(34),
        )
    }

    @Test
    fun `download completion receiver requires the platform signature sender permission`() {
        assertEquals(
            "android.permission.SEND_DOWNLOAD_COMPLETED_INTENTS",
            DOWNLOAD_COMPLETED_SENDER_PERMISSION,
        )
    }

    @Test
    fun `older Android releases keep the legacy registration overload`() {
        assertNull(downloadReceiverRegistrationFlags(24))
        assertNull(downloadReceiverRegistrationFlags(32))
    }

    @Test
    fun `API 33 registration uses only the permission-gated modern overload`() {
        val legacyPermissions = mutableListOf<String>()
        val modernCalls = mutableListOf<Pair<String, Int>>()

        registerDownloadReceiverForSdk(
            sdkInt = 33,
            registerLegacy = legacyPermissions::add,
            registerModern = { permission, flags -> modernCalls += permission to flags },
        )

        assertTrue(legacyPermissions.isEmpty())
        assertEquals(
            listOf(DOWNLOAD_COMPLETED_SENDER_PERMISSION to Context.RECEIVER_EXPORTED),
            modernCalls,
        )
    }

    @Test
    fun `legacy registration uses only the permission-gated four-argument overload`() {
        val legacyPermissions = mutableListOf<String>()
        val modernCalls = mutableListOf<Pair<String, Int>>()

        registerDownloadReceiverForSdk(
            sdkInt = 32,
            registerLegacy = legacyPermissions::add,
            registerModern = { permission, flags -> modernCalls += permission to flags },
        )

        assertEquals(listOf(DOWNLOAD_COMPLETED_SENDER_PERMISSION), legacyPermissions)
        assertTrue(modernCalls.isEmpty())
    }
}
