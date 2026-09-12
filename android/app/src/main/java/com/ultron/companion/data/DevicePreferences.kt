package com.ultron.companion.data

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class DevicePreferences(context: Context) {

    var isEncryptedStorage: Boolean = false
        private set

    private val prefs: SharedPreferences = run {
        var securePrefs: SharedPreferences? = null
        try {
            securePrefs = createEncryptedPrefs(context)
            isEncryptedStorage = true
        } catch (t: Throwable) {
            android.util.Log.w("ULTRON_PREFS", "Encrypted storage init failed: ${t.javaClass.simpleName}. Attempting key recovery...")
            try {
                // Recover from stale/corrupted keyset (common across re-installs on API 34+)
                context.deleteSharedPreferences("ultron_secure_prefs")
                securePrefs = createEncryptedPrefs(context)
                isEncryptedStorage = true
            } catch (t2: Throwable) {
                android.util.Log.w("ULTRON_PREFS", "Encrypted storage recovery failed. Falling back to application-private storage.")
                isEncryptedStorage = false
            }
        }

        if (securePrefs != null && isEncryptedStorage) {
            securePrefs
        } else {
            val fallback = context.getSharedPreferences("ultron_device_prefs", Context.MODE_PRIVATE)
            // Security requirement: if encrypted storage is unavailable, invalidate plaintext token
            fallback.edit().remove(KEY_DEVICE_AUTH_TOKEN).apply()
            fallback
        }
    }

    private fun createEncryptedPrefs(context: Context): SharedPreferences {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        return EncryptedSharedPreferences.create(
            context,
            "ultron_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, "https://u-l-t-r-o-n-e.vercel.app") ?: "https://u-l-t-r-o-n-e.vercel.app"
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
