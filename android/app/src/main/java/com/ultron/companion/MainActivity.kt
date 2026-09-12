package com.ultron.companion

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.ultron.companion.data.DevicePreferences
import com.ultron.companion.databinding.ActivityMainBinding
import com.ultron.companion.network.ConnectionState
import com.ultron.companion.network.RealtimeConfigResponse
import com.ultron.companion.network.UltronApiClient
import com.ultron.companion.network.UltronRealtimeManager
import com.ultron.companion.service.HeartbeatService
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var preferences: DevicePreferences
    private val apiClient = UltronApiClient()
    private lateinit var realtimeManager: UltronRealtimeManager
    private val handler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        preferences = DevicePreferences(this)
        realtimeManager = UltronRealtimeManager.getInstance(applicationContext)

        setupUI()
        setupRealtimeListener()
        refreshState()
    }

    private fun setupUI() {
        binding.etServerUrl.setText(preferences.serverUrl)

        binding.btnPair.setOnClickListener {
            val serverUrl = binding.etServerUrl.text?.toString()?.trim() ?: ""
            val pairingCode = binding.etPairingCode.text?.toString()?.trim() ?: ""

            if (serverUrl.isEmpty()) {
                showMessage("Please enter a valid ULTRON server URL.")
                return@setOnClickListener
            }

            if (pairingCode.isEmpty()) {
                showMessage("Please enter the 6-character pairing code.")
                return@setOnClickListener
            }

            preferences.serverUrl = serverUrl
            performPairing(serverUrl, pairingCode)
        }

        binding.btnUnpair.setOnClickListener {
            performUnpair()
        }

        binding.btnSyncApps.setOnClickListener {
            val apps = realtimeManager.discoverInstalledApps()
            realtimeManager.broadcastAppCatalog()
            binding.tvDiscoveredApps.text = "Discovered Apps: ${apps.size} (Launcher Catalog)"
            showMessage("Discovered ${apps.size} installed apps. Catalog synced with ULTRON.")
        }
    }

    private fun setupRealtimeListener() {
        realtimeManager.addStateListener("MainActivity") { state, message, lastSeen ->
            runOnUiThread {
                updateConnectionState(state, message, lastSeen)
            }
        }
        realtimeManager.addCommandProcessedListener("MainActivity") { cmdId, status, result ->
            runOnUiThread {
                binding.tvStatusMessage.visibility = View.VISIBLE
                val type = result?.optString("type") ?: ""
                val appId = result?.optString("appId") ?: ""
                val actionDesc = when (type) {
                    "PONG" -> "PONG acknowledged"
                    "APP_LAUNCHED" -> "Launched $appId"
                    "APP_NOT_INSTALLED" -> "$appId not installed"
                    "CATALOG_SYNCED" -> "App catalog synced (${result?.optInt("count") ?: 0} apps)"
                    else -> "$status $type"
                }
                binding.tvStatusMessage.text = "Command $cmdId: $actionDesc"
            }
        }
    }

    private fun refreshState() {
        if (preferences.isPaired) {
            binding.layoutPairingForm.visibility = View.GONE
            binding.layoutPairedActions.visibility = View.VISIBLE
            binding.btnSyncApps.visibility = View.VISIBLE

            binding.tvDeviceInfo.text = "Device: ${preferences.deviceName} (${preferences.deviceId})"
            binding.tvAccountId.text = "Account ID: ${preferences.userId ?: "--"}"

            val appsCount = realtimeManager.getDiscoveredApps().size
            binding.tvDiscoveredApps.text = "Discovered Apps: $appsCount (Launcher Catalog)"

            // 1. Independent background REST Heartbeat Service (runs every 30s)
            HeartbeatService.start(this)

            // 2. Active Supabase Realtime connection
            connectRealtime()
        } else {
            HeartbeatService.stop(this)
            realtimeManager.disconnect()

            binding.layoutPairingForm.visibility = View.VISIBLE
            binding.layoutPairedActions.visibility = View.GONE
            binding.btnSyncApps.visibility = View.GONE

            binding.viewStatusDot.setCardBackgroundColor(getColor(R.color.ultron_subtext))
            binding.tvConnectionStatus.text = getString(R.string.status_unpaired)
            binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_subtext))
            binding.tvDeviceInfo.text = "Device: Not Paired"
            binding.tvAccountId.text = "Account ID: --"
            binding.tvDiscoveredApps.text = "Discovered Apps: --"
            binding.tvHeartbeatInfo.text = "Last Heartbeat: Never"
        }
    }

    private fun connectRealtime() {
        val token = preferences.deviceAuthToken ?: return
        val serverUrl = preferences.serverUrl

        lifecycleScope.launch {
            binding.tvConnectionStatus.text = getString(R.string.status_connecting)
            binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_amber))
            binding.tvStatusMessage.visibility = View.VISIBLE
            binding.tvStatusMessage.text = "Configuring Supabase Realtime channel…"

            // Send immediate initial REST heartbeat to update the UI
            launch {
                val hbResult = apiClient.sendHeartbeat(serverUrl, token)
                hbResult.onSuccess { hb ->
                    val timeStr = if (!hb.lastSeenAt.isNullOrEmpty()) {
                        hb.lastSeenAt
                    } else {
                        SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                    }
                    runOnUiThread {
                        binding.tvHeartbeatInfo.text = "Last Heartbeat: $timeStr"
                    }
                }
            }

            val configResult = apiClient.getRealtimeConfig(serverUrl, token)
            configResult.onSuccess { config ->
                android.util.Log.d("ULTRON_REALTIME", "Connecting to Realtime: provider=${config.provider}")
                realtimeManager.connect(config, token)
            }.onFailure { err ->
                val errorMsg = err.message ?: "Server error"
                android.util.Log.e("ULTRON_REALTIME", "Realtime config failed: $errorMsg", err)

                // Check for revoked/invalid device credentials (HTTP 401)
                if (errorMsg.contains("401") || errorMsg.contains("revoked", ignoreCase = true) || errorMsg.contains("Unauthorized", ignoreCase = true)) {
                    binding.tvConnectionStatus.text = getString(R.string.status_offline)
                    binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_red))
                    binding.tvStatusMessage.visibility = View.VISIBLE
                    binding.tvStatusMessage.text = "Device credentials invalid or revoked. Please unpair and re-pair."
                    return@onFailure
                }

                val isProduction = serverUrl.startsWith("https://") || serverUrl.contains("vercel.app")
                if (isProduction) {
                    // In production, NEVER fall back to port 3001
                    binding.tvConnectionStatus.text = getString(R.string.status_offline)
                    binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_red))
                    binding.tvStatusMessage.visibility = View.VISIBLE
                    binding.tvStatusMessage.text = "Realtime link offline: $errorMsg (REST heartbeat active)"

                    // Retry Realtime configuration in background
                    handler.postDelayed({
                        if (preferences.isPaired) {
                            connectRealtime()
                        }
                    }, 10_000L)
                } else {
                    // Local development fallback only on localhost
                    val wsResult = apiClient.getWebSocketInfo(serverUrl)
                    wsResult.onSuccess { wsUrl ->
                        val fallbackConfig = RealtimeConfigResponse(
                            success = true,
                            configured = false,
                            provider = "legacy_ws",
                            channel = "ultron:devices:${preferences.userId ?: "unknown"}",
                            phoenixTopic = "realtime:ultron:devices:${preferences.userId ?: "unknown"}",
                            realtimeWsUrl = wsUrl,
                            deviceId = preferences.deviceId ?: "",
                            userId = preferences.userId ?: ""
                        )
                        realtimeManager.connect(fallbackConfig, token)
                    }
                }
            }
        }
    }

    private fun updateConnectionState(state: ConnectionState, message: String?, lastSeen: String?) {
        when (state) {
            ConnectionState.CONNECTED -> {
                binding.viewStatusDot.setCardBackgroundColor(getColor(R.color.ultron_green))
                binding.tvConnectionStatus.text = getString(R.string.status_connected)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_green))
                val timeStr = if (!lastSeen.isNullOrEmpty()) {
                    lastSeen
                } else {
                    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                }
                binding.tvHeartbeatInfo.text = "Last Heartbeat: $timeStr"
                val appsCount = realtimeManager.getDiscoveredApps().size
                binding.tvDiscoveredApps.text = "Discovered Apps: $appsCount (Launcher Catalog)"
            }
            ConnectionState.CONNECTING -> {
                binding.viewStatusDot.setCardBackgroundColor(getColor(R.color.ultron_amber))
                binding.tvConnectionStatus.text = getString(R.string.status_connecting)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_amber))
            }
            ConnectionState.OFFLINE -> {
                binding.viewStatusDot.setCardBackgroundColor(getColor(R.color.ultron_red))
                binding.tvConnectionStatus.text = getString(R.string.status_offline)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_red))
            }
            ConnectionState.STANDBY -> {
                binding.viewStatusDot.setCardBackgroundColor(getColor(R.color.ultron_subtext))
                binding.tvConnectionStatus.text = getString(R.string.status_unpaired)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_subtext))
            }
        }

        if (!message.isNullOrEmpty()) {
            binding.tvStatusMessage.visibility = View.VISIBLE
            binding.tvStatusMessage.text = message
        }
    }

    private fun performPairing(serverUrl: String, pairingCode: String) {
        binding.btnPair.isEnabled = false
        binding.tvStatusMessage.visibility = View.VISIBLE
        binding.tvStatusMessage.text = "Authenticating pairing code with ULTRON…"

        lifecycleScope.launch {
            val result = apiClient.claimPairing(
                serverUrl = serverUrl,
                pairingCode = pairingCode,
                deviceName = preferences.deviceName
            )

            binding.btnPair.isEnabled = true

            result.onSuccess { pairData ->
                preferences.savePairing(
                    id = pairData.deviceId,
                    token = pairData.deviceAuthToken,
                    uId = pairData.userId,
                    name = pairData.deviceName
                )
                showMessage("Device successfully paired with ULTRON!")
                binding.etPairingCode.text?.clear()
                refreshState()
            }.onFailure { error ->
                showMessage("Pairing failed [${error.javaClass.simpleName}]: ${error.message} (Target: $serverUrl)")
            }
        }
    }

    private fun performUnpair() {
        HeartbeatService.stop(this)
        realtimeManager.disconnect()
        preferences.clearCredentials()
        showMessage("Device unpaired.")
        refreshState()
    }

    private fun showMessage(msg: String) {
        binding.tvStatusMessage.visibility = View.VISIBLE
        binding.tvStatusMessage.text = msg
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        realtimeManager.removeStateListener("MainActivity")
        realtimeManager.removeCommandProcessedListener("MainActivity")
        // Do not disconnect realtime link if paired; HeartbeatService continues background companion connectivity
        if (!preferences.isPaired) {
            realtimeManager.disconnect()
        }
        super.onDestroy()
    }
}
