package build.hands.update

import org.junit.Assert.assertEquals
import org.junit.Test

class HandsFeedbackVersionTest {
    @Test
    fun feedbackMetadataUsesPublicationVersion() {
        assertEquals(BuildConfig.HANDS_SDK_VERSION, HandsFeedback.SDK_VERSION)
    }
}
