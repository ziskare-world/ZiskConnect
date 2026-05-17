package com.ziskconnect.smsbridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager

class SmsStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AppLog.init(context.applicationContext)
        val commandId = intent.getStringExtra(EXTRA_COMMAND_ID) ?: return
        val address = intent.getStringExtra(EXTRA_ADDRESS).orEmpty()
        when (intent.action) {
            ACTION_SMS_SENT -> handleSent(context, commandId, address)
            ACTION_SMS_DELIVERED -> handleDelivered(context, commandId, address)
        }
    }

    private fun handleSent(context: Context, commandId: String, address: String) {
        if (resultCode == Activity.RESULT_OK) {
            AppLog.addSms("SMS sent to $address")
            SmsStatusReporter.report(context, commandId, "sent", "SMS sent by carrier")
            return
        }
        val message = when (resultCode) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "Generic SMS failure"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "No service"
            SmsManager.RESULT_ERROR_NULL_PDU -> "Null PDU"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "Radio off"
            else -> "SMS send failed: $resultCode"
        }
        AppLog.addSms("Send failed to $address: $message")
        SmsStatusReporter.report(context, commandId, "failed", message)
    }

    private fun handleDelivered(context: Context, commandId: String, address: String) {
        if (resultCode == Activity.RESULT_OK) {
            AppLog.addSms("SMS delivered to $address")
            SmsStatusReporter.report(context, commandId, "delivered", "SMS delivery confirmed")
            return
        }
        AppLog.addSms("Delivery not confirmed for $address")
        SmsStatusReporter.report(context, commandId, "undelivered", "SMS delivery failed or was not confirmed")
    }

    companion object {
        const val ACTION_SMS_SENT = "com.ziskconnect.smsbridge.SMS_SENT"
        const val ACTION_SMS_DELIVERED = "com.ziskconnect.smsbridge.SMS_DELIVERED"
        const val EXTRA_COMMAND_ID = "commandId"
        const val EXTRA_ADDRESS = "address"
    }
}
