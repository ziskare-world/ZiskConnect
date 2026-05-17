package com.ziskconnect.smsbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        AppLog.init(context.applicationContext)
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        for (message in messages) {
            val log = SmsLog(
                id = "incoming-${message.timestampMillis}-${message.originatingAddress.orEmpty()}",
                direction = "incoming",
                address = message.originatingAddress.orEmpty(),
                body = message.messageBody.orEmpty(),
                timestamp = message.timestampMillis,
                status = "received",
                sourceDevice = android.os.Build.MODEL
            )
            SmsBridgeClient(context.applicationContext).postIncomingSms(log)
        }
    }
}
