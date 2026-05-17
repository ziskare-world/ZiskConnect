package com.ziskconnect.smsbridge

data class SimOption(
    val label: String,
    val subscriptionId: Int
) {
    override fun toString(): String = label
}
