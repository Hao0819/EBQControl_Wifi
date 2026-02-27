// src/utils/MqttManager.js
// Single active MQTT connection manager with simple state subscription.

import { connectAndSubscribe, disconnectMqtt } from './MqttNativeClient';

const listeners = new Set();

let state = {
  deviceId: null,
  connected: false,
  connecting: false,
  status: 'IDLE',
  error: '',
};

let currentDevice = null;
let retryCount = 0;
let reconnectTimer = null;

function notify() {
  const snap = { ...state };
  for (const fn of listeners) fn(snap);
}

function setState(patch) {
  state = { ...state, ...patch };
  notify();
}

export function subscribeMqttState(fn) {
  listeners.add(fn);
  fn({ ...state });
  return () => listeners.delete(fn);
}

export function getMqttState() {
  return { ...state };
}

function clearTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (!currentDevice) return;
  clearTimer();
  const delay = Math.min(30000, 1000 * Math.pow(2, retryCount)); // 1s,2s,4s... max 30s
  reconnectTimer = setTimeout(() => {
    retryCount += 1;
    connectDevice(currentDevice, { silent: true }).catch(() => {});
  }, delay);
}

// ✅ Auto detect TLS by port
function detectTlsByPort(port) {
  const p = Number(port);
  return p === 8883  || p === 8812;   // ✅ TLS ports
}
// ---- Topic builders based on your MQTT Explorer ----
const DEFAULT_CPID = '51c5c752';

function buildEventBaseTopic(cpId, deviceId) {
  const cpid = String(cpId || DEFAULT_CPID).trim();
  const id = String(deviceId || '').trim();
  if (!cpid || !id) return '';
  return `devices/${cpid}/${id}/messages/events`;
}

function buildSubscribeTopic(cpId, deviceId) {
  const base = buildEventBaseTopic(cpId, deviceId);
  return base ? `${base}/#` : '';
}

// Promise timeout helper
function withTimeout(promise, ms, label = 'Timeout') {
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/**
 * Authenticate for Add Device:
 * - CONNECT broker (host/port/username/password)
 * - SUBSCRIBE device topic (permission check)
 * - If success => auth passed
 * NOTE: Native is single-connection. This will disconnect current session.
 */
export async function authenticateForAddDevice({
  host,
  port,
  username,
  password,
  cpId,
  deviceId,
  useTls: useTlsInput,
  timeoutMs = 8000,
}) {
  const p = Number(port) || 1883;

  const subTopic = buildSubscribeTopic(cpId, deviceId);
  if (!host) throw new Error('Host is required');
  if (!subTopic) throw new Error('cpId/deviceId is required');

  // 1) First attempt TLS/TCP decision:
  // - If caller provided useTlsInput, respect it.
  // - Otherwise infer from port (8883/8812 => TLS, else TCP).
  let useTls =
    typeof useTlsInput === 'boolean'
      ? useTlsInput
      : detectTlsByPort(p);

  // Try once: disconnect -> connect -> subscribe (with timeout)
  const tryOnce = async (tlsFlag) => {
    await disconnectMqtt().catch(() => {});
    await withTimeout(
      connectAndSubscribe({
        host: host.trim(),
        port: p,
        username: String(username || '').trim(),
        password: String(password || ''),
        topic: subTopic,
        useTls: tlsFlag,
        onStatus: () => {},
        onMessage: () => {},
        onError: () => {},
      }),
      timeoutMs,
      'Auth timeout: check network/host/port/username/password/ACL'
    );
  };

  // Errors that usually mean "protocol mismatch" (TLS vs TCP wrong)
  const shouldFlipTls = (err) => {
    const raw = String(err?.raw || err?.message || '').toUpperCase();
    return (
      raw.includes('UNRECOGNIZED PACKET') ||  // TLS port used as TCP
      raw.includes('SSLHANDSHAKE') ||         // TCP port used as TLS
      raw.includes('HANDSHAKE') ||
      raw.includes('EOFEXCEPTION') ||
      raw.includes('CONNECTION CLOSED')
    );
  };

  try {
    // 2) First attempt
    await tryOnce(useTls);
  } catch (e1) {
    // For port 1883, do NOT auto-flip by default (avoid false positives)
    if (p === 1883) throw e1;

    // 3) Second attempt: flip TLS once if likely mismatch
    if (shouldFlipTls(e1)) {
      const flipped = !useTls;
      await tryOnce(flipped);
      useTls = flipped; // ✅ remember actual TLS mode
    } else {
      throw e1;
    }
  } finally {
    // Auth-test only: disconnect after success/failure
    await disconnectMqtt().catch(() => {});
  }

  // ✅ Return detected TLS so AddMqttDevice can store it
  return {
    topicSub: subTopic,
    topicBase: buildEventBaseTopic(cpId, deviceId),
    useTls,
  };
}


export async function connectDevice(device, { silent = false } = {}) {
  if (!device) return false;

  currentDevice = device;
  retryCount = 0;
  clearTimer();

  const deviceId = String(device.deviceId ?? device.id ?? device.friendlyName ?? '');
  const port = Number(device.port) || 1883;

 // ✅ 优先使用设备保存的 useTls（如果有），否则按端口推断
const useTls =
  typeof device.useTls === 'boolean'
    ? device.useTls
    : detectTlsByPort(port);
  const scheme = useTls ? 'ssl' : 'tcp';

  setState({
    deviceId,
    connecting: true,
    connected: false,
    error: '',
    status: `CONNECTING ${scheme}://${device.host}:${port}`,
  });

  // Disconnect previous session before connecting a new one
  await disconnectMqtt().catch(() => {});

  try {
    await connectAndSubscribe({
      host: device.host,
      port,
      username: device.username || '',
      password: device.password || '',
      topic: device.topic || '',
      useTls,

      onStatus: (s) => {
        const text = String(s || '');
        const up = text.toUpperCase();

        const ok = up.startsWith('CONNECTED') || up.startsWith('SUBSCRIBED');
        const disc = up.startsWith('DISCONNECTED');

        setState({
          status: text,
          connected: ok,
          connecting: !ok && !disc,
        });

        if (disc) scheduleReconnect();
      },

      onError: (e) => {
        setState({ error: String(e || 'ERROR') });
        scheduleReconnect();
      },

      onMessage: (_msg) => {
        // Handle telemetry later if needed
      },
    });

    setState({
      connected: true,
      connecting: false,
      status: `CONNECTED ${scheme}://${device.host}:${port}`,
    });
    return true;
  } catch (err) {
    const msg = err?.message || String(err);
    if (!silent) setState({ error: msg });

    setState({ connected: false, connecting: false, status: 'DISCONNECTED' });
    scheduleReconnect();
    throw err;
  }
}

// Disconnect and reset manager state
export async function disconnectDevice() {
  try {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;

    currentDevice = null;
    retryCount = 0;

    await disconnectMqtt().catch(() => {});
  } finally {
    setState({
      deviceId: null,
      connected: false,
      connecting: false,
      status: 'IDLE',
      error: '',
    });
  }
  return true;
}
// src/utils/MqttManager.js
// Single active MQTT connection manager with simple state subscription.

// import { connectAndSubscribe, disconnectMqtt } from './MqttNativeClient';

// const listeners = new Set();

// let state = {
//   deviceId: null,
//   connected: false,
//   connecting: false,
//   status: 'IDLE',
//   error: '',
// };

// let currentDevice = null;
// let retryCount = 0;
// let reconnectTimer = null;

// function notify() {
//   const snap = { ...state };
//   for (const fn of listeners) fn(snap);
// }

// function setState(patch) {
//   state = { ...state, ...patch };
//   notify();
// }

// export function subscribeMqttState(fn) {
//   listeners.add(fn);
//   fn({ ...state });
//   return () => listeners.delete(fn);
// }

// export function getMqttState() {
//   return { ...state };
// }

// function clearTimer() {
//   if (reconnectTimer) clearTimeout(reconnectTimer);
//   reconnectTimer = null;
// }

// function scheduleReconnect() {
//   if (!currentDevice) return;
//   clearTimer();
//   const delay = Math.min(30000, 1000 * Math.pow(2, retryCount)); // 1s,2s,4s... max 30s
//   reconnectTimer = setTimeout(() => {
//     retryCount += 1;
//     connectDevice(currentDevice, { silent: true }).catch(() => {});
//   }, delay);
// }

// // ✅ Auto detect TLS by port
// function detectTlsByPort(port) {
//   const p = Number(port);
//   return p === 8883 || p === 8812;   // ✅ TLS ports
// }
// // ---- Topic builders based on your MQTT Explorer ----
// const DEFAULT_CPID = '51c5c752';

// function buildEventBaseTopic(cpId, deviceId) {
//   const cpid = String(cpId || DEFAULT_CPID).trim();
//   const id = String(deviceId || '').trim();
//   if (!cpid || !id) return '';
//   return `devices/${cpid}/${id}/messages/events`;
// }

// function buildSubscribeTopic(cpId, deviceId) {
//   const base = buildEventBaseTopic(cpId, deviceId);
//   return base ? `${base}/#` : '';
// }

// // Promise timeout helper
// function withTimeout(promise, ms, label = 'Timeout') {
//   let t = null;
//   const timeout = new Promise((_, reject) => {
//     t = setTimeout(() => reject(new Error(label)), ms);
//   });
//   return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
// }

// /**
//  * Authenticate for Add Device:
//  * - CONNECT broker (host/port/username/password)
//  * - SUBSCRIBE device topic (permission check)
//  * - If success => auth passed
//  * NOTE: Native is single-connection. This will disconnect current session.
//  */
// export async function authenticateForAddDevice({
//   host,
//   port,
//   username,
//   password,
//   cpId,
//   deviceId,
//   useTls: useTlsInput,
//   timeoutMs = 8000,
// }) {
//   const p = Number(port) || 1883;

//   const subTopic = buildSubscribeTopic(cpId, deviceId);
//   if (!host) throw new Error('Host is required');
//   if (!subTopic) throw new Error('cpId/deviceId is required');

//   // 1) First attempt TLS/TCP decision:
//   // - If caller provided useTlsInput, respect it.
//   // - Otherwise infer from port (8883/8812 => TLS, else TCP).
//   let useTls =
//     typeof useTlsInput === 'boolean'
//       ? useTlsInput
//       : detectTlsByPort(p);

//   // Try once: disconnect -> connect -> subscribe (with timeout)
//   const tryOnce = async (tlsFlag) => {
//     await disconnectMqtt().catch(() => {});
//     await withTimeout(
//       connectAndSubscribe({
//         host: host.trim(),
//         port: p,
//         username: String(username || '').trim(),
//         password: String(password || ''),
//         topic: subTopic,
//         useTls: tlsFlag,
//         onStatus: () => {},
//         onMessage: () => {},
//         onError: () => {},
//       }),
//       timeoutMs,
//       'Auth timeout: check network/host/port/username/password/ACL'
//     );
//   };

//   // Errors that usually mean "protocol mismatch" (TLS vs TCP wrong)
//   const shouldFlipTls = (err) => {
//     const raw = String(err?.raw || err?.message || '').toUpperCase();
//     return (
//       raw.includes('UNRECOGNIZED PACKET') ||  // TLS port used as TCP
//       raw.includes('SSLHANDSHAKE') ||         // TCP port used as TLS
//       raw.includes('HANDSHAKE') ||
//       raw.includes('EOFEXCEPTION') ||
//       raw.includes('CONNECTION CLOSED')
//     );
//   };

//   try {
//     // 2) First attempt
//     await tryOnce(useTls);
//   } catch (e1) {
//     // For port 1883, do NOT auto-flip by default (avoid false positives)
//     if (p === 1883) throw e1;

//     // 3) Second attempt: flip TLS once if likely mismatch
//     if (shouldFlipTls(e1)) {
//       const flipped = !useTls;
//       await tryOnce(flipped);
//       useTls = flipped; // ✅ remember actual TLS mode
//     } else {
//       throw e1;
//     }
//   } finally {
//     // Auth-test only: disconnect after success/failure
//     await disconnectMqtt().catch(() => {});
//   }

//   // ✅ Return detected TLS so AddMqttDevice can store it
//   return {
//     topicSub: subTopic,
//     topicBase: buildEventBaseTopic(cpId, deviceId),
//     useTls,
//   };
// }


// export async function connectDevice(device, { silent = false } = {}) {
//   if (!device) return false;

//   currentDevice = device;
//   retryCount = 0;
//   clearTimer();

//   const deviceId = String(device.deviceId ?? device.id ?? device.friendlyName ?? '');
//   const port = Number(device.port) || 1883;

//  // ✅ 优先使用设备保存的 useTls（如果有），否则按端口推断
// const useTls =
//   typeof device.useTls === 'boolean'
//     ? device.useTls
//     : detectTlsByPort(port);
//   const scheme = useTls ? 'ssl' : 'tcp';

//   setState({
//     deviceId,
//     connecting: true,
//     connected: false,
//     error: '',
//     status: `CONNECTING ${scheme}://${device.host}:${port}`,
//   });

//   // Disconnect previous session before connecting a new one
//   await disconnectMqtt().catch(() => {});

//   try {
//     await connectAndSubscribe({
//       host: device.host,
//       port,
//       username: device.username || '',
//       password: device.password || '',
//       topic: device.topic || '',
//       useTls,

//       onStatus: (s) => {
//         const text = String(s || '');
//         const up = text.toUpperCase();

//         const ok = up.startsWith('CONNECTED') || up.startsWith('SUBSCRIBED');
//         const disc = up.startsWith('DISCONNECTED');

//         setState({
//           status: text,
//           connected: ok,
//           connecting: !ok && !disc,
//         });

//         if (disc) scheduleReconnect();
//       },

//       onError: (e) => {
//         setState({ error: String(e || 'ERROR') });
//         scheduleReconnect();
//       },

//       onMessage: (_msg) => {
//         // Handle telemetry later if needed
//       },
//     });

//     setState({
//       connected: true,
//       connecting: false,
//       status: `CONNECTED ${scheme}://${device.host}:${port}`,
//     });
//     return true;
//   } catch (err) {
//     const msg = err?.message || String(err);
//     if (!silent) setState({ error: msg });

//     setState({ connected: false, connecting: false, status: 'DISCONNECTED' });
//     scheduleReconnect();
//     throw err;
//   }
// }

// // Disconnect and reset manager state
// export async function disconnectDevice() {
//   try {
//     if (reconnectTimer) clearTimeout(reconnectTimer);
//     reconnectTimer = null;

//     currentDevice = null;
//     retryCount = 0;

//     await disconnectMqtt().catch(() => {});
//   } finally {
//     setState({
//       deviceId: null,
//       connected: false,
//       connecting: false,
//       status: 'IDLE',
//       error: '',
//     });
//   }
//   return true;
// }