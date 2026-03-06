// src/utils/MqttNativeClient.js
import { NativeModules, Platform } from 'react-native';
import NativeEventEmitter from 'react-native/Libraries/EventEmitter/NativeEventEmitter';

const { MqttNative } = NativeModules;
const emitter = MqttNative ? new NativeEventEmitter(MqttNative) : null;

const instanceMap = new Map();

// ✅ iOS UTF-8 safe payload decoder
function decodePayload(raw) {
  // Already a valid string
  if (typeof raw === 'string' && raw.length > 0) return raw;

  // iOS native bridge sometimes returns payload as a plain JS object like {0:72, 1:101, ...}
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    try {
      const bytes = new Uint8Array(Object.values(raw));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      if (decoded.length > 0) return decoded;
    } catch (_) {}
  }

  // iOS native bridge sometimes returns payload as a number array
  if (Array.isArray(raw)) {
    try {
      const bytes = new Uint8Array(raw);
      const decoded = new TextDecoder('utf-8').decode(bytes);
      if (decoded.length > 0) return decoded;
    } catch (_) {}
  }

  // Fallback: convert to string
  if (raw != null) return String(raw);

  return null;
}

if (emitter) {
  emitter.addListener('mqtt_status', (e) => {
    const clientId = e?.clientId;
    const msg = e?.status || e?.state || JSON.stringify(e);
    console.log(`[mqtt_status][${clientId}]`, msg);

    const inst = (clientId ? instanceMap.get(clientId) : null) ?? getActiveInstance();
    if (inst) {
      inst._statusCallbacks.forEach(cb => cb(String(msg)));
    } else {
      // ✅ fallback: 广播给所有
      instanceMap.forEach(i => i._statusCallbacks.forEach(cb => cb(String(msg))));
    }
  });

  emitter.addListener('mqtt_disconnected', (e) => {
    const clientId = e?.clientId;
    console.log(`[mqtt_disconnected][${clientId}]`, e);

    const inst = (clientId ? instanceMap.get(clientId) : null) ?? getActiveInstance();
    if (inst) {
      inst._statusCallbacks.forEach(cb => cb('DISCONNECTED'));
      if (e?.error) inst._errorCallbacks.forEach(cb => cb(String(e.error)));
    } else {
      instanceMap.forEach(i => {
        i._statusCallbacks.forEach(cb => cb('DISCONNECTED'));
        if (e?.error) i._errorCallbacks.forEach(cb => cb(String(e.error)));
      });
    }
  });

  emitter.addListener('mqtt_message', (e) => {
    const clientId = e?.clientId;
    const text = decodePayload(e?.payload);

    console.log('[EMITTER MSG] clientId=', clientId, 'instFound=', instanceMap.has(clientId), 'mapSize=', instanceMap.size, 'topic=', e?.topic?.slice(-30));

    const inst = clientId ? instanceMap.get(clientId) : null;
    if (inst) {
      // ✅ 精确匹配
      inst._messageCallbacks.forEach(cb => cb({ topic: e?.topic, text }));
    } else {
      // ✅ 广播给所有 active instances（iOS 不传 clientId 时的 fallback）
      instanceMap.forEach(i => {
        i._messageCallbacks.forEach(cb => cb({ topic: e?.topic, text }));
      });
    }
  });
}

function getActiveInstance() {
  let last = null;
  instanceMap.forEach(inst => { last = inst; });
  return last;
}

function mapMqttError(err) {
  const raw = err?.message || String(err || '');
  const up = raw.toUpperCase();
  if (up.includes('REASONCODE=5') || up.includes('NOT AUTHORIZED'))
    return { userMsg: 'Connection failed: username/password required', raw };
  if (up.includes('UNRECOGNIZED PACKET'))
    return { userMsg: 'Protocol mismatch: port may require TLS or WebSocket.', raw };
  if (up.includes('SSL') || up.includes('HANDSHAKE'))
    return { userMsg: 'TLS handshake failed: cert/CA/host mismatch.', raw };
  return { userMsg: 'Connection failed', raw };
}

export class MqttClient {
  constructor() {
    this.clientId = `rn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.host = null;
    this.port = null;
    this.connected = false;
    this._statusCallbacks = new Set();
    this._messageCallbacks = new Set();
    this._errorCallbacks = new Set();
    instanceMap.set(this.clientId, this);
  }

  connect({
    host, port, username = '', password = '',
    topic = '', useTls,
    onStatus, onMessage, onError,
  }) {
    if (!MqttNative) throw new Error('MqttNative is not available.');
    if (onStatus) this._statusCallbacks.add(onStatus);
    if (onMessage) this._messageCallbacks.add(onMessage);
    if (onError) this._errorCallbacks.add(onError);

    this.host = host;
    this.port = port;

    const p = Number(port);
    if (!Number.isFinite(p) || p <= 0) throw new Error(`Invalid port: ${port}`);

    const useTlsBool = useTls === true || useTls === 1 || useTls === '1';
    const effectiveUseTls = p === 1883 ? false : useTlsBool;

    console.log(`[MQTT][${this.clientId}] connecting to ${host}:${p} tls=${effectiveUseTls}`);

    return MqttNative.connect(
      String(host || '').trim(),
      p,
      this.clientId,
      String(username || ''),
      String(password || ''),
      effectiveUseTls
    )
      .then(() => {
        this.connected = true;
        if (!topic) return true;
        if (Platform.OS === 'android') {
          return MqttNative.subscribe(String(topic), 0).then(() => true);
        }
        return MqttNative.subscribe(String(topic), 0, this.clientId).then(() => true);
      })
      .catch((err) => {
        this.connected = false;
        const { userMsg, raw } = mapMqttError(err);
        this._errorCallbacks.forEach(cb => cb(`${userMsg}\n${raw}`));
        this._statusCallbacks.forEach(cb => cb('DISCONNECTED'));
        const e = new Error(userMsg);
        e.raw = raw;
        throw e;
      });
  }

  subscribe(topic, qos = 0) {
    if (!MqttNative) return Promise.reject(new Error('MqttNative unavailable'));
    if (Platform.OS === 'android') {
      return MqttNative.subscribe(String(topic), qos);
    }
    return MqttNative.subscribe(String(topic), qos, this.clientId);
  }

  publish({ topic, payload, qos = 0, retained = false }) {
    if (!MqttNative) return Promise.reject(new Error('MqttNative unavailable'));
    if (Platform.OS === 'android') {
      return MqttNative.publish(String(topic || ''), String(payload || ''), Number(qos) || 0, !!retained);
    }
    return MqttNative.publish(String(topic || ''), String(payload || ''), Number(qos) || 0, !!retained, this.clientId);
  }

  disconnect() {
    this.connected = false;
    instanceMap.delete(this.clientId);
    this._statusCallbacks.clear();
    this._messageCallbacks.clear();
    this._errorCallbacks.clear();
    if (!MqttNative) return Promise.resolve(true);
    if (Platform.OS === 'android') {
      return MqttNative.disconnect();
    }
    return MqttNative.disconnect(this.clientId);
  }

  removeCallbacks({ onStatus, onMessage, onError } = {}) {
    if (onStatus) this._statusCallbacks.delete(onStatus);
    if (onMessage) this._messageCallbacks.delete(onMessage);
    if (onError) this._errorCallbacks.delete(onError);
  }

  addCallbacks({ onStatus, onMessage, onError } = {}) {
    if (onStatus) this._statusCallbacks.add(onStatus);
    if (onMessage) this._messageCallbacks.add(onMessage);
    if (onError) this._errorCallbacks.add(onError);
  }
}

let _defaultClient = null;

export function connectAndSubscribe(params) {
  _defaultClient?.disconnect();
  _defaultClient = new MqttClient();
  return _defaultClient.connect(params);
}

export function disconnectMqtt() {
  if (_defaultClient) {
    const p = _defaultClient.disconnect();
    _defaultClient = null;
    return p;
  }
  return Promise.resolve(true);
}

export function publishMqtt(params) {
  if (!_defaultClient) return Promise.reject(new Error('No active MQTT connection'));
  return _defaultClient.publish(params);
}
// src/utils/MqttNativeClient.js
// Thin JS wrapper for the native MQTT module (MqttNative).

// import { NativeModules, NativeEventEmitter } from 'react-native';

// const { MqttNative } = NativeModules;
// const emitter = MqttNative ? new NativeEventEmitter(MqttNative) : null;

// let subMsg = null;
// let subStatus = null;
// let subDisc = null;

// // Map raw native/Paho errors into a user-friendly message
// function mapMqttError(err) {
//   const raw = err?.message || String(err || '');
//   const up = raw.toUpperCase();

//   if (up.includes('REASONCODE=5') || up.includes('NOT AUTHORIZED')) {
//     return { userMsg: 'Connection failed: username/password required', raw };
//   }

//   // ✅ 关键：协议不匹配（最常见：TLS端口用TCP连，或WebSocket端口被当TCP）
//   if (up.includes('UNRECOGNIZED PACKET')) {
//     return { userMsg: 'Protocol mismatch: this port may require TLS or WebSocket (not plain TCP).', raw };
//   }

//   if (up.includes('SSL') || up.includes('HANDSHAKE')) {
//     return { userMsg: 'TLS handshake failed: certificate/CA/host/SNI mismatch.', raw };
//   }

//   return { userMsg: 'connection failed', raw };
// }


// function ensureNative() {
//   if (!MqttNative) throw new Error('MqttNative is not available (undefined).');
//   if (!emitter) throw new Error('NativeEventEmitter not available for MqttNative.');
// }

// export function connectAndSubscribe({
//   host,
//   port,
//   username = '',
//   password = '',
//   topic = '',
//   useTls,
//   onStatus,
//   onMessage,
//   onError,
// }) {
//   ensureNative();

//   // Cleanup old listeners
//   subMsg?.remove?.();
//   subStatus?.remove?.();
//   subDisc?.remove?.();

//   subStatus = emitter.addListener('mqtt_status', (e) => {
//     // Map native payload into clear status text
//     const msg =
//       e?.status ||
//       e?.state ||
//       e?.message ||
//       (e?.topic ? `SUBSCRIBED ${e.topic}` : null) ||
//       (e?.uri ? `CONNECTED ${e.uri}` : null) ||
//       JSON.stringify(e);

//     onStatus?.(String(msg));
//   });

//   subDisc = emitter.addListener('mqtt_disconnected', (e) => {
//     onStatus?.('DISCONNECTED');
//     if (e?.error) onError?.(String(e.error));
//   });

//   subMsg = emitter.addListener('mqtt_message', (e) => {
//     onMessage?.({ topic: e?.topic, text: e?.payload });
//   });

// const clientId = `rn_${Date.now()}`;

// const p = Number(port);
// if (!Number.isFinite(p) || p <= 0) throw new Error(`Invalid port: ${port}`);

// // MqttManager must decide TLS (auto-detect / auto-flip), NativeClient should not infer.
// if (typeof useTls !== 'boolean') {
//   throw new Error('useTls must be boolean (provided by MqttManager).');
// }

// // Guard: never use TLS on 1883 (most brokers use plain TCP on 1883)
// const effectiveUseTls = (p === 1883) ? false : useTls;

// console.log('[MQTT] connect params', { host, port: p, username, useTls, effectiveUseTls });
// console.log('[MQTT] caller stack:\n', new Error().stack);
//   return MqttNative.connect(
//     String(host || '').trim(),
//     Number(port),
//     clientId,
//     String(username || ''),
//     String(password || ''),
//      effectiveUseTls
//   )
//     .then(() => {
//       // Optional subscribe
//       if (!topic) return true;
//       return MqttNative.subscribe(String(topic), 0).then(() => true);
//     })
// .catch((err) => {
//   console.log('[mqttNativeClient] connect error RAW:', err);

//   const { userMsg, raw } = mapMqttError(err);

//   onError?.(`${userMsg}\n${raw}`);  // ✅ UI 也能看到真实原因（可选）
//   onStatus?.('DISCONNECTED');

//   // ✅ 抛出包含 raw 的错误，让上层（MqttManager）能判断要不要切TLS
//   const e = new Error(userMsg);
//   e.raw = raw;
//   throw e;
// });



// }

// export function disconnectMqtt() {
//   subMsg?.remove?.();
//   subStatus?.remove?.();
//   subDisc?.remove?.();
//   subMsg = subStatus = subDisc = null;

//   if (!MqttNative) return Promise.resolve(true);
//   return MqttNative.disconnect();
// }

// export function publishMqtt({ topic, payload, qos = 0, retained = false }) {
//   ensureNative();
//   return MqttNative.publish(
//     String(topic || ''),
//     String(payload || ''),
//     Number(qos) || 0,
//     !!retained
//   );
// }