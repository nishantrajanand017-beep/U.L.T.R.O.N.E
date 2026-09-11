package com.ultron.companion

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.ultron.companion.data.DevicePreferences
import com.ultron.companion.databinding.ActivityMainBinding
import com.ultron.companion.network.ConnectionState
import com.ultron.companion.network.UltronApiClient
import com.ultron.companion.network.UltronWebSocketManager
import com.ultron.companion.service.HeartbeatService
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var preferences: DevicePreferences
    private val apiClient = UltronApiClient()
    private val wsManager = UltronWebSocketManager()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        preferences = DevicePreferences(this)

        setupUI()
        setupWebSocketListener()
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
    }

    private fun setupWebSocketListener() {
        wsManager.onStateChanged = { state, message, lastSeen ->
            runOnUiThread {
                updateConnectionState(state, message, lastSeen)
            }
        }
    }

    private fun refreshState() {
        if (preferences.isPaired) {
            binding.layoutPairingForm.visibility = View.GONE
            binding.layoutPairedActions.visibility = View.VISIBLE

            binding.tvDeviceInfo.text = "Device: ${preferences.deviceName} (${preferences.deviceId})"
            binding.tvAccountId.text = "Account ID: ${preferences.userId ?: "--"}"

            connectRealtime()
        } else {
            binding.layoutPairingForm.visibility = View.VISIBLE
            binding.layoutPairedActions.visibility = View.GONE

            binding.tvConnectionStatus.text = getString(R.string.status_unpaired)
            binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_subtext))
            binding.tvDeviceInfo.text = "Device: Not Paired"
            binding.tvAccountId.text = "Account ID: --"
            binding.tvHeartbeatInfo.text = "Last Heartbeat: Never"

            wsManager.disconnect()
        }
    }

    private fun connectRealtime() {
        val token = preferences.deviceAuthToken ?: return
        val serverUrl = preferences.serverUrl

        lifecycleScope.launch {
            binding.tvConnectionStatus.text = getString(R.string.status_connecting)
            binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_amber))

            val wsResult = apiClient.getWebSocketInfo(serverUrl)
            var wsUrl = wsResult.getOrDefault(
                if (serverUrl.startsWith("https://")) serverUrl.replace("https://", "wss://")
                else serverUrl.replace("http://", "ws://")
            )
            if (serverUrl.startsWith("https://") && wsUrl.startsWith("ws://")) {
                wsUrl = wsUrl.replace("ws://", "wss://")
            }
            wsManager.connect(wsUrl, token)
        }
    }

    private fun updateConnectionState(state: ConnectionState, message: String?, lastSeen: String?) {
        when (state) {
            ConnectionState.CONNECTED -> {
                binding.tvConnectionStatus.text = getString(R.string.status_connected)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_green))
                val timeStr = if (!lastSeen.isNullOrEmpty()) {
                    lastSeen
                } else {
                    SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
                }
                binding.tvHeartbeatInfo.text = "Last Heartbeat: $timeStr"
            }
            ConnectionState.CONNECTING -> {
                binding.tvConnectionStatus.text = getString(R.string.status_connecting)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_amber))
            }
            ConnectionState.OFFLINE -> {
                binding.tvConnectionStatus.text = getString(R.string.status_offline)
                binding.tvConnectionStatus.setTextColor(getColor(R.color.ultron_red))
            }
            ConnectionState.STANDBY -> {
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
        wsManager.disconnect()
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
        wsManager.disconnect()
        super.onDestroy()
    }
}
