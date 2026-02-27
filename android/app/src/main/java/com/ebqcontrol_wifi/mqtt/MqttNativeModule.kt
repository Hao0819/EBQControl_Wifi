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
          m.putString("status", "CONNECTED ${serverURI ?: uri}")
          emit("mqtt_status", m)
        }

        override fun connectionLost(cause: Throwable?) {
          val m = Arguments.createMap()
          m.putString("error", cause?.message ?: "connectionLost")
          emit("mqtt_disconnected", m)
        }

        override fun messageArrived(topic: String?, message: MqttMessage?) {
          val m = Arguments.createMap()
          m.putString("topic", topic ?: "")
          m.putString("payload", message?.toString() ?: "")
          emit("mqtt_message", m)
        }

        override fun deliveryComplete(token: IMqttDeliveryToken?) {}
      })

      val opts = MqttConnectOptions().apply {
        isCleanSession = true
        isAutomaticReconnect = true
        connectionTimeout = 10
        keepAliveInterval = 20

        if (username.isNotBlank()) userName = username
        if (password.isNotEmpty()) this.password = password.toCharArray()
      }

      // ✅ TrustAll in BOTH Debug + Release when TLS is used (INSECURE)
      if (useTls) {
        disableHostnameVerification(opts)
        opts.socketFactory = trustAllSocketFactory()
      }

      val s = Arguments.createMap()
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
    c.publish(
      topic,
      payload.toByteArray(Charsets.UTF_8),
      q,
      retained
    )
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
          m.putString("status", "DISCONNECTED")
          emit("mqtt_status", m)
          promise.resolve(true)
        }

        override fun onFailure(asyncActionToken: IMqttToken?, exception: Throwable?) {
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
