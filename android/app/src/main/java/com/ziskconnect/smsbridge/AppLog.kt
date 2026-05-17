package com.ziskconnect.smsbridge

import android.content.Context
import org.json.JSONArray

object AppLog {
    private const val PREFS = "zisk_connect_sms_logs"
    private const val KEY_SMS_LINES = "smsLines"
    private val lines = mutableListOf<String>()
    private val smsLines = mutableListOf<String>()
    private val listeners = mutableSetOf<(List<String>) -> Unit>()
    private val smsListeners = mutableSetOf<(List<String>) -> Unit>()
    private var bridgeConnected = false
    private var appContext: Context? = null
    private var loaded = false

    fun init(context: Context) {
        appContext = context.applicationContext
        if (loaded) return
        loaded = true
        val stored = appContext
            ?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.getString(KEY_SMS_LINES, "[]")
            .orEmpty()
        runCatching {
            val array = JSONArray(stored)
            smsLines.clear()
            for (i in 0 until array.length()) smsLines.add(array.getString(i))
        }
    }

    fun add(message: String) {
        val line = "${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}  $message"
        lines.add(0, line)
        while (lines.size > 200) lines.removeAt(lines.lastIndex)
        listeners.forEach { it(lines.toList()) }
    }

    fun addSms(message: String) {
        if (!bridgeConnected) return
        val line = "${java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())}  $message"
        smsLines.add(0, line)
        while (smsLines.size > 200) smsLines.removeAt(smsLines.lastIndex)
        saveSms()
        smsListeners.forEach { it(smsLines.toList()) }
    }

    fun setBridgeConnected(connected: Boolean) {
        bridgeConnected = connected
    }

    fun listen(listener: (List<String>) -> Unit) {
        listeners.add(listener)
        listener(lines.toList())
    }

    fun listenSms(listener: (List<String>) -> Unit) {
        smsListeners.add(listener)
        listener(smsLines.toList())
    }

    fun remove(listener: (List<String>) -> Unit) {
        listeners.remove(listener)
        smsListeners.remove(listener)
    }

    fun clearSms() {
        smsLines.clear()
        saveSms()
        smsListeners.forEach { it(emptyList()) }
    }

    private fun saveSms() {
        val array = JSONArray()
        smsLines.forEach { array.put(it) }
        appContext
            ?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            ?.edit()
            ?.putString(KEY_SMS_LINES, array.toString())
            ?.apply()
    }
}
