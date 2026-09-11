package com.ultron.companion.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.ultron.companion.data.DevicePreferences
import com.ultron.companion.network.ConnectionState
import com.ultron.companion.network.UltronApiClient
import com.ultron.companion.network.UltronWebSocketManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class HeartbeatService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var preferences: DevicePreferences
    private val apiClient = UltronApiClient()
    private val wsManager = UltronWebSocketManager()

    override fun onCreate() {
        super.onCreate()
        preferences = DevicePreferences(this)
        createNotificationChannel()

        val notification = createNotification("ULTRON Companion Active", "Maintaining secure hardware link")
        startForeground(NOTIFICATION_ID, notification)

        wsManager.onStateChanged = { state, msg, lastSeen ->
            val statusText = when (state) {
                ConnectionState.CONNECTED -> "Connected // Link active"
                ConnectionState.CONNECTING -> "Connecting to ULTRON…"
                ConnectionState.OFFLINE -> "Offline // Reconnecting…"
                ConnectionState.STANDBY -> "Standby"
            }
            updateNotification(statusText)
        }

        connectToBackend()
    }

    private fun connectToBackend() {
        val token = preferences.deviceAuthToken
        val serverUrl = preferences.serverUrl

        if (!preferences.isPaired || token.isNullOrBlank()) {
            stopSelf()
            return
        }

        serviceScope.launch {
            val wsResult = apiClient.getWebSocketInfo(serverUrl)
            val wsUrl = wsResult.getOrDefault(
                if (serverUrl.startsWith("https://")) serverUrl.replace("https://", "wss://")
                else serverUrl.replace("http://", "ws://")
            )
            wsManager.connect(wsUrl, token)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            wsManager.disconnect()
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        wsManager.disconnect()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "ULTRON Companion Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Monitors real-time connection to ULTRON"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(title: String, text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(text: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIFICATION_ID, createNotification("ULTRON Companion Link", text))
    }

    companion object {
        const val CHANNEL_ID = "ultron_companion_channel"
        const val NOTIFICATION_ID = 101
        const val ACTION_DISCONNECT = "com.ultron.companion.ACTION_DISCONNECT"

        fun start(context: Context) {
            val intent = Intent(context, HeartbeatService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            val intent = Intent(context, HeartbeatService::class.java).apply {
                action = ACTION_DISCONNECT
            }
            context.startService(intent)
        }
    }
}
