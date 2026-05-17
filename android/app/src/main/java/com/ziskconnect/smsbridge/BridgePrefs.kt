package com.ziskconnect.smsbridge

import android.content.Context
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

data class BridgeConfig(
    val scheme: String = "http",
    val host: String,
    val port: Int,
    val token: String,
    val subscriptionId: Int = -1
) {
    private val normalizedScheme: String get() = if (scheme.equals("https", ignoreCase = true)) "https" else "http"
    private val portSuffix: String get() = if ((normalizedScheme == "https" && port == 443) || (normalizedScheme == "http" && port == 80)) "" else ":$port"
    val baseUrl: String get() = "$normalizedScheme://$host$portSuffix"
    fun wsUrl(deviceId: String): String {
        val encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8.name())
        val encodedDeviceId = URLEncoder.encode(deviceId, StandardCharsets.UTF_8.name())
        val wsScheme = if (normalizedScheme == "https") "wss" else "ws"
        return "$wsScheme://$host$portSuffix/?role=device&token=$encodedToken&deviceId=$encodedDeviceId"
    }
}

object BridgePrefs {
    private const val PREFS = "bridge_prefs"
    private const val SCHEME = "scheme"
    private const val HOST = "host"
    private const val PORT = "port"
    private const val TOKEN = "token"
    private const val SUBSCRIPTION_ID = "subscription_id"
    private const val AUTO_CONNECT = "auto_connect"
    const val DEFAULT_SUBSCRIPTION_ID = -1

    fun save(context: Context, config: BridgeConfig) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(SCHEME, if (config.scheme.equals("https", ignoreCase = true)) "https" else "http")
            .putString(HOST, config.host)
            .putInt(PORT, config.port)
            .putString(TOKEN, config.token)
            .putInt(SUBSCRIPTION_ID, config.subscriptionId)
            .apply()
    }

    fun load(context: Context): BridgeConfig? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val token = prefs.getString(TOKEN, null).orEmpty()
        if (token.isBlank()) return null
        return BridgeConfig(
            scheme = prefs.getString(SCHEME, "http") ?: "http",
            host = prefs.getString(HOST, "127.0.0.1") ?: "127.0.0.1",
            port = prefs.getInt(PORT, 3001),
            token = token,
            subscriptionId = prefs.getInt(SUBSCRIPTION_ID, DEFAULT_SUBSCRIPTION_ID)
        )
    }

    fun setAutoConnect(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(AUTO_CONNECT, enabled)
            .apply()
    }

    fun autoConnect(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(AUTO_CONNECT, true)
}
