package com.ziskconnect.smsbridge

import android.content.Context
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

object SmsStatusReporter {
    private val http = OkHttpClient()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    fun report(context: Context, commandId: String, status: String, message: String) {
        val current = BridgePrefs.load(context) ?: return
        val body = JSONObject()
            .put("status", status)
            .put("message", message)
        val encryptedBody = try {
            BridgeCrypto.encryptJson(current.token, body).toString()
        } catch (error: Exception) {
            AppLog.add("SMS status encryption failed: ${error.message}")
            return
        }
        val request = Request.Builder()
            .url("${current.baseUrl}/api/commands/$commandId/result")
            .header("x-pairing-token", current.token)
            .header("x-bridge-encrypted", "1")
            .post(encryptedBody.toRequestBody(jsonType))
            .build()
        http.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                AppLog.add("SMS status report failed: ${e.message}")
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
            }
        })
    }
}
