package com.ultron.companion.network

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

enum class ConnectionState {
    STANDBY,
    CONNECTING,
    CONNECTED,
    OFFLINE
}

class UltronWebSocketManager(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
) {
    private var webSocket: WebSocket? = null
    private var isIntentionalClose = false
    private var reconnectAttempts = 0
    private val handler = Handler(Looper.getMainLooper())

    private var currentWsUrl: String = ""
    private var currentToken: String = ""

    var onStateChanged: ((state: ConnectionState, message: String?, lastSeenAt: String?) -> Unit)? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendHeartbeat()
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }

    private val reconnectRunnable = Runnable {
        if (!isIntentionalClose && currentWsUrl.isNotEmpty() && currentToken.isNotEmpty()) {
            connect(currentWsUrl, currentToken)
        }
    }

    fun connect(wsUrl: String, token: String) {
        currentWsUrl = wsUrl
        currentToken = token
        isIntentionalClose = false

        handler.removeCallbacks(reconnectRunnable)
        handler.removeCallbacks(heartbeatRunnable)

        if (wsUrl.contains(":3001") && (wsUrl.contains("vercel.app") || wsUrl.startsWith("wss://"))) {
            onStateChanged?.invoke(ConnectionState.OFFLINE, "Legacy WebSocket port 3001 is not available in production.", null)
            return
        }

        val fullUrl = if (wsUrl.contains("?")) "$wsUrl&token=$token" else "$wsUrl?token=$token"

        onStateChanged?.invoke(ConnectionState.CONNECTING, "Connecting to ULTRON WebSocket…", null)

        val request = Request.Builder()
            .url(fullUrl)
            .build()

        webSocket?.close(1000, "Reconnecting")
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempts = 0
                // Authenticate immediately via message if not handled by query
                val authMsg = JSONObject().apply {
                    put("type", "auth")
                    put("token", token)
                }
                webSocket.send(authMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    val type = json.optString("type")

                    when (type) {
                        "authenticated" -> {
                            handler.post {
                                onStateChanged?.invoke(ConnectionState.CONNECTED, "Real-time link established.", json.optString("timestamp"))
                                startHeartbeat()
                            }
                        }
                        "heartbeat_ack", "pong" -> {
                            val lastSeen = json.optString("lastSeenAt", "")
                            handler.post {
                                onStateChanged?.invoke(ConnectionState.CONNECTED, "Heartbeat acknowledged.", lastSeen)
                            }
                        }
                        "error" -> {
                            val err = json.optString("message", "Error")
                            handler.post {
                                onStateChanged?.invoke(ConnectionState.OFFLINE, err, null)
                            }
                        }
                    }
                } catch (e: Exception) {
                    // ignore malformed message
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                stopHeartbeat()
                handler.post {
                    onStateChanged?.invoke(ConnectionState.OFFLINE, "Disconnected ($reason)", null)
                    if (!isIntentionalClose) {
                        scheduleReconnect()
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                stopHeartbeat()
                handler.post {
                    onStateChanged?.invoke(ConnectionState.OFFLINE, "Connection failed: ${t.message ?: "Network error"}", null)
                    if (!isIntentionalClose) {
                        scheduleReconnect()
                    }
                }
            }
        })
    }

    private fun sendHeartbeat() {
        webSocket?.let { ws ->
            val heartbeatMsg = JSONObject().apply {
                put("type", "heartbeat")
                put("timestamp", System.currentTimeMillis())
            }
            ws.send(heartbeatMsg.toString())
        }
    }

    private fun startHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
        handler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL_MS)
    }

    private fun stopHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
    }

    private fun scheduleReconnect() {
        reconnectAttempts++
        // Safe exponential backoff: 2s, 4s, 8s, 16s, max 30s
        val delaySec = min(30, 2 shl min(4, reconnectAttempts - 1))
        handler.postDelayed(reconnectRunnable, delaySec * 1000L)
    }

    fun disconnect() {
        isIntentionalClose = true
        handler.removeCallbacks(reconnectRunnable)
        stopHeartbeat()
        try {
            webSocket?.close(1000, "User disconnected")
        } catch (e: Exception) {
            // ignore
        }
        webSocket = null
        onStateChanged?.invoke(ConnectionState.STANDBY, "Disconnected", null)
    }

    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 25000L // 25 seconds
    }
}
