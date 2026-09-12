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
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

class UltronRealtimeManager(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
) {
    private var webSocket: WebSocket? = null
    private var isIntentionalClose = false
    private var reconnectAttempts = 0
    private val handler = Handler(Looper.getMainLooper())
    private val messageRef = AtomicLong(1)

    private var currentConfig: RealtimeConfigResponse? = null
    private var currentToken: String = ""

    var onStateChanged: ((state: ConnectionState, message: String?, lastSeenAt: String?) -> Unit)? = null
    var onCommandReceived: ((commandId: String, action: String, params: JSONObject?) -> Unit)? = null

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            sendRealtimeHeartbeat()
            val interval = currentConfig?.heartbeatIntervalMs ?: HEARTBEAT_INTERVAL_MS
            handler.postDelayed(this, interval)
        }
    }

    private val reconnectRunnable = Runnable {
        if (!isIntentionalClose && currentConfig != null && currentToken.isNotEmpty()) {
            connect(currentConfig!!, currentToken)
        }
    }

    fun connect(config: RealtimeConfigResponse, token: String) {
        currentConfig = config
        currentToken = token
        isIntentionalClose = false

        handler.removeCallbacks(reconnectRunnable)
        handler.removeCallbacks(heartbeatRunnable)

        val wsUrl = config.realtimeWsUrl
        if (wsUrl.isBlank()) {
            onStateChanged?.invoke(ConnectionState.OFFLINE, "No valid Realtime URL provided.", null)
            return
        }

        if (wsUrl.contains(":3001") && (wsUrl.contains("vercel.app") || wsUrl.startsWith("wss://"))) {
            onStateChanged?.invoke(ConnectionState.OFFLINE, "Legacy WebSocket port 3001 is not available in production.", null)
            return
        }

        onStateChanged?.invoke(
            ConnectionState.CONNECTING,
            if (config.provider == "supabase") "Connecting to Supabase Realtime…" else "Connecting to local WebSocket…",
            null
        )

        // Supabase Realtime uses apikey in query string, legacy ws can use query token
        val targetUrl = if (config.provider == "legacy_ws") {
            if (wsUrl.contains("?")) "$wsUrl&token=$token" else "$wsUrl?token=$token"
        } else {
            wsUrl
        }

        if (targetUrl.contains(":3001") && (targetUrl.contains("vercel.app") || targetUrl.startsWith("wss://"))) {
            onStateChanged?.invoke(ConnectionState.OFFLINE, "Legacy WebSocket port 3001 is not available in production.", null)
            return
        }

        val request = Request.Builder()
            .url(targetUrl)
            .build()

        webSocket?.close(1000, "Reconnecting")
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempts = 0

                if (config.provider == "supabase") {
                    // 1. Join Phoenix Channel for user: realtime:ultron:devices:<userId>
                    val joinRef = messageRef.getAndIncrement().toString()
                    val joinMsg = JSONObject().apply {
                        put("topic", config.phoenixTopic)
                        put("event", "phx_join")
                        put("payload", JSONObject().apply {
                            put("config", JSONObject().apply {
                                put("broadcast", JSONObject().apply {
                                    put("ack", false)
                                    put("self", false)
                                })
                            })
                        })
                        put("ref", joinRef)
                    }
                    webSocket.send(joinMsg.toString())
                } else {
                    // Legacy message-based authentication
                    val authMsg = JSONObject().apply {
                        put("type", "auth")
                        put("token", token)
                    }
                    webSocket.send(authMsg.toString())
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)

                    if (config.provider == "supabase") {
                        handlePhoenixMessage(json)
                    } else {
                        handleLegacyMessage(json)
                    }
                } catch (e: Exception) {
                    // Ignore unparseable frames
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
                    onStateChanged?.invoke(
                        ConnectionState.OFFLINE,
                        "Realtime link offline: ${t.message ?: "Network error"}",
                        null
                    )
                    if (!isIntentionalClose) {
                        scheduleReconnect()
                    }
                }
            }
        })
    }

    private fun handlePhoenixMessage(json: JSONObject) {
        val event = json.optString("event")
        val topic = json.optString("topic")

        when (event) {
            "phx_reply" -> {
                val payload = json.optJSONObject("payload")
                val status = payload?.optString("status")
                if (status == "ok" && topic == currentConfig?.phoenixTopic) {
                    handler.post {
                        onStateChanged?.invoke(
                            ConnectionState.CONNECTED,
                            "Supabase Realtime link active.",
                            null
                        )
                        startHeartbeat()
                        broadcastDeviceStatus("connected")
                    }
                }
            }
            "broadcast" -> {
                val payload = json.optJSONObject("payload")
                val bEvent = payload?.optString("event")
                val bPayload = payload?.optJSONObject("payload")

                if (bEvent == "command" && bPayload != null) {
                    val cmdId = bPayload.optString("commandId")
                    val action = bPayload.optString("action")
                    val params = bPayload.optJSONObject("params")
                    handler.post {
                        onCommandReceived?.invoke(cmdId, action, params)
                    }
                }
            }
            "phx_error", "phx_close" -> {
                stopHeartbeat()
                handler.post {
                    onStateChanged?.invoke(ConnectionState.OFFLINE, "Channel closed ($event)", null)
                    if (!isIntentionalClose) {
                        scheduleReconnect()
                    }
                }
            }
        }
    }

    private fun handleLegacyMessage(json: JSONObject) {
        val type = json.optString("type")
        when (type) {
            "authenticated" -> {
                handler.post {
                    onStateChanged?.invoke(
                        ConnectionState.CONNECTED,
                        "Legacy real-time link established.",
                        json.optString("timestamp")
                    )
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
    }

    private fun sendRealtimeHeartbeat() {
        val ws = webSocket ?: return
        val config = currentConfig ?: return

        if (config.provider == "supabase") {
            // 1. Phoenix connection heartbeat
            val hbRef = messageRef.getAndIncrement().toString()
            val phoenixHb = JSONObject().apply {
                put("topic", "phoenix")
                put("event", "heartbeat")
                put("payload", JSONObject())
                put("ref", hbRef)
            }
            ws.send(phoenixHb.toString())

            // 2. Broadcast device heartbeat onto channel (NO TOKEN EXPOSURE)
            val bRef = messageRef.getAndIncrement().toString()
            val broadcastHb = JSONObject().apply {
                put("topic", config.phoenixTopic)
                put("event", "broadcast")
                put("payload", JSONObject().apply {
                    put("type", "broadcast")
                    put("event", "device:heartbeat")
                    put("payload", JSONObject().apply {
                        put("deviceId", config.deviceId)
                        put("timestamp", System.currentTimeMillis())
                    })
                })
                put("ref", bRef)
            }
            ws.send(broadcastHb.toString())
        } else {
            val legacyHb = JSONObject().apply {
                put("type", "heartbeat")
                put("timestamp", System.currentTimeMillis())
            }
            ws.send(legacyHb.toString())
        }
    }

    fun broadcastDeviceStatus(status: String) {
        val ws = webSocket ?: return
        val config = currentConfig ?: return

        if (config.provider == "supabase") {
            val bRef = messageRef.getAndIncrement().toString()
            val broadcastStatus = JSONObject().apply {
                put("topic", config.phoenixTopic)
                put("event", "broadcast")
                put("payload", JSONObject().apply {
                    put("type", "broadcast")
                    put("event", "device:status")
                    put("payload", JSONObject().apply {
                        put("deviceId", config.deviceId)
                        put("status", status)
                        put("timestamp", System.currentTimeMillis())
                    })
                })
                put("ref", bRef)
            }
            ws.send(broadcastStatus.toString())
        }
    }

    private fun startHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
        val interval = currentConfig?.heartbeatIntervalMs ?: HEARTBEAT_INTERVAL_MS
        handler.postDelayed(heartbeatRunnable, interval)
    }

    private fun stopHeartbeat() {
        handler.removeCallbacks(heartbeatRunnable)
    }

    private fun scheduleReconnect() {
        reconnectAttempts++
        val delaySec = min(30, 2 shl min(4, reconnectAttempts - 1))
        handler.postDelayed(reconnectRunnable, delaySec * 1000L)
    }

    fun disconnect() {
        isIntentionalClose = true
        handler.removeCallbacks(reconnectRunnable)
        stopHeartbeat()
        try {
            if (currentConfig?.provider == "supabase" && webSocket != null) {
                broadcastDeviceStatus("offline")
            }
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
