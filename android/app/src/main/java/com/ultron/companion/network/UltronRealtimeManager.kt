package com.ultron.companion.network

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Collections
import java.util.LinkedHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

data class DiscoveredApp(
    val appId: String,
    val displayName: String,
    val packageName: String
)

class UltronRealtimeManager private constructor(
    private val appContext: Context,
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

    private val discoveredApps = Collections.synchronizedMap(LinkedHashMap<String, DiscoveredApp>())
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    init {
        discoverInstalledApps()
        registerNetworkCallback()
    }

    var connectionState: ConnectionState = ConnectionState.STANDBY
        private set

    // Support multiple state change listeners (e.g. HeartbeatService for notification, MainActivity for UI)
    private val stateListeners = Collections.synchronizedMap(LinkedHashMap<String, (ConnectionState, String?, String?) -> Unit>())
    private val commandProcessedListeners = Collections.synchronizedMap(LinkedHashMap<String, (String, String, JSONObject?) -> Unit>())

    // Backward-compatible single listener property (routes to "default" key)
    var onStateChanged: ((state: ConnectionState, message: String?, lastSeenAt: String?) -> Unit)?
        get() = stateListeners["default"]
        set(value) {
            if (value != null) {
                stateListeners["default"] = value
            } else {
                stateListeners.remove("default")
            }
        }

    fun addStateListener(key: String, listener: (ConnectionState, String?, String?) -> Unit) {
        stateListeners[key] = listener
    }

    fun removeStateListener(key: String) {
        stateListeners.remove(key)
    }

    var onDeviceCommandProcessed: ((commandId: String, status: String, result: JSONObject?) -> Unit)?
        get() = commandProcessedListeners["default"]
        set(value) {
            if (value != null) {
                commandProcessedListeners["default"] = value
            } else {
                commandProcessedListeners.remove("default")
            }
        }

    fun addCommandProcessedListener(key: String, listener: (String, String, JSONObject?) -> Unit) {
        commandProcessedListeners[key] = listener
    }

    fun removeCommandProcessedListener(key: String) {
        commandProcessedListeners.remove(key)
    }

    var onCommandReceived: ((commandId: String, action: String, params: JSONObject?) -> Unit)? = null

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

    private fun notifyStateChanged(state: ConnectionState, message: String?, lastSeenAt: String?) {
        connectionState = state
        handler.post {
            val listeners = synchronized(stateListeners) { stateListeners.values.toList() }
            listeners.forEach { listener ->
                try {
                    listener.invoke(state, message, lastSeenAt)
                } catch (e: Exception) {
                    // Ignore listener exceptions
                }
            }
        }
    }

    private fun notifyCommandProcessed(commandId: String, status: String, result: JSONObject?) {
        handler.post {
            val listeners = synchronized(commandProcessedListeners) { commandProcessedListeners.values.toList() }
            listeners.forEach { listener ->
                try {
                    listener.invoke(commandId, status, result)
                } catch (e: Exception) {
                    // Ignore listener exceptions
                }
            }
        }
    }

    @Synchronized
    fun connect(config: RealtimeConfigResponse, token: String) {
        // If already connected or connecting to the exact same channel with the same token, do not duplicate
        if (webSocket != null && !isIntentionalClose && currentConfig?.realtimeWsUrl == config.realtimeWsUrl && currentToken == token) {
            android.util.Log.d("ULTRON_REALTIME", "Already connected/connecting to realtime channel, reusing existing connection")
            if (connectionState == ConnectionState.CONNECTED) {
                notifyStateChanged(ConnectionState.CONNECTED, "Supabase Realtime link active.", null)
            }
            return
        }

        currentConfig = config
        currentToken = token
        isIntentionalClose = false

        handler.removeCallbacks(reconnectRunnable)
        handler.removeCallbacks(heartbeatRunnable)

        val wsUrl = config.realtimeWsUrl
        if (wsUrl.isBlank()) {
            notifyStateChanged(ConnectionState.OFFLINE, "No valid Realtime URL provided.", null)
            return
        }

        if (wsUrl.contains(":3001") && (wsUrl.contains("vercel.app") || wsUrl.startsWith("wss://"))) {
            notifyStateChanged(ConnectionState.OFFLINE, "Legacy WebSocket port 3001 is not available in production.", null)
            return
        }

        notifyStateChanged(
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
            notifyStateChanged(ConnectionState.OFFLINE, "Legacy WebSocket port 3001 is not available in production.", null)
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
                                put("private", true)
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
                this@UltronRealtimeManager.webSocket = null
                stopHeartbeat()
                notifyStateChanged(ConnectionState.OFFLINE, "Disconnected ($reason)", null)
                if (!isIntentionalClose) {
                    scheduleReconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                this@UltronRealtimeManager.webSocket = null
                stopHeartbeat()
                notifyStateChanged(
                    ConnectionState.OFFLINE,
                    "Realtime link offline: ${t.message ?: "Network error"}",
                    null
                )
                if (!isIntentionalClose) {
                    scheduleReconnect()
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
                    notifyStateChanged(
                        ConnectionState.CONNECTED,
                        "Supabase Realtime link active.",
                        null
                    )
                    startHeartbeat()
                    broadcastDeviceStatus("connected")
                    broadcastAppCatalog()
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
                } else if (bEvent == "request_app_catalog" || bEvent == "device:request_catalog") {
                    discoverInstalledApps()
                    broadcastAppCatalog()
                }
            }
            "phx_error", "phx_close" -> {
                this@UltronRealtimeManager.webSocket = null
                stopHeartbeat()
                notifyStateChanged(ConnectionState.OFFLINE, "Channel closed ($event)", null)
                if (!isIntentionalClose) {
                    scheduleReconnect()
                }
            }
        }
    }

    private fun handleLegacyMessage(json: JSONObject) {
        val type = json.optString("type")
        when (type) {
            "authenticated" -> {
                notifyStateChanged(
                    ConnectionState.CONNECTED,
                    "Legacy real-time link established.",
                    json.optString("timestamp")
                )
                startHeartbeat()
            }
            "heartbeat_ack", "pong" -> {
                val lastSeen = json.optString("lastSeenAt", "")
                notifyStateChanged(ConnectionState.CONNECTED, "Heartbeat acknowledged.", lastSeen)
            }
            "error" -> {
                val err = json.optString("message", "Error")
                notifyStateChanged(ConnectionState.OFFLINE, err, null)
            }
        }
    }

    private fun sendRealtimeHeartbeat() {
        val ws = webSocket ?: return
        val config = currentConfig ?: return

        if (config.provider == "supabase") {
            // 1. Supabase/Phoenix protocol heartbeat: topic="phoenix", event="heartbeat"
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
        notifyStateChanged(ConnectionState.STANDBY, "Disconnected", null)
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
                    commandType = commandType,
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
                    commandType = commandType,
                    error = "Command has already been processed."
                )
                return
            }

            // 4. Command allowlist validation (PING, OPEN_APP, and REQUEST_CATALOG supported)
            if (commandType != "PING" && commandType != "OPEN_APP" && commandType != "REQUEST_CATALOG") {
                broadcastCommandResult(
                    commandId = commandId,
                    status = "FAILED",
                    commandType = commandType,
                    error = "Unsupported commandType: '$commandType'. Only PING, OPEN_APP, and REQUEST_CATALOG are supported."
                )
                return
            }

            if (commandType == "REQUEST_CATALOG") {
                synchronized(processedCommandIds) {
                    processedCommandIds.add(commandId)
                }
                discoverInstalledApps()
                broadcastAppCatalog()
                val catalogResult = JSONObject().apply {
                    put("type", "CATALOG_SYNCED")
                    put("count", discoveredApps.size)
                }
                broadcastCommandResult(
                    commandId = commandId,
                    status = "SUCCESS",
                    commandType = "REQUEST_CATALOG",
                    result = catalogResult
                )
                notifyCommandProcessed(commandId, "SUCCESS", catalogResult)
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
                    commandType = "PING",
                    result = pongResult
                )

                notifyCommandProcessed(commandId, "SUCCESS", pongResult)
                return
            }

            if (commandType == "OPEN_APP") {
                val payloadObj = bPayload.optJSONObject("payload")
                val appId = payloadObj?.optString("appId")?.trim()?.lowercase() ?: ""
                val packageName = payloadObj?.optString("packageName")?.trim() ?: ""

                // Defense-in-depth dynamic app verification on Android:
                // Package name MUST ONLY be resolved locally from the verified appId.
                // The server/client cannot inject an arbitrary or mismatched packageName.
                val resolvedApp = discoveredApps[appId]
                val expectedPackage = resolvedApp?.packageName ?: ALLOWED_PACKAGES[appId]

                if (expectedPackage == null || (packageName.isNotEmpty() && packageName != expectedPackage)) {
                    val disallowedResult = JSONObject().apply {
                        put("type", "APP_DISALLOWED")
                        put("appId", appId)
                    }
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        commandType = "OPEN_APP",
                        result = disallowedResult,
                        error = "Application '$appId' is not permitted or installed on this device."
                    )
                    notifyCommandProcessed(commandId, "FAILED", disallowedResult)
                    return
                }

                val pm = appContext.packageManager
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
                        commandType = "OPEN_APP",
                        result = notInstalledResult,
                        error = "Application '$appId' ($expectedPackage) is not installed."
                    )
                    notifyCommandProcessed(commandId, "FAILED", notInstalledResult)
                    return
                }

                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                try {
                    appContext.startActivity(launchIntent)

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
                        commandType = "OPEN_APP",
                        result = successResult
                    )

                    notifyCommandProcessed(commandId, "SUCCESS", successResult)
                } catch (e: ActivityNotFoundException) {
                    val notFoundResult = JSONObject().apply {
                        put("type", "APP_NOT_FOUND")
                        put("appId", appId)
                    }
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        commandType = "OPEN_APP",
                        result = notFoundResult,
                        error = "Activity not found for application '$appId'."
                    )
                    notifyCommandProcessed(commandId, "FAILED", notFoundResult)
                } catch (e: SecurityException) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        commandType = "OPEN_APP",
                        error = "Security restriction prevented launching '$appId'."
                    )
                    notifyCommandProcessed(commandId, "FAILED", null)
                } catch (e: Exception) {
                    broadcastCommandResult(
                        commandId = commandId,
                        status = "FAILED",
                        commandType = "OPEN_APP",
                        error = "Failed to launch application '$appId'."
                    )
                    notifyCommandProcessed(commandId, "FAILED", null)
                }
            }
        } catch (e: Exception) {
            // Never crash when handling incoming commands
        }
    }

    private fun broadcastCommandResult(
        commandId: String,
        status: String,
        commandType: String? = null,
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
                        if (!commandType.isNullOrEmpty()) put("commandType", commandType)
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

    private fun registerNetworkCallback() {
        try {
            val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
            val request = NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()

            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    android.util.Log.d("ULTRON_REALTIME", "Network available - checking companion reconnection")
                    if (connectionState != ConnectionState.CONNECTED && !isIntentionalClose && currentConfig != null && currentToken.isNotEmpty()) {
                        handler.post {
                            connect(currentConfig!!, currentToken)
                        }
                    }
                }

                override fun onLost(network: Network) {
                    android.util.Log.d("ULTRON_REALTIME", "Network lost")
                }
            }
            networkCallback = cb
            cm.registerNetworkCallback(request, cb)
        } catch (e: Exception) {
            android.util.Log.w("ULTRON_REALTIME", "Could not register NetworkCallback: ${e.message}")
        }
    }

    fun discoverInstalledApps(): List<DiscoveredApp> {
        val pm = appContext.packageManager
        val intent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_LAUNCHER)
        }

        // 1. Preload approved apps map
        ALLOWED_PACKAGES.forEach { (appId, pkg) ->
            try {
                val appInfo = pm.getApplicationInfo(pkg, 0)
                val label = pm.getApplicationLabel(appInfo).toString()
                val entry = DiscoveredApp(appId, label, pkg)
                discoveredApps[appId] = entry
            } catch (e: Exception) {
                // Not installed on device, skip
            }
        }

        // 2. Query all launcher activities
        try {
            val activities: List<ResolveInfo> = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L))
            } else {
                pm.queryIntentActivities(intent, 0)
            }

            for (info in activities) {
                val pkgName = info.activityInfo.packageName
                if (pkgName.isNullOrBlank() || pkgName == appContext.packageName) continue
                if (isBlacklistedPackage(pkgName)) continue

                val label = info.loadLabel(pm).toString().trim()
                if (label.isEmpty()) continue

                val existingEntry = discoveredApps.values.firstOrNull { it.packageName == pkgName }
                if (existingEntry != null) continue

                val rawId = label.lowercase().replace(Regex("[^a-z0-9_]"), "_").trim('_')
                var candidateId = if (rawId.isNotEmpty()) rawId else "app_${pkgName.substringAfterLast('.')}"
                if (candidateId.length > 32) candidateId = candidateId.substring(0, 32)

                var finalId = candidateId
                var counter = 2
                while (discoveredApps.containsKey(finalId) && discoveredApps[finalId]?.packageName != pkgName) {
                    finalId = "${candidateId}_$counter"
                    counter++
                }

                val appEntry = DiscoveredApp(finalId, label, pkgName)
                discoveredApps[finalId] = appEntry
            }
        } catch (e: Exception) {
            android.util.Log.e("ULTRON_REALTIME", "Error discovering launcher apps: ${e.message}")
        }

        return synchronized(discoveredApps) { discoveredApps.values.toList() }
    }

    fun getDiscoveredApps(): List<DiscoveredApp> {
        return synchronized(discoveredApps) { discoveredApps.values.toList() }
    }

    private fun isBlacklistedPackage(pkg: String): Boolean {
        val lower = pkg.lowercase()
        return lower.contains("keychain") ||
                lower.contains("packageinstaller") ||
                lower.contains("setupwizard") ||
                lower == "android" ||
                lower.contains("certinstaller")
    }

    fun broadcastAppCatalog() {
        val ws = webSocket ?: return
        val config = currentConfig ?: return
        if (config.provider != "supabase") return

        try {
            val bRef = messageRef.getAndIncrement().toString()
            val appsList = synchronized(discoveredApps) { discoveredApps.values.toList() }
            val appsArray = JSONArray()
            appsList.forEach { app ->
                appsArray.put(JSONObject().apply {
                    put("appId", app.appId)
                    put("displayName", app.displayName)
                })
            }

            val broadcastMsg = JSONObject().apply {
                put("topic", config.phoenixTopic)
                put("event", "broadcast")
                put("payload", JSONObject().apply {
                    put("type", "broadcast")
                    put("event", "device:app_catalog")
                    put("payload", JSONObject().apply {
                        put("deviceId", config.deviceId)
                        put("apps", appsArray)
                        put("timestamp", System.currentTimeMillis())
                    })
                })
                put("ref", bRef)
            }
            ws.send(broadcastMsg.toString())
        } catch (e: Exception) {
            android.util.Log.e("ULTRON_REALTIME", "Failed to broadcast app catalog: ${e.message}")
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

        @Volatile
        private var instance: UltronRealtimeManager? = null

        fun getInstance(context: Context): UltronRealtimeManager {
            return instance ?: synchronized(this) {
                instance ?: UltronRealtimeManager(context.applicationContext).also { instance = it }
            }
        }

        fun resetInstanceForTest() {
            synchronized(this) {
                instance?.disconnect()
                instance = null
            }
        }
    }
}
