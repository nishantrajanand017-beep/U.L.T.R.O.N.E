package com.ultron.companion.network

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

class UltronRealtimeManager(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
) {
    var appContext: Context? = null

    private var webSocket: WebSocket? = null
    private var isIntentionalClose = false
    private var reconnectAttempts = 0
    private val handler = Handler(Looper.getMainLooper())
    private val messageRef = AtomicLong(1)

    private var currentConfig: RealtimeConfigResponse? = null
    private var currentToken: String = ""

    var onStateChanged: ((state: ConnectionState, message: String?, lastSeenAt: String?) -> Unit)? = null
    var onCommandReceived: ((commandId: String, action: String, params: JSONObject?) -> Unit)? = null
    var onDeviceCommandProcessed: ((commandId: String, status: String, result: JSONObject?) -> Unit)? = null

    // Bounded replay protection cache: LRU eviction, max 500 entries
    private val processedCommandIds = Collections.synchronizedSet(
        Collections.newSetFromMap(
            object : LinkedHashMap<String, Boolean>(500, 0.75f, true) {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean {
                    return size > 500
                }
            }
        )
    )

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
                } else if (bEvent == "device_command" && bPayload != null) {
                    handleDeviceCommand(bPayload)
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

    private fun handleDeviceCommand(bPayload: JSONObject) {
        try {
            val commandId = bPayload.optString("commandId").trim()
            val targetDeviceId = bPayload.optString("targetDeviceId").trim()
            val commandType = bPayload.optString("commandType").trim()
            val expiresAt = bPayload.optLong("expiresAt", 0L)
            val currentDeviceId = currentConfig?.deviceId?.trim() ?: ""

            // 1. Target device isolation: compare targetDeviceId with local deviceId
            // If they do not match, silently ignore the command. Do not process, do not acknowledge, do not crash.
            if (currentDeviceId.isEmpty() || targetDeviceId != currentDeviceId) {
                return
            }

            if (commandId.isEmpty()) {
                return
            }

            // 2. Expiry check: compare server expiresAt with current local time
            val currentTime = System.currentTimeMillis()
            if (expiresAt > 0 && currentTime > expiresAt) {
                broadcastCommandResult(
                    commandId = commandId,
                    status = "EXPIRED",
                    error = "Command expired before processing."
                )
                return
            }

            // 3. Replay protection check
            val isDuplicate = synchronized(processedCommandIds) {
                processedCommandIds.contains(commandId)
            }
            if (isDuplicate) {
                broadcastCommandResult(
                    commandId = commandId,
                    status = "DUPLICATE",
                    error = "Command has already been processed."
                )
                return
            }

            // 4. Command allowlist validation (PING and OPEN_APP supported)
            if (commandType != "PING" && commandType != "OPEN_APP") {
                broadcastCommandResult(
                    commandId = commandId,
                    status = "FAILED",
                    error = "Unsupported commandType: '$commandType'. Only PING and OPEN_APP are supported."
                )
                return
            }

            if (commandType == "PING") {
                // Execute PING command -> record in replay cache & respond with PONG
                synchronized(processedCommandIds) {
                    processedCommandIds.add(commandId)
                }

                val pongResult = JSONObject().apply {
                    put("type", "PONG")
                }

                broadcastCommandResult(
                    commandId = commandId,
                    status = "SUCCESS",
                    result = pongResult
                )

                handler.post {
                    onDeviceCommandProcessed?.invoke(commandId, "SUCCESS", pongResult)
                }
                return
            }

            if (commandType == "OPEN_APP") {
                val payloadObj = bPayload.optJSONObject("payload")
                val appId = payloadObj?.optString("appId")?.trim()?.lowercase() ?: ""
                val packageName = payloadObj?.optString("packageName")?.trim() ?: ""

                // Defense-in-depth allowlist verification on Android
                val expectedPackage = ALLOWED_PACKAGES[appId]
                if (expectedPackage == null || (packageName.isNotEmpty() && packageName != expectedPackage)) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        result = JSONObject().apply {
                            put("type", "APP_DISALLOWED")
                            put("appId", appId)
                        },
                        error = "Application '$appId' is not permitted on this device."
                    )
                    return
                }

                val ctx = appContext
                if (ctx == null) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        error = "Device context is not available for launching applications."
                    )
                    return
                }

                val pm = ctx.packageManager
                val launchIntent = try {
                    pm.getLaunchIntentForPackage(expectedPackage)
                } catch (e: Exception) {
                    null
                }

                if (launchIntent == null) {
                    val notInstalledResult = JSONObject().apply {
                        put("type", "APP_NOT_INSTALLED")
                        put("appId", appId)
                        put("packageName", expectedPackage)
                    }
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        result = notInstalledResult,
                        error = "Application '$appId' ($expectedPackage) is not installed."
                    )
                    handler.post {
                        onDeviceCommandProcessed?.invoke(commandId, "FAILED", notInstalledResult)
                    }
                    return
                }

                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    ctx.startActivity(launchIntent)

                    // Successfully launched -> record in bounded replay cache
                    synchronized(processedCommandIds) {
                        processedCommandIds.add(commandId)
                    }

                    val successResult = JSONObject().apply {
                        put("type", "APP_LAUNCHED")
                        put("appId", appId)
                        put("packageName", expectedPackage)
                    }

                    broadcastCommandResult(
                        commandId = commandId,
                        status = "SUCCESS",
                        result = successResult
                    )

                    handler.post {
                        onDeviceCommandProcessed?.invoke(commandId, "SUCCESS", successResult)
                    }
                } catch (e: ActivityNotFoundException) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        result = JSONObject().apply {
                            put("type", "APP_NOT_FOUND")
                            put("appId", appId)
                        },
                        error = "Activity not found for application '$appId'."
                    )
                } catch (e: SecurityException) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        error = "Security restriction prevented launching '$appId'."
                    )
                } catch (e: Exception) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        error = "Failed to launch application '$appId'."
                    )
                }
            }
        } catch (e: Exception) {
            // Never crash when handling incoming commands
        }
    }

    private fun broadcastCommandResult(
        commandId: String,
        status: String,
        result: JSONObject? = null,
        error: String? = null
    ) {
        val ws = webSocket ?: return
        val config = currentConfig ?: return
        if (config.provider != "supabase") return

        try {
            val bRef = messageRef.getAndIncrement().toString()
            val nowIso = Instant.now().toString()
            val broadcastMsg = JSONObject().apply {
                put("topic", config.phoenixTopic)
                put("event", "broadcast")
                put("payload", JSONObject().apply {
                    put("type", "broadcast")
                    put("event", "device_command_result")
                    put("payload", JSONObject().apply {
                        put("commandId", commandId)
                        put("deviceId", config.deviceId)
                        put("status", status)
                        if (result != null) put("result", result)
                        if (error != null) put("error", error)
                        put("completedAt", nowIso)
                    })
                })
                put("ref", bRef)
            }
            ws.send(broadcastMsg.toString())
        } catch (e: Exception) {
            // Never crash on send failure
        }
    }

    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 25000L // 25 seconds

        val ALLOWED_PACKAGES = mapOf(
            "whatsapp" to "com.whatsapp",
            "telegram" to "org.telegram.messenger",
            "chrome" to "com.android.chrome",
            "youtube" to "com.google.android.youtube",
            "gmail" to "com.google.android.gm",
            "settings" to "com.android.settings"
        )
    }
}
