package com.ziskconnect.smsbridge

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.telephony.SubscriptionManager
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class SmsBridgeClient(private val context: Context) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var config: BridgeConfig? = null
    private var connectionGeneration = 0
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val deviceId = "${Build.MANUFACTURER}-${Build.MODEL}-${Build.DEVICE}"

    fun connect(newConfig: BridgeConfig, onStatus: (String) -> Unit) {
        connectionGeneration += 1
        val generation = connectionGeneration
        config = newConfig
        BridgePrefs.save(context, newConfig)
        socket?.cancel()
        socket = null
        registerDevice(newConfig) { ok, message ->
            if (generation != connectionGeneration) return@registerDevice
            if (!ok) {
                onStatus("Register failed: $message")
                return@registerDevice
            }
            AppLog.add("Registered device with dashboard")
            openSocket(newConfig, generation, onStatus)
        }
    }

    fun disconnect() {
        connectionGeneration += 1
        socket?.close(1000, "Disconnected by user")
        socket = null
        AppLog.add("Disconnected")
    }

    fun syncSms(onStatus: (String) -> Unit) {
        val current = config ?: BridgePrefs.load(context)
        if (current == null) {
            onStatus("Connect first")
            return
        }
        val body = JSONObject().put("logs", SmsRepository.readRecent(context)).toString()
        post(current, "/api/sms/sync", body) { ok, message ->
            onStatus(message)
            AppLog.add(if (ok) "SMS logs synced" else "SMS sync failed: $message")
        }
    }

    fun postIncomingSms(log: SmsLog) {
        val current = BridgePrefs.load(context) ?: return
        post(current, "/api/sms/event", log.toJson().toString()) { ok, message ->
            if (ok) AppLog.addSms("Received SMS from ${log.address}")
            AppLog.add(if (ok) "Incoming SMS forwarded" else "Forward failed: $message")
        }
    }

    private fun registerDevice(current: BridgeConfig, done: (Boolean, String) -> Unit) {
        val body = JSONObject()
            .put("id", deviceId)
            .put("deviceName", deviceName())
            .put("manufacturer", Build.MANUFACTURER)
            .put("model", Build.MODEL)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("selectedSubscriptionId", current.subscriptionId)
            .put("selectedSimLabel", simLabel(current.subscriptionId))
            .put("sims", simList())
            .toString()
        post(current, "/api/device/register", body) { ok, message ->
            AppLog.add(if (ok) "Registered device with dashboard" else "Register failed: $message")
            done(ok, message)
        }
    }

    private fun openSocket(current: BridgeConfig, generation: Int, onStatus: (String) -> Unit) {
        val request = Request.Builder().url(current.wsUrl(deviceId)).build()
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation != connectionGeneration) {
                    webSocket.close(1000, "Stale connection")
                    return
                }
                AppLog.add("Command socket connected")
                onStatus("Connected to ${current.baseUrl}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != connectionGeneration) return
                handleSocketMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation != connectionGeneration) return
                if (socket === webSocket) socket = null
                val message = if (response?.code == 401) {
                    "Invalid pairing token. Scan the latest QR code."
                } else if (response?.code == 403) {
                    "Device removed from dashboard."
                } else {
                    "Socket failed: ${t.message}"
                }
                AppLog.add(message)
                onStatus(message)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (generation != connectionGeneration) return
                if (socket === webSocket) socket = null
                val message = if (code == 4001) {
                    "Pairing token changed. Scan the latest QR code."
                } else if (code == 4002) {
                    "Device removed from dashboard."
                } else {
                    "Disconnected"
                }
                AppLog.add(message)
                onStatus(message)
            }
        })
    }

    private fun handleSocketMessage(text: String) {
        val message = JSONObject(text)
        if (message.optString("event") == "command:new") {
            executeCommand(message.getJSONObject("data"))
        }
        if (message.optString("event") == "state") {
            val pending = message.getJSONObject("data").optJSONArray("pendingCommands") ?: JSONArray()
            for (i in 0 until pending.length()) executeCommand(pending.getJSONObject(i))
        }
    }

    private fun executeCommand(command: JSONObject) {
        val id = command.getString("id")
        val type = command.getString("type")
        val payload = try {
            commandPayload(command)
        } catch (error: Exception) {
            completeCommand(id, "failed", "Command payload decrypt failed")
            AppLog.add("Command payload decrypt failed: ${error.message}")
            return
        }
        when (type) {
            "send_sms" -> sendNormalSms(id, payload.optString("address"), payload.optString("body"))
            "send_flash_sms" -> completeCommand(id, "unsupported", "Flash/Class-0 SMS is not available through Android public SDK APIs.")
            else -> completeCommand(id, "failed", "Unknown command type: $type")
        }
    }

    private fun commandPayload(command: JSONObject): JSONObject {
        val payload = command.getJSONObject("payload")
        val current = config ?: BridgePrefs.load(context) ?: return payload
        return if (command.optBoolean("payloadEncrypted") || payload.optBoolean("encrypted")) {
            BridgeCrypto.decryptJson(current.token, payload)
        } else {
            payload
        }
    }

    private fun sendNormalSms(commandId: String, address: String, body: String) {
        val securityError = smsSecurityError(commandId, address, body)
        if (securityError != null) {
            AppLog.addSms("Send blocked: $securityError")
            completeCommand(commandId, "failed", "Security check failed: $securityError")
            return
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            AppLog.addSms("Send failed to $address: SEND_SMS permission is not granted")
            completeCommand(commandId, "failed", "SEND_SMS permission is not granted")
            return
        }
        if (address.isBlank() || body.isBlank()) {
            AppLog.addSms("Send failed: recipient and message are required")
            completeCommand(commandId, "failed", "Recipient and message are required")
            return
        }

        try {
            val sentIntent = PendingIntent.getBroadcast(
                context,
                commandId.hashCode(),
                Intent(context, SmsStatusReceiver::class.java)
                    .setAction(SmsStatusReceiver.ACTION_SMS_SENT)
                    .putExtra(SmsStatusReceiver.EXTRA_COMMAND_ID, commandId)
                    .putExtra(SmsStatusReceiver.EXTRA_ADDRESS, address),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val deliveredIntent = PendingIntent.getBroadcast(
                context,
                commandId.hashCode() + 1,
                Intent(context, SmsStatusReceiver::class.java)
                    .setAction(SmsStatusReceiver.ACTION_SMS_DELIVERED)
                    .putExtra(SmsStatusReceiver.EXTRA_COMMAND_ID, commandId)
                    .putExtra(SmsStatusReceiver.EXTRA_ADDRESS, address),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            val selectedSubscriptionId = BridgePrefs.load(context)?.subscriptionId ?: BridgePrefs.DEFAULT_SUBSCRIPTION_ID
            val smsManager = if (selectedSubscriptionId == BridgePrefs.DEFAULT_SUBSCRIPTION_ID) {
                SmsManager.getDefault()
            } else {
                SmsManager.getSmsManagerForSubscriptionId(selectedSubscriptionId)
            }
            smsManager.sendTextMessage(address, null, body, sentIntent, deliveredIntent)
            val simLabel = if (selectedSubscriptionId == BridgePrefs.DEFAULT_SUBSCRIPTION_ID) "default SIM" else "SIM subscription $selectedSubscriptionId"
            completeCommand(commandId, "submitted", "SMS submitted through $simLabel")
            AppLog.addSms("Submitted SMS to $address using $simLabel")
            AppLog.add("SMS submitted for $address using $simLabel")
        } catch (error: Exception) {
            AppLog.addSms("Send failed to $address: ${error.message ?: "SMS send failed"}")
            completeCommand(commandId, "failed", error.message ?: "SMS send failed")
        }
    }

    private fun smsSecurityError(commandId: String, address: String, body: String): String? {
        if ((config ?: BridgePrefs.load(context)) == null) return "phone is not paired"
        if (commandId.isBlank()) return "missing command id"
        val normalizedAddress = address.trim()
        if (!Regex("^\\+?[0-9]{5,15}$").matches(normalizedAddress)) return "invalid recipient number"
        if (body.isBlank()) return "message is empty"
        if (body.length > 1600) return "message is too long"
        if (body.any { Character.isISOControl(it) && it != '\n' && it != '\r' && it != '\t' }) return "message contains blocked control characters"
        return null
    }

    private fun deviceName(): String {
        return runCatching {
            Settings.Global.getString(context.contentResolver, "device_name")
        }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: runCatching {
                Settings.Secure.getString(context.contentResolver, "bluetooth_name")
            }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER} ${Build.MODEL}"
    }

    private fun simList(): JSONArray {
        val sims = JSONArray()
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return sims
        }
        val manager = context.getSystemService(SubscriptionManager::class.java)
        for (sim in manager.activeSubscriptionInfoList.orEmpty()) {
            sims.put(
                JSONObject()
                    .put("subscriptionId", sim.subscriptionId)
                    .put("slotIndex", sim.simSlotIndex)
                    .put("label", sim.displayName?.toString()?.takeIf { it.isNotBlank() } ?: "SIM ${sim.simSlotIndex + 1}")
            )
        }
        return sims
    }

    private fun simLabel(subscriptionId: Int): String {
        if (subscriptionId == BridgePrefs.DEFAULT_SUBSCRIPTION_ID) return "System default SIM"
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return "SIM subscription $subscriptionId"
        }
        val manager = context.getSystemService(SubscriptionManager::class.java)
        val sim = manager.activeSubscriptionInfoList.orEmpty().firstOrNull { it.subscriptionId == subscriptionId }
        return sim?.displayName?.toString()?.takeIf { it.isNotBlank() } ?: "SIM subscription $subscriptionId"
    }

    private fun completeCommand(id: String, status: String, message: String) {
        val current = config ?: BridgePrefs.load(context) ?: return
        val body = JSONObject()
            .put("status", status)
            .put("message", message)
            .toString()
        post(current, "/api/commands/$id/result", body) { ok, result ->
            AppLog.add(if (ok) "Command $id result: $status" else "Command result failed: $result")
        }
    }

    private fun post(current: BridgeConfig, path: String, json: String, done: (Boolean, String) -> Unit) {
        val encryptedBody = try {
            BridgeCrypto.encryptJson(current.token, JSONObject(json)).toString()
        } catch (error: Exception) {
            done(false, "Encryption failed: ${error.message}")
            return
        }
        val request = Request.Builder()
            .url("${current.baseUrl}$path")
            .header("x-pairing-token", current.token)
            .header("x-bridge-encrypted", "1")
            .post(encryptedBody.toRequestBody(jsonType))
            .build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                done(false, e.message ?: "Network error")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    val body = it.body?.string().orEmpty().ifBlank { it.message }
                    val message = if (it.code == 401) {
                        "Invalid pairing token. Scan the latest QR code."
                    } else if (it.code == 403) {
                        "Device removed from dashboard."
                    } else {
                        body
                    }
                    done(it.isSuccessful, message)
                }
            }
        })
    }
}
