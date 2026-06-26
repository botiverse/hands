package io.quiver.update.models

import kotlinx.serialization.Serializable

/** Top-level app metadata returned by `/public/apps/:slug/latest`. */
@Serializable
data class App(
    val slug: String,
    val platform: String,
)