package build.hands.update

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.Closeable

/**
 * Result of an asynchronous [UpdateChecker] call for Java and other
 * non-coroutine hosts. Exactly one of [value] and [error] is non-null.
 * Called on the main thread.
 */
fun interface HandsUpdateCallback<T> {
    fun onResult(value: T?, error: Throwable?)
}

/** Every status change while observing; called on the main thread. */
fun interface HandsUpdateStatusListener {
    fun onStatus(status: HandsUpdateStatus)
}

internal fun <T> CoroutineScope.deliver(
    callback: HandsUpdateCallback<T>,
    block: suspend () -> T,
): Closeable {
    val job: Job = launch {
        val result = try {
            Result.success(block())
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Result.failure(error)
        }
        try {
            callback.onResult(result.getOrNull(), result.exceptionOrNull())
        } catch (_: Throwable) {
            // A host callback must not break the checker's scope.
        }
    }
    return Closeable { job.cancel() }
}
