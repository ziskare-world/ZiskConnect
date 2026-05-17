package com.ziskconnect.smsbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class BridgeForegroundService : Service() {
    private lateinit var client: SmsBridgeClient
    private val handler = Handler(Looper.getMainLooper())
    private var connected = false
    private var connecting = false
    private var lastStatus = "Disconnected"
    private var retryAttempt = 0
    private var connectivityManager: ConnectivityManager? = null
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            handler.post {
                if (BridgePrefs.autoConnect(this@BridgeForegroundService) && !connected && !connecting) {
                    retryAttempt = 0
                    connect()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        AppLog.init(applicationContext)
        client = SmsBridgeClient(applicationContext)
        createChannel()
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        runCatching {
            connectivityManager?.registerNetworkCallback(NetworkRequest.Builder().build(), networkCallback)
        }.onFailure {
            AppLog.add("Network callback unavailable: ${it.message}")
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                BridgePrefs.setAutoConnect(this, false)
                disconnectAndStop("Disconnected")
                return START_NOT_STICKY
            }
            ACTION_QUERY_STATUS -> {
                publishStatus(lastStatus, connected = connected)
                if (!connected && !connecting && BridgePrefs.autoConnect(this) && BridgePrefs.load(this) != null) {
                    connect()
                } else if (!connected && !connecting) {
                    stopSelf()
                }
                return START_STICKY
            }
            ACTION_CONNECT -> connect()
            else -> connect()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        runCatching { connectivityManager?.unregisterNetworkCallback(networkCallback) }
        client.disconnect()
        super.onDestroy()
    }

    private fun connect() {
        if (connected || connecting) {
            publishStatus(lastStatus, connected = connected)
            BridgePrefs.load(this)?.let {
                startForeground(NOTIFICATION_ID, notification(if (connected) "Connected" else "Connecting", it))
            }
            return
        }
        val config = BridgePrefs.load(this)
        if (config == null) {
            publishStatus("Scan pairing QR first", connected = false)
            stopSelf()
            return
        }

        connecting = true
        publishStatus("Connecting to ${config.host}:${config.port}", connected = false)
        startForeground(NOTIFICATION_ID, notification("Connecting", config))
        client.connect(config) { message ->
            handler.post {
                connecting = false
                connected = message.startsWith("Connected")
                if (connected) retryAttempt = 0
                publishStatus(message, connected)
                startForeground(NOTIFICATION_ID, notification(if (connected) "Connected" else message, config))

                if (message.contains("Invalid pairing token") || message.contains("Pairing token changed")) {
                    BridgePrefs.setAutoConnect(this, false)
                    stopSelf()
                    return@post
                }
                if (message.contains("Device removed from dashboard")) {
                    BridgePrefs.setAutoConnect(this, false)
                    stopSelf()
                    return@post
                }

                if (!connected && BridgePrefs.autoConnect(this)) {
                    scheduleReconnect(config)
                }
            }
        }
    }

    private fun scheduleReconnect(config: BridgeConfig) {
        val delay = RETRY_DELAYS_MS[retryAttempt.coerceAtMost(RETRY_DELAYS_MS.lastIndex)]
        retryAttempt += 1
        val seconds = delay / 1000
        publishStatus("Waiting for server. Retrying in ${seconds}s", connected = false)
        startForeground(NOTIFICATION_ID, notification("Waiting for server", config))
        handler.removeCallbacksAndMessages(RETRY_TOKEN)
        handler.postAtTime({ connect() }, RETRY_TOKEN, android.os.SystemClock.uptimeMillis() + delay)
    }

    private fun disconnectAndStop(message: String) {
        connected = false
        connecting = false
        retryAttempt = 0
        handler.removeCallbacksAndMessages(RETRY_TOKEN)
        client.disconnect()
        publishStatus(message, connected = false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun notification(status: String, config: BridgeConfig?): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val disconnectIntent = PendingIntent.getService(
            this,
            2,
            Intent(this, BridgeForegroundService::class.java).setAction(ACTION_DISCONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val target = config?.baseUrl ?: "No server selected"
        val keepAlive = connected || connecting || BridgePrefs.autoConnect(this)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_app_logo)
            .setContentTitle("Zisk Connect")
            .setContentText("$status - $target")
            .setOngoing(keepAlive)
            .setContentIntent(openIntent)
            .addAction(0, "Disconnect", disconnectIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_bridge),
            NotificationManager.IMPORTANCE_LOW
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun publishStatus(message: String, connected: Boolean) {
        lastStatus = message
        AppLog.setBridgeConnected(connected)
        sendBroadcast(
            Intent(ACTION_STATUS)
                .setPackage(packageName)
                .putExtra(EXTRA_STATUS, message)
                .putExtra(EXTRA_CONNECTED, connected)
        )
        AppLog.add(message)
    }

    companion object {
        const val ACTION_CONNECT = "com.ziskconnect.smsbridge.CONNECT"
        const val ACTION_DISCONNECT = "com.ziskconnect.smsbridge.DISCONNECT"
        const val ACTION_QUERY_STATUS = "com.ziskconnect.smsbridge.QUERY_STATUS"
        const val ACTION_STATUS = "com.ziskconnect.smsbridge.STATUS"
        const val EXTRA_STATUS = "status"
        const val EXTRA_CONNECTED = "connected"
        private const val CHANNEL_ID = "bridge_connection"
        private const val NOTIFICATION_ID = 41
        private val RETRY_TOKEN = Any()
        private val RETRY_DELAYS_MS = longArrayOf(2000L, 5000L, 10000L, 20000L, 30000L)

        fun start(context: Context) {
            val intent = Intent(context, BridgeForegroundService::class.java).setAction(ACTION_CONNECT)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BridgeForegroundService::class.java).setAction(ACTION_DISCONNECT))
        }

        fun queryStatus(context: Context) {
            context.startService(Intent(context, BridgeForegroundService::class.java).setAction(ACTION_QUERY_STATUS))
        }
    }
}
