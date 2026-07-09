package build.hands.update.models

import kotlinx.serialization.Serializable

/** Top-level app metadata returned by Quiver public update endpoints. */
@Serializable
data class App(
    val slug: String,
    val platform: String,
)
