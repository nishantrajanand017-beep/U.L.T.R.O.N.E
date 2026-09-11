package com.ultron.companion.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class DevicePreferences(context: Context) {

    private val prefs: SharedPreferences = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            "ultron_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        // Fallback to standard private preferences for testing/emulator compatibility
        context.getSharedPreferences("ultron_device_prefs", Context.MODE_PRIVATE)
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "http://10.0.2.2:3000") ?: "http://10.0.2.2:3000"
        set(value) = prefs.edit().putString(KEY_SERVER_URL, value.trim()).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var deviceAuthToken: String?
        get() = prefs.getString(KEY_DEVICE_AUTH_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_AUTH_TOKEN, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, "${Build.MANUFACTURER} ${Build.MODEL}") ?: "Android Device"
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_USER_ID, value).apply()

    val isPaired: Boolean
        get() = !deviceId.isNullOrBlank() && !deviceAuthToken.isNullOrBlank()

    fun savePairing(id: String, token: String, uId: String, name: String) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, id)
            .putString(KEY_DEVICE_AUTH_TOKEN, token)
            .putString(KEY_USER_ID, uId)
            .putString(KEY_DEVICE_NAME, name)
            .apply()
    }

    fun clearCredentials() {
        prefs.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_DEVICE_AUTH_TOKEN)
            .remove(KEY_USER_ID)
            .apply()
    }

    companion object {
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_AUTH_TOKEN = "device_auth_token"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_USER_ID = "user_id"
    }
}
