package com.ebqcontrol_wifi.mqtt

import android.util.Log
import com.facebook.react.bridge.*
import com.facebook.react.modules.core.DeviceEventManagerModule
import info.mqtt.android.service.MqttAndroidClient
import org.eclipse.paho.client.mqttv3.*
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class MqttNativeModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "MqttNative"

  private var client: MqttAndroidClient? = null

  // Track active client meta so every event can include it
  private var currentClientId: String = ""
  private var currentUri: String = ""

  private fun emit(event: String, map: WritableMap) {
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, map)
  }

  /** Make MQTT errors readable: reasonCode + cause chain */
  private fun rejectMqtt(promise: Promise, code: String, action: String, t: Throwable?) {
    val sb = StringBuilder()
    sb.append(action)

    if (t is MqttException) {
      sb.append(" (reasonCode=").append(t.reasonCode).append(")")
    }

    sb.append(": ").append(t?.message ?: "unknown error")

    var c = t?.cause
    var depth = 0
    while (c != null && depth < 6) {
      sb.append(" | cause=")
        .append(c.javaClass.simpleName)
        .append(": ")
        .append(c.message ?: "")
      c = c.cause
      depth++
    }

    Log.e("MqttNative", sb.toString(), t)
    promise.reject(code, sb.toString(), t)
  }

  /** Trust all certs (INSECURE) */
  private fun trustAllSocketFactory(): SSLSocketFactory {
    val trustAll = arrayOf<TrustManager>(
      object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }
    )

    val sc = SSLContext.getInstance("TLS")
    sc.init(null, trustAll, SecureRandom())
    return sc.socketFactory
  }

  /** Disable hostname verification (ignore SAN/CN mismatch). Uses reflection for compatibility. */
  private fun disableHostnameVerification(opts: MqttConnectOptions) {
    try {
      val m = MqttConnectOptions::class.java.getMethod(
        "setHttpsHostnameVerificationEnabled",
        Boolean::class.javaPrimitiveType
      )
      m.invoke(opts, false)
    } catch (_: Throwable) {
      // ignore if method doesn't exist
    }
  }

  @ReactMethod
  fun connect(
    host: String,
    port: Int,
    clientId: String,
    username: String,
    password: String,
    useTls: Boolean,
    promise: Promise
  ) {
    try {
      val scheme = if (useTls) "ssl" else "tcp"
      val uri = "$scheme://${host.trim()}:$port"
      Log.d("MqttNative", "connect host=$host port=$port useTls=$useTls uri=$uri")

      // Save meta for event routing / logging
      currentClientId = clientId
      currentUri = uri

      // Close old client if any
      client?.let {
        try { it.unregisterResources() } catch (_: Throwable) {}
        try { it.close() } catch (_: Throwable) {}
      }

      val c = MqttAndroidClient(reactContext, uri, clientId)
      client = c

      c.setCallback(object : MqttCallbackExtended {
        override fun connectComplete(reconnect: Boolean, serverURI: String?) {
          val m = Arguments.createMap()
          m.putString("clientId", currentClientId)
          m.putString("status", "CONNECTED ${serverURI ?: currentUri}")
          emit("mqtt_status", m)
        }

        override fun connectionLost(cause: Throwable?) {
          val sb = StringBuilder()
          sb.append("connectionLost")

          if (cause is MqttException) {
            sb.append(" (reasonCode=").append(cause.reasonCode).append(")")
          }

          sb.append(": ").append(cause?.message ?: "null")

          var c2 = cause?.cause
          var depth = 0
          while (c2 != null && depth < 6) {
            sb.append(" | cause=")
              .append(c2.javaClass.simpleName)
              .append(": ")
              .append(c2.message ?: "")
            c2 = c2.cause
            depth++
          }

          Log.e("MqttNative", "[DISCONNECTED] clientId=$currentClientId uri=$currentUri $sb", cause)

          // mqtt_disconnected (JS can show toast etc.)
          val m = Arguments.createMap()
          m.putString("clientId", currentClientId)
          m.putString("uri", currentUri)
          m.putString("error", sb.toString())
          emit("mqtt_disconnected", m)

          // mqtt_status DISCONNECTED (keep JS state machine consistent)
          val s = Arguments.createMap()
          s.putString("clientId", currentClientId)
          s.putString("status", "DISCONNECTED $currentUri")
          emit("mqtt_status", s)
        }

        override fun messageArrived(topic: String?, message: MqttMessage?) {
          val m = Arguments.createMap()
          m.putString("clientId", currentClientId)
          m.putString("topic", topic ?: "")
          m.putString("payload", message?.toString() ?: "")
          emit("mqtt_message", m)
        }

        override fun deliveryComplete(token: IMqttDeliveryToken?) {}
      })

      val opts = MqttConnectOptions().apply {
        isCleanSession = true

        // Debug first: disable auto reconnect to see the first error clearly
        isAutomaticReconnect = false

        connectionTimeout = 10
        keepAliveInterval = 20

        // Optional: force MQTT 3.1.1 for compatibility
        mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1

        if (username.isNotBlank()) userName = username
        if (password.isNotEmpty()) this.password = password.toCharArray()
      }

      // INSECURE trust-all (for debugging / self-signed)
      if (useTls) {
        disableHostnameVerification(opts)
        opts.socketFactory = trustAllSocketFactory()
      }

      // Emit CONNECTING (with clientId)
      val s = Arguments.createMap()
      s.putString("clientId", currentClientId)
      s.putString("status", "CONNECTING $uri")
      emit("mqtt_status", s)

      c.connect(opts, null, object : IMqttActionListener {
        override fun onSuccess(asyncActionToken: IMqttToken?) {
          promise.resolve(true)
        }

        override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
          rejectMqtt(promise, "MQTT_CONNECT_FAIL", "connect failed uri=$uri", exception)
        }
      })

    } catch (t: Throwable) {
      rejectMqtt(promise, "MQTT_CONNECT_EXCEPTION", "connect exception", t)
    }
  }

  @ReactMethod
  fun subscribe(topic: String, qos: Int, promise: Promise) {
    val c = client
    if (c == null || !c.isConnected) {
      promise.reject("MQTT_NOT_CONNECTED", "Client not connected")
      return
    }

    c.subscribe(topic, qos, null, object : IMqttActionListener {
      override fun onSuccess(asyncActionToken: IMqttToken?) {
        val m = Arguments.createMap()
        m.putString("clientId", currentClientId)
        m.putString("status", "SUBSCRIBED $topic")
        emit("mqtt_status", m)
        promise.resolve(true)
      }

      override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
        rejectMqtt(promise, "MQTT_SUB_FAIL", "subscribe failed topic=$topic qos=$qos", exception)
      }
    })
  }

  @ReactMethod
  fun publish(topic: String, payload: String, qos: Int, retained: Boolean, promise: Promise) {
    val c = client
    if (c == null || !c.isConnected) {
      promise.reject("MQTT_NOT_CONNECTED", "Client not connected")
      return
    }

    try {
      val q = qos.coerceIn(0, 2)
      c.publish(topic, payload.toByteArray(Charsets.UTF_8), q, retained)
      promise.resolve(true)
    } catch (t: Throwable) {
      rejectMqtt(promise, "MQTT_PUB_FAIL", "publish failed topic=$topic", t)
    }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    val c = client
    if (c == null) {
      promise.resolve(true)
      return
    }

    try {
      c.disconnect(null, object : IMqttActionListener {
        override fun onSuccess(asyncActionToken: IMqttToken?) {
          val m = Arguments.createMap()
          m.putString("clientId", currentClientId)
          m.putString("status", "DISCONNECTED")
          emit("mqtt_status", m)
          promise.resolve(true)
        }

        override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
          // still resolve to avoid blocking UI
          promise.resolve(true)
        }
      })
    } catch (_: Throwable) {
      promise.resolve(true)
    }
  }

  // Required for NativeEventEmitter
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}