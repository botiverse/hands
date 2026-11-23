package build.hands.desktop

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.net.http.HttpClient
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class StallTest {
    private val body = randomBytes(256 * 1024, 7)
    private val sha = sha256Hex(body)

    /** Serves [body]; the first [stallFirst] requests send half of it and then go silent. */
    private fun server(stallFirst: Int, release: CountDownLatch): Pair<HttpServer, AtomicInteger> {
        val hits = AtomicInteger()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/f") { ex ->
            val n = hits.incrementAndGet()
            ex.sendResponseHeaders(200, body.size.toLong())
            try {
                if (n <= stallFirst) {
                    ex.responseBody.write(body, 0, body.size / 2)
                    ex.responseBody.flush()
                    release.await(30, TimeUnit.SECONDS)
                } else {
                    ex.responseBody.write(body)
                }
            } catch (_: Exception) {
            }
            ex.close()
        }
        server.executor = java.util.concurrent.Executors.newCachedThreadPool()
        server.start()
        return server to hits
    }

    @Test
    fun `a download that stops sending is abandoned and retried`() {
        val release = CountDownLatch(1)
        val (server, hits) = server(stallFirst = 1, release = release)
        try {
            val out = Files.createTempFile("stall", ".bin")
            val http = Http(HttpClient.newHttpClient(), retries = 2, backoffMillis = 1, stallMillis = 300)
            val started = System.nanoTime()
            http.download("http://127.0.0.1:${server.address.port}/f", out, body.size.toLong(), sha) {}
            val tookMs = (System.nanoTime() - started) / 1_000_000
            assertArrayEquals(body, Files.readAllBytes(out))
            assertEquals(2, hits.get())
            assertTrue(tookMs < 10_000) { "took $tookMs ms" }
        } finally {
            release.countDown()
            server.stop(0)
        }
    }

    @Test
    fun `a download that keeps stalling fails instead of hanging`() {
        val release = CountDownLatch(1)
        val (server, hits) = server(stallFirst = 99, release = release)
        try {
            val out = Files.createTempFile("stall", ".bin")
            val http = Http(HttpClient.newHttpClient(), retries = 1, backoffMillis = 1, stallMillis = 200)
            val error = assertThrows<HandsUpdateException> {
                http.download("http://127.0.0.1:${server.address.port}/f", out, body.size.toLong(), sha) {}
            }
            assertTrue(error.message!!.contains("no data received")) { error.message }
            assertEquals(2, hits.get())
        } finally {
            release.countDown()
            server.stop(0)
        }
    }
}
