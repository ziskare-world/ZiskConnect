package com.ziskconnect.smsbridge

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.telephony.SubscriptionManager
import android.view.LayoutInflater
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

class MainActivity : AppCompatActivity() {
    private lateinit var contentFrame: FrameLayout
    private lateinit var client: SmsBridgeClient
    private var ipInput: TextView? = null
    private var portInput: TextView? = null
    private var simSpinner: Spinner? = null
    private var autoConnectCheck: CheckBox? = null
    private var connectButton: Button? = null
    private var statusText: TextView? = null
    private var logsText: TextView? = null
    private var permissionStatusText: TextView? = null
    private var simPermissionStatusText: TextView? = null
    private var notificationPermissionStatusText: TextView? = null
    private var connected = false
    private var connecting = false
    private var pendingConnectIsAuto = false
    private val autoConnectHandler = Handler(Looper.getMainLooper())
    private val autoConnectRunnable = Runnable {
        if (!connected && BridgePrefs.autoConnect(this)) {
            startBridgeFromFields(isAuto = true)
        }
    }
    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != BridgeForegroundService.ACTION_STATUS) return
            val message = intent.getStringExtra(BridgeForegroundService.EXTRA_STATUS).orEmpty()
            connected = intent.getBooleanExtra(BridgeForegroundService.EXTRA_CONNECTED, false)
            connecting = false
            updateStatus(message)
            connectButton?.text = if (connected) "Disconnect" else "Connect"
            if (message.contains("Invalid pairing token") || message.contains("Pairing token changed")) {
                BridgePrefs.setAutoConnect(this@MainActivity, false)
                autoConnectCheck?.isChecked = false
                autoConnectHandler.removeCallbacks(autoConnectRunnable)
            }
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) {
        updatePermissionStatus()
        AppLog.add("Permission request completed")
    }

    private val simPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        updatePermissionStatus()
        AppLog.add("SIM list permission request completed")
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) {
        updatePermissionStatus()
        AppLog.add("Notification permission ${if (it) "granted" else "denied"}")
        if (it) startBridgeFromFields(isAuto = pendingConnectIsAuto)
    }

    private val qrScanner = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents
        if (contents.isNullOrBlank()) {
            updateStatus("QR scan cancelled")
            return@registerForActivityResult
        }
        applyPairingPayload(contents)
    }

    private val logListener: (List<String>) -> Unit = { lines ->
        runOnUiThread {
            logsText?.text = if (lines.isEmpty()) "No logs yet" else lines.joinToString("\n")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        AppLog.init(applicationContext)
        client = SmsBridgeClient(applicationContext)
        contentFrame = findViewById(R.id.contentFrame)

        findViewById<BottomNavigationView>(R.id.bottomNavigation).setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_home -> showHome()
                R.id.nav_logs -> showLogs()
                R.id.nav_permission -> showPermission()
            }
            true
        }
        showHome()
    }

    override fun onStart() {
        super.onStart()
        val filter = IntentFilter(BridgeForegroundService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(statusReceiver, filter)
        }
        BridgeForegroundService.queryStatus(this)
    }

    override fun onStop() {
        unregisterReceiver(statusReceiver)
        super.onStop()
    }

    override fun onDestroy() {
        autoConnectHandler.removeCallbacks(autoConnectRunnable)
        AppLog.remove(logListener)
        super.onDestroy()
    }

    private fun inflate(layout: Int): View {
        contentFrame.removeAllViews()
        return LayoutInflater.from(this).inflate(layout, contentFrame, true)
    }

    private fun showHome() {
        val view = inflate(R.layout.view_home)
        ipInput = view.findViewById(R.id.ipInput)
        portInput = view.findViewById(R.id.portInput)
        simSpinner = view.findViewById(R.id.simSpinner)
        autoConnectCheck = view.findViewById(R.id.autoConnectCheck)
        connectButton = view.findViewById(R.id.connectButton)
        val syncButton = view.findViewById<Button>(R.id.syncButton)
        val scanPairingButton = view.findViewById<Button>(R.id.scanPairingButton)
        statusText = view.findViewById(R.id.statusText)

        BridgePrefs.load(this)?.let {
            showBridgeTarget(it)
        }
        loadSimOptions()
        autoConnectCheck?.isChecked = BridgePrefs.autoConnect(this)
        autoConnectCheck?.setOnCheckedChangeListener { _, isChecked ->
            BridgePrefs.setAutoConnect(this, isChecked)
            if (isChecked) scheduleAutoConnect(delayMs = 300)
            else autoConnectHandler.removeCallbacks(autoConnectRunnable)
        }

        scanPairingButton.setOnClickListener {
            val options = ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("Scan dashboard pairing QR")
                .setBeepEnabled(true)
                .setOrientationLocked(false)
            qrScanner.launch(options)
        }

        connectButton?.setOnClickListener {
            if (connected) {
                BridgeForegroundService.stop(this)
                BridgePrefs.setAutoConnect(this, false)
                autoConnectCheck?.isChecked = false
                autoConnectHandler.removeCallbacks(autoConnectRunnable)
                connected = false
                connectButton?.text = "Connect"
                updateStatus("Disconnected")
                return@setOnClickListener
            }

            if (ensureNotificationPermission(isAuto = false)) {
                startBridgeFromFields(isAuto = false)
            }
        }

        syncButton.setOnClickListener {
            client.syncSms { updateStatus(it) }
        }

        if (BridgePrefs.autoConnect(this) && BridgePrefs.load(this) != null) {
            scheduleAutoConnect(delayMs = 300)
        }
    }

    private fun startBridgeFromFields(isAuto: Boolean) {
        if (connected || connecting) return
        if (!ensureNotificationPermission(isAuto)) return

        val saved = BridgePrefs.load(this)
        if (saved == null || saved.token.isBlank()) {
            updateStatus("Scan pairing QR first")
            return
        }

        val config = saved.copy(subscriptionId = selectedSubscriptionId())
        BridgePrefs.save(this, config)
        connecting = true
        updateStatus(if (isAuto) "Auto connecting..." else "Connecting...")
        BridgeForegroundService.start(this)
    }

    private fun ensureNotificationPermission(isAuto: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            pendingConnectIsAuto = isAuto
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        return granted
    }

    private fun scheduleAutoConnect(delayMs: Long = 5000L) {
        autoConnectHandler.removeCallbacks(autoConnectRunnable)
        autoConnectHandler.postDelayed(autoConnectRunnable, delayMs)
    }

    private fun applyPairingPayload(payload: String) {
        try {
            val parsed = if (payload.trim().startsWith("{")) {
                val json = JSONObject(payload)
                BridgeConfig(
                    scheme = json.optString("scheme", json.optString("protocol", "http")),
                    host = json.getString("host"),
                    port = json.optInt("port", 3001),
                    token = json.getString("token"),
                    subscriptionId = selectedSubscriptionId()
                )
            } else {
                val uri = Uri.parse(payload)
                BridgeConfig(
                    scheme = uri.getQueryParameter("scheme") ?: uri.scheme ?: "http",
                    host = uri.getQueryParameter("host") ?: "127.0.0.1",
                    port = uri.getQueryParameter("port")?.toIntOrNull() ?: 3001,
                    token = uri.getQueryParameter("token").orEmpty(),
                    subscriptionId = selectedSubscriptionId()
                )
            }

            if (parsed.token.isBlank()) {
                updateStatus("QR code is missing pairing token")
                return
            }

            BridgePrefs.save(this, parsed)
            BridgePrefs.setAutoConnect(this, true)
            showBridgeTarget(parsed)
            autoConnectCheck?.isChecked = true
            updateStatus("Pairing QR loaded")
            AppLog.add("Pairing QR loaded for ${parsed.host}:${parsed.port}")
            scheduleAutoConnect(delayMs = 300)
        } catch (error: Exception) {
            updateStatus("Invalid pairing QR")
            AppLog.add("Invalid pairing QR: ${error.message}")
        }
    }

    private fun showLogs() {
        val view = inflate(R.layout.view_logs)
        logsText = view.findViewById(R.id.logsText)
        AppLog.remove(logListener)
        view.findViewById<View>(R.id.clearLogsButton).setOnClickListener {
            AppLog.clearSms()
        }
        AppLog.listenSms(logListener)
    }

    private fun showBridgeTarget(config: BridgeConfig) {
        ipInput?.text = "IP address: ${config.scheme}://${config.host}"
        portInput?.text = "Port: ${config.port}"
    }

    private fun showPermission() {
        val view = inflate(R.layout.view_permission)
        permissionStatusText = view.findViewById(R.id.permissionStatusText)
        simPermissionStatusText = view.findViewById(R.id.simPermissionStatusText)
        notificationPermissionStatusText = view.findViewById(R.id.notificationPermissionStatusText)
        view.findViewById<Button>(R.id.requestPermissionsButton).setOnClickListener {
            permissionLauncher.launch(SMS_PERMISSIONS)
        }
        view.findViewById<Button>(R.id.requestSimPermissionButton).setOnClickListener {
            simPermissionLauncher.launch(Manifest.permission.READ_PHONE_STATE)
        }
        view.findViewById<Button>(R.id.requestNotificationPermissionButton).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                updatePermissionStatus()
            }
        }
        updatePermissionStatus()
    }

    private fun loadSimOptions() {
        val options = mutableListOf(SimOption("System default SIM", BridgePrefs.DEFAULT_SUBSCRIPTION_ID))
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            val manager = getSystemService(SubscriptionManager::class.java)
            val sims = manager.activeSubscriptionInfoList.orEmpty()
            for (sim in sims) {
                val name = sim.displayName?.toString()?.takeIf { it.isNotBlank() } ?: "SIM ${sim.simSlotIndex + 1}"
                val number = sim.number?.takeIf { it.isNotBlank() }?.let { " - $it" }.orEmpty()
                options.add(SimOption("$name$number", sim.subscriptionId))
            }
        } else {
            options.add(SimOption("Grant phone permission to list SIMs", BridgePrefs.DEFAULT_SUBSCRIPTION_ID))
        }

        val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, options)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        simSpinner?.adapter = adapter

        val savedId = BridgePrefs.load(this)?.subscriptionId ?: BridgePrefs.DEFAULT_SUBSCRIPTION_ID
        val savedIndex = options.indexOfFirst { it.subscriptionId == savedId }.takeIf { it >= 0 } ?: 0
        simSpinner?.setSelection(savedIndex)
    }

    private fun selectedSubscriptionId(): Int {
        val option = simSpinner?.selectedItem as? SimOption
        return option?.subscriptionId ?: BridgePrefs.DEFAULT_SUBSCRIPTION_ID
    }

    private fun updateStatus(message: String) {
        runOnUiThread {
            statusText?.text = message
        }
    }

    private fun updatePermissionStatus() {
        val text = SMS_PERMISSIONS.joinToString("\n") { permission ->
            val granted = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
            "${permission.substringAfterLast('.')}  ${if (granted) "granted" else "denied"}"
        }
        permissionStatusText?.text = text
        val simGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        simPermissionStatusText?.text = "READ_PHONE_STATE  ${if (simGranted) "granted - SIM list available" else "denied - grant to list SIM cards"}"
        val notificationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        notificationPermissionStatusText?.text = "POST_NOTIFICATIONS  ${if (notificationGranted) "granted - connected status can show" else "denied - notification may not be visible"}"
        if (simSpinner != null) loadSimOptions()
    }

    companion object {
        private val SMS_PERMISSIONS = arrayOf(
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.SEND_SMS
        )
    }
}
