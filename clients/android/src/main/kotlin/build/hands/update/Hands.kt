package build.hands.update

import android.content.Context

/**
 * Single entry point for the Hands SDK. `Hands.install(...)` wires
 * everything the app needs at launch — JVM + native crash capture,
 * store-then-send upload of pending crashes, and the throttled
 * device-analytics ping — so the app calls one method.
 *
 * Feedback submission is a user action, kept as a separate call
 * ([HandsFeedback]).
 */
object Hands {

    /**
     * Install crash capture and fire launch-time reporting. Call once, as
     * early as possible (e.g. `Application.onCreate`).
     */
    fun install(
        context: Context,
        baseUrl: String,
        appSlug: String,
        versionName: String? = null,
        versionCode: Long? = null,
        channel: String? = null,
        clientKey: String? = null,
        copyToClipboard: Boolean = true,
        uploadOnLaunch: Boolean = true,
        captureNativeCrashes: Boolean = true,
        reportDeviceAnalytics: Boolean = true,
        extraContext: (() -> String)? = null,
    ) {
        HandsCrash.install(
            context = context,
            baseUrl = baseUrl,
            appSlug = appSlug,
            versionName = versionName,
            versionCode = versionCode,
            channel = channel,
            clientKey = clientKey,
            copyToClipboard = copyToClipboard,
            uploadOnLaunch = uploadOnLaunch,
            captureNativeCrashes = captureNativeCrashes,
            reportDeviceAnalytics = reportDeviceAnalytics,
            extraContext = extraContext,
        )
    }
}
