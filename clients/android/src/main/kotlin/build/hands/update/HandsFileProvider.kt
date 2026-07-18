package build.hands.update

import androidx.core.content.FileProvider

/** Keeps the SDK provider distinct from a host app's own FileProvider. */
class HandsFileProvider : FileProvider()
