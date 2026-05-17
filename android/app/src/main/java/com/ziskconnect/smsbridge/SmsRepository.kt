package com.ziskconnect.smsbridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Telephony
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

data class SmsLog(
    val id: String,
    val direction: String,
    val address: String,
    val body: String,
    val timestamp: Long,
    val status: String,
    val sourceDevice: String,
    val commandId: String? = null
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("direction", direction)
        .put("address", address)
        .put("body", body)
        .put("timestamp", timestamp)
        .put("status", status)
        .put("sourceDevice", sourceDevice)
        .put("commandId", commandId)
}

object SmsRepository {
    fun hasReadPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED

    fun readRecent(context: Context, limit: Int = 100): JSONArray {
        val logs = JSONArray()
        if (!hasReadPermission(context)) return logs

        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE
        )
        val sort = "${Telephony.Sms.DATE} DESC LIMIT $limit"
        context.contentResolver.query(Uri.parse("content://sms"), projection, null, null, sort)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(Telephony.Sms._ID)
            val addressIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
            val bodyIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.BODY)
            val dateIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.DATE)
            val typeIndex = cursor.getColumnIndexOrThrow(Telephony.Sms.TYPE)
            while (cursor.moveToNext()) {
                val type = cursor.getInt(typeIndex)
                val direction = if (type == Telephony.Sms.MESSAGE_TYPE_SENT) "outgoing" else "incoming"
                logs.put(
                    SmsLog(
                        id = "sms-${cursor.getLong(idIndex)}",
                        direction = direction,
                        address = cursor.getString(addressIndex).orEmpty(),
                        body = cursor.getString(bodyIndex).orEmpty(),
                        timestamp = cursor.getLong(dateIndex),
                        status = if (direction == "outgoing") "sent" else "received",
                        sourceDevice = android.os.Build.MODEL
                    ).toJson()
                )
            }
        }
        return logs
    }
}
