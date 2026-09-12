package com.ultron.companion.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

data class PairingResponse(
    val deviceId: String,
    val deviceAuthToken: String,
    val deviceName: String,
    val userId: String,
    val pairedAt: String
)

data class HeartbeatResponse(
    val success: Boolean,
    val connectionStatus: String,
    val lastSeenAt: String
)

data class RealtimeConfigResponse(
    val success: Boolean,
    val configured: Boolean,
    val provider: String,
    val channel: String,
    val phoenixTopic: String,
    val realtimeWsUrl: String,
    val deviceId: String,
    val userId: String,
    val heartbeatIntervalMs: Long = 25000L
)

class UltronApiClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
) {
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    suspend fun claimPairing(
        serverUrl: String,
        pairingCode: String,
        deviceName: String,
        appVersion: String = "1.0.0"
    ): Result<PairingResponse> = withContext(Dispatchers.IO) {
        val normalizedUrl = serverUrl.trimEnd('/')
        val endpoint = "$normalizedUrl/api/devices/pairing/claim"
        val startTime = System.currentTimeMillis()

        android.util.Log.d("ULTRON_PAIRING", "--> [START] Claim Pairing Request")
        android.util.Log.d("ULTRON_PAIRING", "Target URL: $endpoint")
        android.util.Log.d("ULTRON_PAIRING", "HTTP Method: POST")

        try {
            val jsonBody = JSONObject().apply {
                put("pairingCode", pairingCode.trim().uppercase())
                put("deviceName", deviceName)
                put("platform", "Android")
                put("appVersion", appVersion)
            }

            val request = Request.Builder()
                .url(endpoint)
                .post(jsonBody.toString().toRequestBody(jsonMediaType))
                .build()

            val response = client.newCall(request).execute()
            val duration = System.currentTimeMillis() - startTime
            val responseBody = response.body?.string() ?: ""

            android.util.Log.d("ULTRON_PAIRING", "<-- [RESPONSE] in ${duration}ms: HTTP ${response.code}")

            if (!response.isSuccessful) {
                val errorMsg = try {
                    JSONObject(responseBody).optString("error", "HTTP ${response.code}")
                } catch (e: Exception) {
                    "HTTP ${response.code}: $responseBody"
                }
                return@withContext Result.failure(IOException(errorMsg))
            }

            val json = JSONObject(responseBody)
            Result.success(
                PairingResponse(
                    deviceId = json.getString("deviceId"),
                    deviceAuthToken = json.getString("deviceAuthToken"),
                    deviceName = json.getString("deviceName"),
                    userId = json.getString("userId"),
                    pairedAt = json.optString("pairedAt", "")
                )
            )
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - startTime
            android.util.Log.e("ULTRON_PAIRING", "<-- [EXCEPTION] in ${duration}ms: ${e.message}", e)
            Result.failure(e)
        }
    }

    suspend fun sendHeartbeat(
        serverUrl: String,
        deviceAuthToken: String
    ): Result<HeartbeatResponse> = withContext(Dispatchers.IO) {
        try {
            val normalizedUrl = serverUrl.trimEnd('/')
            val endpoint = "$normalizedUrl/api/devices/heartbeat"

            val request = Request.Builder()
                .url(endpoint)
                .header("Authorization", "Bearer $deviceAuthToken")
                .post("{}".toRequestBody(jsonMediaType))
                .build()

            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""

            if (!response.isSuccessful) {
                return@withContext Result.failure(IOException("Heartbeat failed (HTTP ${response.code})"))
            }

            val json = JSONObject(responseBody)
            Result.success(
                HeartbeatResponse(
                    success = json.optBoolean("success", true),
                    connectionStatus = json.optString("connectionStatus", "connected"),
                    lastSeenAt = json.optString("lastSeenAt", "")
                )
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun getRealtimeConfig(
        serverUrl: String,
        deviceAuthToken: String
    ): Result<RealtimeConfigResponse> = withContext(Dispatchers.IO) {
        val normalizedUrl = serverUrl.trimEnd('/')
        val endpoint = "$normalizedUrl/api/devices/realtime"
        val startTime = System.currentTimeMillis()

        android.util.Log.d("ULTRON_REALTIME", "--> [START] Realtime Config Request: $endpoint")

        try {
            val request = Request.Builder()
                .url(endpoint)
                .header("Authorization", "Bearer $deviceAuthToken")
                .get()
                .build()

            val response = client.newCall(request).execute()
            val duration = System.currentTimeMillis() - startTime
            val responseBody = response.body?.string() ?: ""

            android.util.Log.d("ULTRON_REALTIME", "<-- [RESPONSE] in ${duration}ms: HTTP ${response.code}")

            if (!response.isSuccessful) {
                val errorMsg = try {
                    JSONObject(responseBody).optString("error", "HTTP ${response.code}")
                } catch (e: Exception) {
                    "HTTP ${response.code}"
                }
                android.util.Log.e("ULTRON_REALTIME", "Realtime config error: $errorMsg")
                return@withContext Result.failure(IOException(errorMsg))
            }

            val json = JSONObject(responseBody)
            val config = RealtimeConfigResponse(
                success = json.optBoolean("success", true),
                configured = json.optBoolean("configured", false),
                provider = json.optString("provider", "supabase"),
                channel = json.optString("channel", ""),
                phoenixTopic = json.optString("phoenixTopic", "realtime:${json.optString("channel", "")}"),
                realtimeWsUrl = json.optString("realtimeWsUrl", ""),
                deviceId = json.optString("deviceId", ""),
                userId = json.optString("userId", ""),
                heartbeatIntervalMs = json.optLong("heartbeatIntervalMs", 25000L)
            )
            android.util.Log.d("ULTRON_REALTIME", "Realtime config parsed successfully: provider=${config.provider}")
            Result.success(config)
        } catch (e: Exception) {
            val duration = System.currentTimeMillis() - startTime
            android.util.Log.e("ULTRON_REALTIME", "<-- [EXCEPTION] in ${duration}ms: ${e.message}", e)
            Result.failure(e)
        }
    }

    suspend fun getWebSocketInfo(serverUrl: String): Result<String> = withContext(Dispatchers.IO) {
        val normalizedUrl = serverUrl.trimEnd('/')

        // Production Vercel / HTTPS URLs NEVER use legacy port 3001
        val isProduction = normalizedUrl.startsWith("https://") || normalizedUrl.contains("vercel.app")
        if (isProduction) {
            return@withContext Result.failure(
                IllegalStateException("Legacy WebSocket port 3001 is not supported in production. Use Supabase Realtime.")
            )
        }

        try {
            val endpoint = "$normalizedUrl/api/devices/ws"
            val request = Request.Builder()
                .url(endpoint)
                .get()
                .build()

            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""

            if (response.isSuccessful) {
                val json = JSONObject(responseBody)
                val wsUrl = json.optString("wsUrl", "")
                if (wsUrl.isNotEmpty() && !wsUrl.contains(":3001")) {
                    return@withContext Result.success(wsUrl)
                }
            }

            // Localhost fallback only
            val fallbackWs = normalizedUrl.replace("http://", "ws://")
            Result.success(fallbackWs)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
