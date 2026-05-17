package com.ziskconnect.smsbridge

import android.util.Base64
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object BridgeCrypto {
    private const val ALG = "AES-256-GCM"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val TAG_BITS = 128
    private const val IV_BYTES = 12
    private val random = SecureRandom()

    fun encryptJson(token: String, json: JSONObject): JSONObject {
        val iv = ByteArray(IV_BYTES)
        random.nextBytes(iv)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key(token), GCMParameterSpec(TAG_BITS, iv))
        val encryptedWithTag = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        val tagBytes = TAG_BITS / 8
        val cipherBytes = encryptedWithTag.copyOfRange(0, encryptedWithTag.size - tagBytes)
        val tag = encryptedWithTag.copyOfRange(encryptedWithTag.size - tagBytes, encryptedWithTag.size)
        return JSONObject()
            .put("encrypted", true)
            .put("alg", ALG)
            .put("iv", b64(iv))
            .put("tag", b64(tag))
            .put("data", b64(cipherBytes))
    }

    fun decryptJson(token: String, envelope: JSONObject): JSONObject {
        if (!envelope.optBoolean("encrypted")) return envelope
        val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
        val cipherBytes = Base64.decode(envelope.getString("data"), Base64.NO_WRAP)
        val tag = Base64.decode(envelope.getString("tag"), Base64.NO_WRAP)
        val encryptedWithTag = cipherBytes + tag
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(token), GCMParameterSpec(TAG_BITS, iv))
        return JSONObject(String(cipher.doFinal(encryptedWithTag), Charsets.UTF_8))
    }

    private fun key(token: String): SecretKeySpec {
        val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        return SecretKeySpec(digest, "AES")
    }

    private fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.NO_WRAP)
}
