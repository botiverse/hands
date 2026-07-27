package build.hands.update

import org.junit.Assert.assertEquals
import org.junit.Test

@Target(AnnotationTarget.CLASS)
private annotation class SdkVersionCompileTimeMarker(val value: String)

@SdkVersionCompileTimeMarker(HandsFeedback.SDK_VERSION)
private class SdkVersionCompileTimeConsumer

class HandsFeedbackVersionTest {
    @Test
    fun feedbackMetadataUsesPublicationVersion() {
        assertEquals(BuildConfig.HANDS_SDK_VERSION, HandsFeedback.SDK_VERSION)
    }

    @Test
    fun sdkVersionRemainsACompileTimeConstant() {
        val marker = requireNotNull(
            SdkVersionCompileTimeConsumer::class.java
                .getAnnotation(SdkVersionCompileTimeMarker::class.java),
        )
        assertEquals(
            BuildConfig.HANDS_SDK_VERSION,
            marker.value,
        )
    }
}
