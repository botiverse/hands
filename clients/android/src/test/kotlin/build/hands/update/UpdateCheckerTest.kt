package build.hands.update

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateCheckerTest {
    @Test
    fun `API 33 and newer register the download receiver as not exported`() {
        assertEquals(
            Context.RECEIVER_NOT_EXPORTED,
            downloadReceiverRegistrationFlags(33),
        )
        assertEquals(
            Context.RECEIVER_NOT_EXPORTED,
            downloadReceiverRegistrationFlags(34),
        )
    }

    @Test
    fun `older Android releases keep the legacy registration overload`() {
        assertNull(downloadReceiverRegistrationFlags(24))
        assertNull(downloadReceiverRegistrationFlags(32))
    }
}
