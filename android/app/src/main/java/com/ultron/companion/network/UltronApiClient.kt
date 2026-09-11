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
        android.util.Log.d("ULTRON_PAIRING", "Start Time: $startTime ms")
        android.util.Log.d("ULTRON_PAIRING", "Connect Timeout: ${client.connectTimeoutMillis} ms")
        android.util.Log.d("ULTRON_PAIRING", "Read Timeout: ${client.readTimeoutMillis} ms")

        try {
            val jsonBody = JSONObject().apply {
                put("pairingCode", pairingCode.trim().uppercase())
                put("deviceName", deviceName)
                put("platform", "Android")
                put("appVersion", appVersion)
            }

            android.util.Log.d("ULTRON_PAIRING", "Payload: $jsonBody")

            val request = Request.Builder()
                .url(endpoint)
                .post(jsonBody.toString().toRequestBody(jsonMediaType))
                .build()

            val response = client.newCall(request).execute()
            val duration = System.currentTimeMillis() - startTime
            val responseBody = response.body?.string() ?: ""

            android.util.Log.d("ULTRON_PAIRING", "<-- [RESPONSE] in ${duration}ms: HTTP ${response.code}")
            android.util.Log.d("ULTRON_PAIRING", "Response Body: $responseBody")

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
            android.util.Log.e("ULTRON_PAIRING", "<-- [EXCEPTION] in ${duration}ms: [${e.javaClass.name}] ${e.message}", e)
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
                return@withContext Result.failure(IOException("Heartbeat failed (${response.code})"))
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

    suspend fun getWebSocketInfo(serverUrl: String): Result<String> = withContext(Dispatchers.IO) {
        try {
            val normalizedUrl = serverUrl.trimEnd('/')
            val endpoint = "$normalizedUrl/api/devices/ws"

            val request = Request.Builder()
                .url(endpoint)
                .get()
                .build()

            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""

            if (response.isSuccessful) {
                val json = JSONObject(responseBody)
                var wsUrl = json.optString("wsUrl", "")
                if (normalizedUrl.startsWith("https://") && wsUrl.startsWith("ws://")) {
                    wsUrl = wsUrl.replace("ws://", "wss://")
                }
                if (wsUrl.isNotEmpty()) {
                    return@withContext Result.success(wsUrl)
                }
            }
            // Fallback derived WebSocket URL if not specified
            val fallbackWs = if (normalizedUrl.startsWith("https://")) {
                normalizedUrl.replace("https://", "wss://")
            } else {
                normalizedUrl.replace("http://", "ws://")
            }
            Result.success(fallbackWs)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
