// src/screens/MqttDeviceGridScreen.js
// Fixed version:
// - subscribe ONLY to devices/<cpid>/<deviceId>/messages/events/#
// - publish ONLY to devices/<cpid>/<deviceId>/messages/events (NO trailing slash)
// - request Name1 + Name2 + Rating once after CONNECTED/SUBSCRIBED
// - parse Name1/Name2/Name + Rating + current + echoes
// - keep your UI structure (Grid/List/3-Phase + DeviceConfigDialog)

import React, { memo, useCallback, useLayoutEffect, useMemo, useState, useRef, useEffect } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, Image, ToastAndroid, InteractionManager, useWindowDimensions, BackHandler, Platform, Alert, Pressable } from 'react-native';
import { UIManager, findNodeHandle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';
import DeviceConfigDialog from '../components/MqttDeviceConfigDialog';
import DeviceGridView from '../components/MqttDeviceGridView';
import DeviceListView from '../components/MqttDeviceListView';
import ThreePhaseView from '../components/MqttThreePhaseView';
import { connectAndSubscribe, disconnectMqtt, publishMqtt } from '../utils/MqttNativeClient';

// ===== Pure JS tabs (no material-top-tabs) =====
const TAB = { GRID: 'GRID', LIST: 'LIST', THREE: 'THREE' };

const CONN = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTING: 'disconnecting',
};

const toast = (msg) => ToastAndroid.show(String(msg ?? ''), ToastAndroid.SHORT);

function getStatusColor(status) {
  const s = String(status || '').toLowerCase();
  if (s === CONN.CONNECTED) return '#4ADE80';
  if (s === CONN.CONNECTING) return '#FBBF24';
  if (s === CONN.DISCONNECTING) return '#FBBF24';
  return '#EF4444';
}

// Derive cpid/deviceId from topic like: devices/<cpid>/<deviceId>/messages/events/...
function deriveFromEventsTopic(eventsTopic) {
  const t = String(eventsTopic || '').trim().replace(/\/#$/, '');
  const parts = t.split('/').filter(Boolean);

  const i = parts.indexOf('devices');
  if (i < 0 || parts.length < i + 3) return { cpid: '', deviceId: '' };

  const cpid = parts[i + 1];
  const deviceId = parts[i + 2];
  return { cpid, deviceId };
}
function extractNameMap(j) {
  // Extract name map from multiple schemas
  const map =
    j?.d?.Name ||
    j?.d?.Name1 ||
    j?.d?.Name2 ||
    j?.data?.Name ||
    j?.data?.Name1 ||
    j?.data?.Name2 ||
    j?.data?.command?.Name ||
    j?.data?.command?.Name1 ||
    j?.data?.command?.Name2;

  return map && typeof map === 'object' ? map : null;
}

// Parse current map from multiple schemas:
// { d: { current: { C17: 0.0 } } } OR { data: { current: ... } } OR { current: ... }
function parseCurrentMap(objOrText) {
  let j = objOrText;
  if (typeof objOrText === 'string') {
    try {
      j = JSON.parse(objOrText);
    } catch (_) {
      return null;
    }
  }

  const map =
    j?.d?.current ||
    j?.data?.current ||
    j?.current ||
    (j &&
      typeof j === 'object' &&
      Object.keys(j).some((k) => /^C\d+$/i.test(k))
      ? j
      : null);

  if (!map || typeof map !== 'object') return null;
  return map;
}

function normalizeNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const m = v.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }
  if (Array.isArray(v)) return Number(v[0]);
  return Number(v);
}

function formatCurrentA(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';

  // Convert small negative OFF marker (-0.1 ~ 0) to 0.00
  if (n < 0 && n >= -0.1) return '0.00';

  // Show positive values as-is (including small positives like 0.04)
  // Show larger negative values as-is (if they ever happen)
  return n.toFixed(2);
}
function sanitizeName(input) {
  const s = String(input ?? '').trim();

  // Remove replacement char (�) and control chars
  const cleaned = s
    .replace(/\uFFFD/g, '')              // �
    .replace(/[\u0000-\u001F\u007F]/g, '') // control chars
    .trim();

  // If result is empty or still looks broken, return empty to skip apply
  if (!cleaned) return '';
  return cleaned;
}

function default1P(id) {
  return {
    id,
    status: 'UNKNOWN',
    current: '-',
    rawStatus: 0x00,
    seen: false,

    tagName: `Device ${id}`,
    currentRating: 0.0,
    sensitivity: 1,
  };
}

function default3P(id) {
  return {
    id,
    status: 'UNKNOWN',
    current: '-',
    current1: '-',
    current2: '-',
    current3: '-',
    rawStatus: 0x00,
    seen: false,

    tagName: `Device ${id}`,
    currentRating: 0.0,
    sensitivity: 1,
  };
}

function parse3PhaseValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return [v, v, v];
  }

  if (Array.isArray(v) && v.length >= 3) {
    const a = normalizeNumber(v[0]);
    const b = normalizeNumber(v[1]);
    const c = normalizeNumber(v[2]);
    if ([a, b, c].every(Number.isFinite)) return [a, b, c];
    return null;
  }
  if (v && typeof v === 'object') {
    const a = normalizeNumber(v.current1 ?? v.a ?? v.A ?? v.L1 ?? v.l1);
    const b = normalizeNumber(v.current2 ?? v.b ?? v.B ?? v.L2 ?? v.l2);
    const c = normalizeNumber(v.current3 ?? v.c ?? v.C ?? v.L3 ?? v.l3);
    if ([a, b, c].every(Number.isFinite)) return [a, b, c];
  }
  return null;
}

const randomHex8 = () => Math.random().toString(16).slice(2, 10).padEnd(8, '0');

// Build supervisor (ON/OFF) schema payload (cmdType + data).
function buildCmdSupervisorExact({ cpid, targetId, action, channelId, ackId, useCPrefix }) {
  const ch = useCPrefix ? `C${String(channelId)}` : String(channelId);

  return {
    cmdType: '1',
    t: new Date().toISOString(),
    sdk: { e: 'DengKai', v: '1.0' },
    data: {
      cpid: String(cpid),
      id: String(targetId),
      command: [{ [String(action).toUpperCase()]: ch }],
      ack: false,
      ackId: String(ackId || randomHex8()),
    },
  };
}

// =========================
// Name cache helpers (fast navigation + instant name display)
// =========================

const nameCacheKey = (cpid, deviceId) =>
  `EBQ_NAME_CACHE::${String(cpid || '')}::${String(deviceId || '')}`;

// Merge cached names into current tags (lazy: create tag only when needed)
function mergeNamesIntoTags(prev, obj) {
  if (!obj || typeof obj !== 'object') return prev;

  let next = prev;
  let changed = false;

  for (const [k, v] of Object.entries(obj)) {
    // keys are like "C17" or "17"
    const mm = String(k).match(/C(\d+)/i);
    const id = mm ? parseInt(mm[1], 10) : parseInt(String(k), 10);
    if (!Number.isFinite(id)) continue;

    const gotName = sanitizeName(v);

    if (!gotName) continue; // do not apply empty name
    if (/^Device\s+\d+$/i.test(gotName)) continue; // optional: avoid overriding with default name

    const old = prev[id] || (id >= 201 ? default3P(id) : default1P(id));
    if (old.tagName === gotName) continue;

    if (!changed) {
      next = { ...prev };
      changed = true;
    }
    next[id] = { ...old, tagName: gotName, seen: true };
  }

  return changed ? next : prev;
}

async function loadNameCache({ cpid, deviceId, setTags }) {
  if (!cpid || !deviceId) return;

  const key = nameCacheKey(cpid, deviceId);
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return;

    const obj = JSON.parse(raw);
    setTags((prev) => mergeNamesIntoTags(prev, obj));
    console.log('[NAME CACHE] loaded', Object.keys(obj || {}).length, 'items');
  } catch (e) {
    console.log('[NAME CACHE] load failed', e?.message || String(e));
  }
}

async function saveNameCache({ cpid, deviceId, partialMap }) {
  if (!cpid || !deviceId || !partialMap) return;

  const key = nameCacheKey(cpid, deviceId);
  try {
    const raw = await AsyncStorage.getItem(key);
    const oldObj = raw ? JSON.parse(raw) : {};
    const nextObj = { ...(oldObj || {}), ...(partialMap || {}) };
    await AsyncStorage.setItem(key, JSON.stringify(nextObj));
  } catch (e) {
    console.log('[NAME CACHE] save failed', e?.message || String(e));
  }
}

export default memo(function MqttDeviceGridScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { width } = useWindowDimensions();

  // ✅ 量内容区域真实宽度（避免平板先用错误宽度渲染）
  const [contentW, setContentW] = useState(0);

  const onContentLayout = useCallback((e) => {
    const w = e?.nativeEvent?.layout?.width ?? 0;
    if (w > 0) {
      setContentW((prev) => (Math.abs(prev - w) > 1 ? w : prev));
    }
  }, []);

  // ===== Menu anchor (same behavior as BLE) =====
  const menuButtonRef = useRef(null);

  const [menuAnchor, setMenuAnchor] = useState({ x: 0, y: 0, w: 0, h: 0 });

  const toggleMenu = useCallback(() => {
    setShowMenu((prev) => {
      const next = !prev;

      if (next) {
        InteractionManager.runAfterInteractions(() => {
          const node = findNodeHandle(menuButtonRef.current);
          if (!node) return;

          UIManager.measureInWindow(node, (x, y, w, h) => {
            setMenuAnchor({ x, y, w, h });
          });
        });
      }

      return next;
    });
  }, []);

  const device = route.params?.device || route.params || {};
  const host = String(device.host || device.brokerHost || '').trim();
  const port = Number(device.port || 0);
  const username = String(device.username || '');
  const password = String(device.password || '');
  const topic = String(device.topic || device.subTopic || '').trim();

  const derived = useMemo(() => deriveFromEventsTopic(topic), [topic]);
  const topics = useMemo(() => {
    const cpid = derived.cpid;
    const id = derived.deviceId;
    if (!cpid || !id) return { tSlash: '', tNoSlash: '' };

    return {
      tSlash: `devices/${cpid}/${id}/messages/events/`,
      tNoSlash: `devices/${cpid}/${id}/messages/events`,

    };
  }, [derived.cpid, derived.deviceId]);

  const deviceName = String(device.friendlyName || device.name || 'MQTT Device');
  const hwId = String(device.hardwareId || device.hwId || device.mac || device.id || '');

  const [activeTab, setActiveTab] = useState(TAB.GRID);

  const [connectionStatus, setConnectionStatus] = useState(CONN.DISCONNECTED);
  const connectionStatusRef = useRef(CONN.DISCONNECTED);
  useEffect(() => {
    connectionStatusRef.current = connectionStatus;
  }, [connectionStatus]);

  const [statusText, setStatusText] = useState('DISCONNECTED');
  const [showMenu, setShowMenu] = useState(false);
  // ===== perf: throttle statusText (avoid re-render per message) =====
  const statusPendingRef = useRef('');
  const statusTimerRef = useRef(null);
  const fastTimerRef = useRef(null);
// 在组件里加一个 ref
const toggleLockRef = useRef(new Map()); // channelId → expireTimestamp

  const setStatusTextSoft = useCallback((s) => {
    statusPendingRef.current = String(s ?? '');
    if (statusTimerRef.current) return;

    statusTimerRef.current = setTimeout(() => {
      statusTimerRef.current = null;
      setStatusText(statusPendingRef.current);
    }, 250);
  }, []);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);
  // ✅ 管理所有 setTimeout，断开时一键清掉
  const timeoutsRef = useRef(new Set());

  const safeSetTimeout = useCallback((fn, ms) => {
    const id = setTimeout(() => {
      timeoutsRef.current.delete(id);
      fn();
    }, ms);
    timeoutsRef.current.add(id);
    return id;
  }, []);

  const clearAllTimeouts = useCallback(() => {
    for (const id of timeoutsRef.current) clearTimeout(id);
    timeoutsRef.current.clear();
  }, []);
  const [showConfig, setShowConfig] = useState(false);
  const [tags, setTags] = useState(() => ({}));
  const [selectedTagId, setSelectedTagId] = useState(null);
  const [uiReady, setUiReady] = useState(false);

  // ✅ IMPORTANT: stable callbacks (do NOT inline in JSX)
  const onSelectOpenConfig = useCallback((id) => {
    setSelectedTagId(id);
    setShowConfig(true);
  }, []);

  const onSelectNoop = useCallback(() => { }, []);

  const isConnected = connectionStatus === CONN.CONNECTED;
  const isBusy = connectionStatus === CONN.CONNECTING || connectionStatus === CONN.DISCONNECTING;
  // ✅ Prevent double run (StrictMode / refocus)
  const didFocusInitRef = useRef(false);
  const rxCountRef = useRef(0);
  const didRequestCfgRef = useRef(false);
  const didSendFastIntervalRef = useRef(false); // ✅ fast interval 只发一次
  const nameLockRef = useRef(new Map()); // channelId -> expireTimestampMs
  const lastGetNameAckRef = useRef({ a1: '', a2: '' }); // track latest Name1/Name2 ackId
  // ✅ Apply Name map into tags (device confirmed names)
  const pendingNameRef = useRef(new Map());   // channelId -> { value, expiresAt }
  const pendingRatingRef = useRef(new Map()); // channelId -> { value:[cur,sens], expiresAt }

  // UX/PERF: Pause UI flush briefly during tab switches so presses don't get queued behind MQTT updates.
  const suspendUiUntilRef = useRef(0);

  // PERF: Track current tab without recreating callbacks (used by enqueueTagPatch).
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // ===== PERF: batch tag updates (avoid many setTags per message) =====
  const pendingPatchRef = useRef({});
  const patchTimerRef = useRef(null);
  // UX/PERF: Switch tab immediately, cancel any pending flush, and pause updates for 200ms.
  const switchTab = useCallback((key) => {
    // Pause UI refresh for 200ms, prioritize clicks.
    suspendUiUntilRef.current = Date.now() + 200;

    // Key point: If a flush has already been scheduled, cancel it first to avoid an immediate delay.
    if (patchTimerRef.current) {
      clearTimeout(patchTimerRef.current);
      patchTimerRef.current = null;
    }

    setActiveTab(key);
  }, []);

  const enqueueTagPatch = useCallback((patch) => {
    if (!patch || typeof patch !== 'object') return;

    // merge patches
    const store = pendingPatchRef.current;
    for (const [id, partial] of Object.entries(patch)) {
      if (!partial) continue;
      store[id] = store[id] ? { ...store[id], ...partial } : partial;
    }

    if (patchTimerRef.current) return;
    // PERF: Dynamic flush interval.
    // - GRID needs faster refresh.
    // - LIST/THREE can refresh slower to keep UI responsive.
    // - Also respect the tab-switch pause window (suspendUiUntilRef).
    const now = Date.now();
    const suspendLeft = suspendUiUntilRef.current - now;
    const baseDelay = activeTabRef.current === TAB.GRID ? 120 : 150;
    const delay = Math.max(baseDelay, suspendLeft);

    patchTimerRef.current = setTimeout(() => {
      const batch = pendingPatchRef.current;
      pendingPatchRef.current = {};
      patchTimerRef.current = null;

      setTags((prev) => {
        let next = prev;        // Lazy copy: only clone when needed
        let didChange = false;

        for (const [idStr, partial] of Object.entries(batch)) {
          const id = Number(idStr);
          if (!Number.isFinite(id)) continue;

          const old = prev[id] || (id >= 201 ? default3P(id) : default1P(id));
          let out = old;

         // 1-phase current (ALWAYS derive ON/OFF from current)
if (partial.__cur1p != null) {
  const curNum = Number(partial.__cur1p);
  if (Number.isFinite(curNum)) {
    const statusFromCur = curNum < 0 ? 'OFF' : 'ON';

        // ✅ 锁定期内，只更新 current 数值，不覆盖 status
    const lockExp = toggleLockRef.current.get(id) || 0;
    const isLocked = Date.now() < lockExp;

    out = {
      ...out,
      current: formatCurrentA(curNum),
      seen: true,
       ...(isLocked ? {} : { status: statusFromCur }), // ✅ 锁定时不改 status
    }; 
  }
}

// 3-phase current (ALWAYS derive ON/OFF from current)
if (partial.__cur3p != null) {
  const t = partial.__cur3p;
  if (Array.isArray(t) && t.length >= 3) {
    const a = Number(t[0]), b = Number(t[1]), c = Number(t[2]);
    if ([a, b, c].every(Number.isFinite)) {
      const statusFromCur = (a < 0 || b < 0 || c < 0) ? 'OFF' : 'ON';
// ✅ 锁定期内，只更新电流数值，不覆盖 status
      const lockExp = toggleLockRef.current.get(id) || 0;
      const isLocked = Date.now() < lockExp;

      out = {
        ...out,
        seen: true,
        current: formatCurrentA(a),
        current1: formatCurrentA(a),
        current2: formatCurrentA(b),
        current3: formatCurrentA(c),
        ...(isLocked ? {} : { status: statusFromCur }), // ✅ 锁定时不改 status

      };
    }
  }
}

          const { __cur1p, __cur3p, ...rest } = partial;
          if (Object.keys(rest).length > 0) {
            out = { ...out, ...rest };
          }

          // Skip if nothing changed
          if (out === old) continue;

          // Clone map only once, at first change
          if (!didChange) {
            next = { ...prev };
            didChange = true;
          }

          next[id] = out;
        }

        return didChange ? next : prev;
      });

    }, delay); // delay = 80ms (GRID) or 250ms (LIST/THREE), also respects suspend window
  }, []);

  // Apply a small patch immediately (no batching) for instant UI feedback
  const applyTagPatchImmediate = useCallback((id, partial) => {
    const channelId = Number(id);
    if (!Number.isFinite(channelId)) return;

    setTags((prev) => {
      const old = prev[channelId] || (channelId >= 201 ? default3P(channelId) : default1P(channelId));
      const out = { ...old, ...partial };

      // Avoid re-render if no change
      for (const k of Object.keys(partial || {})) {
        if (old[k] !== out[k]) return { ...prev, [channelId]: out };
      }
      return prev;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
    };
  }, []);

  const clearTagsToUnknown = useCallback(() => {
    setTags((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        const id = Number(k);
        if (id >= 201 && id <= 224) {
          next[k] = {
            ...next[k],
            status: 'UNKNOWN',
            current: '-',
            current1: '-',
            current2: '-',
            current3: '-',
            rawStatus: 0x00,
            seen: false,
          };
        } else {
          next[k] = { ...next[k], status: 'UNKNOWN', current: '-', rawStatus: 0x00, seen: false };
        }
      });
      return next;
    });
  }, []);

  const publishToBothTopics = useCallback(async (payload) => {
    if (!topics.tSlash || !topics.tNoSlash) return;

    //console.log('[PUB BOTH] topic1 (/)=', topics.tSlash);
    await publishMqtt({ topic: topics.tSlash, payload, qos: 1, retained: false });

    //console.log('[PUB BOTH] topic2 (no /)=', topics.tNoSlash);
    await publishMqtt({ topic: topics.tNoSlash, payload, qos: 1, retained: false });
  }, [topics.tSlash, topics.tNoSlash]);

  const publishControl = useCallback(async (payload) => {
if (connectionStatusRef.current !== CONN.CONNECTED) return; // ✅ hard guard
  if (!topics.tSlash) return;
  await publishMqtt({ topic: topics.tSlash, payload, qos: 1, retained: false });
}, [topics.tSlash]);

const publishCfg = useCallback(async (payload) => {
  if (connectionStatusRef.current !== CONN.CONNECTED) return; // ✅ hard guard
  if (!topics.tSlash) return;
  if (typeof payload === 'string' && payload.includes('fast interval')) {
  console.log('[APP PUB fast interval]', new Date().toISOString(), topics.tSlash);
}
  await publishMqtt({ topic: topics.tSlash, payload, qos: 1, retained: false });
}, [topics.tSlash]);
const publishWrite = useCallback(async (payload) => {
  if (connectionStatusRef.current !== CONN.CONNECTED) return;
  if (!topics.tSlash) return;
  await publishMqtt({ topic: topics.tSlash, payload, qos: 0, retained: false });
}, [topics.tSlash]);

  const requestNameBank = useCallback(async (bank) => {
    if (!topics.tSlash) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const payload = JSON.stringify({
      cmdType: '5',
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: [bank], // "Name1" or "Name2"
        ack: false,
        ackId: randomHex8(),
      },
    });

    await publishCfg(payload);
  }, [topics.tSlash, derived.cpid, derived.deviceId, publishCfg]);

  // ===== Requests =====
  const requestNameMap = useCallback(async () => {
    if (!topics.tSlash && !topics.tNoSlash) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const base = {
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: { cpid: cpid, id: targetId, ack: false }, // ✅ cpId (NOT cpid)
    };

    const p1 = JSON.stringify({
      cmdType: '5',
      ...base,
      data: { ...base.data, command: ['Name1'], ackId: randomHex8() },
    });

    const p2 = JSON.stringify({
      cmdType: '5',
      ...base,
      data: { ...base.data, command: ['Name2'], ackId: randomHex8() },
    });

    await publishToBothTopics(p1);
    await publishToBothTopics(p2);

  }, [topics.tSlash, topics.tNoSlash, derived.cpid, derived.deviceId, publishCfg]);

  const requestRatingMap = useCallback(async () => {
    if (!topics.tSlash && !topics.tNoSlash) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const payload = JSON.stringify({
      cmdType: '4',
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: ['Rating'],
        ack: false,
        ackId: randomHex8(),
      },
    });

    await publishToBothTopics(payload);
  }, [topics.tSlash, topics.tNoSlash, derived.cpid, derived.deviceId, publishCfg]);

  // Send one time right after SUBSCRIBED
  const sendFastIntervalOnce = useCallback(async () => {
    if (didSendFastIntervalRef.current) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    didSendFastIntervalRef.current = true;

    const payload = JSON.stringify({
      cmdType: '4',
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: { cpid, id: targetId, command: ['fast interval'], ack: false, ackId: randomHex8() },
    });

    console.log('[FAST ONCE] sending');
    await publishCfg(payload);
    console.log('[FAST ONCE] sent');
  }, [derived.cpid, derived.deviceId, publishCfg]);

  // Send periodic tick (every 58s while connected)
  const sendFastIntervalTick = useCallback(async () => {
    const st = connectionStatusRef.current;
    if (st !== CONN.CONNECTED) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const payload = JSON.stringify({
      cmdType: '4',
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: { cpid, id: targetId, command: ['fast interval'], ack: false, ackId: randomHex8() },
    });

    console.log('[FAST TICK] sending @', new Date().toISOString());
    await publishCfg(payload);
    console.log('[FAST TICK] sent @', new Date().toISOString());
  }, [derived.cpid, derived.deviceId, publishCfg]);

  const stopFastIntervalTimer = useCallback(() => {
    if (fastTimerRef.current) {
      console.log('[FAST TIMER] STOP');
      clearTimeout(fastTimerRef.current);
      fastTimerRef.current = null;
    } else {
      console.log('[FAST TIMER] STOP (no timer)');
    }
  }, []);

  const startFastIntervalTimer = useCallback(() => {
    console.log('[FAST TIMER] START');

    // Prevent duplicates
    if (fastTimerRef.current) {
      console.log('[FAST TIMER] already running, skip');
      return;
    }

    const loop = () => {
      fastTimerRef.current = setTimeout(() => {
        const st = connectionStatusRef.current;
        console.log('[FAST TIMER] FIRE @', new Date().toISOString(), 'conn=', st);

        // If not connected, stop loop permanently
        if (st !== CONN.CONNECTED) {
          console.log('[FAST TIMER] STOP LOOP (not connected)');
          fastTimerRef.current = null;
          return;
        }

        sendFastIntervalTick();

        // Continue only if not stopped
        if (fastTimerRef.current) loop();
      }, 58_000);
    };

    loop();
  }, [sendFastIntervalTick]);

  // ===== Connect / Disconnect =====
  const connectNow = useCallback(async () => {
    if (isBusy || isConnected) return;

    setConnectionStatus(CONN.CONNECTING);

    if (!derived.cpid || !derived.deviceId) {
      toast('Topic invalid: missing cpid/deviceId');
      setConnectionStatus(CONN.DISCONNECTED);
      return;
    }

    const subTopic = `devices/${derived.cpid}/${derived.deviceId}/messages/events/#`;
    //const subTopic = `devices/${derived.cpid}/${derived.deviceId}/messages/#`;
    const useTls = Number(port) === 8883 || Number(port) === 8812;
    console.log('[SUB TOPIC]', subTopic);

    setStatusTextSoft(`CONNECTING ${host}:${port}`);
    clearTagsToUnknown();
    didRequestCfgRef.current = false;
    didSendFastIntervalRef.current = false; // ✅ reset fast interval flag
    try {
      await disconnectMqtt().catch(() => { });
      await connectAndSubscribe({
        host,
        port,
        username,
        password,
        topic: subTopic,
        useTls: true,
        onStatus: (s) => {
          // ✅ 1) 先打印原始 status（最重要）
          console.log('[MQTT STATUS RAW]', s);

          // ✅ 2) 再打印转换后的 msg（方便看 startsWith）
          const msg = typeof s === 'string' ? s : JSON.stringify(s ?? '');
          console.log('[MQTT STATUS]', msg);

          setStatusTextSoft(msg);

          const up = String(msg || '').toUpperCase();

          if (up.startsWith('CONNECTED')) {
            setConnectionStatus(CONN.CONNECTING);
            return;
          }
if (up.startsWith('SUBSCRIBED')) {
  // ✅ 1) 立刻把 ref 设为 CONNECTED（避免 publishCfg 的 guard 挡住）
  connectionStatusRef.current = CONN.CONNECTED;
  setConnectionStatus(CONN.CONNECTED);

  if (!didRequestCfgRef.current) {
    didRequestCfgRef.current = true;

    // ✅ 2) 立刻发 fast interval（不延迟）
    stopFastIntervalTimer();
    sendFastIntervalOnce();      // <-- 立刻发
    startFastIntervalTimer();    // <-- 开启 58s 循环

    // ✅ 3) Name/Rating 可以继续立刻发，或稍微延迟都行
    requestNameMap();
    requestRatingMap();
  }
  return;
}

          if (up.startsWith('DISCONNECTED')) {
            console.log('[MQTT STATUS] DISCONNECTED event');
            setConnectionStatus(CONN.DISCONNECTED);
            return;
          }

          if (up.startsWith('DISCONNECT')) {
            console.log('[MQTT STATUS] DISCONNECT event');
            setConnectionStatus(CONN.DISCONNECTING);
            return;
          }
        },

        onMessage: (m) => {
          rxCountRef.current += 1;

          const rxTopic = String(m?.topic || '');
          setStatusTextSoft(`RX ${rxCountRef.current}  ${rxTopic.slice(-30)}`);

          const text = m?.text ?? m;
          if (!text) return;

          let j = null;
          try {
            j = typeof text === 'string' ? JSON.parse(text) : text;
          } catch (_) {
            return;
          }
          const cmdType = String(j?.cmdType ?? '');
          const hasCurrent = !!(j?.d?.current || j?.data?.current || j?.current);
          const nameMap2 = extractNameMap(j);   // compute once
          // if (__DEV__ && nameMap2) {
          //   console.log('[RX NAME] keys=', Object.keys(nameMap2).length);
          // }

          const hasName = !!nameMap2;

          const hasRating =
            !!(j?.d?.Rating || j?.data?.Rating || j?.d?.command?.Rating || j?.data?.command?.Rating);

          // If message has nothing we care, skip heavy parsing
          if (!hasCurrent && !hasName && !hasRating && cmdType !== '1' && cmdType !== '4' && cmdType !== '5') {
            return;
          }

          const patch = {};
          const put = (id, partial) => {
            const key = String(id);
            patch[key] = patch[key] ? { ...patch[key], ...partial } : partial;
          };

          // =========================
          // 1) Current map (1P + 3P)
          // =========================
          const curMap = parseCurrentMap(j);
          if (curMap && (curMap.C201 != null || curMap.C202 != null || curMap.C203 != null)) {
          }

          if (curMap) {
            for (const [k, v] of Object.entries(curMap)) {
              const m2 = String(k).match(/C(\d+)/i);
              const id = m2 ? parseInt(m2[1], 10) : parseInt(k, 10);
              if (!Number.isFinite(id)) continue;

              if (id >= 1 && id <= 120) {
                const curNum = normalizeNumber(v);
                if (!Number.isFinite(curNum)) continue;
                put(id, { __cur1p: curNum });
                continue;
              }

              if (id >= 201 && id <= 224) {
                const triple = parse3PhaseValue(v);
                if (!triple) continue;
                put(id, { __cur3p: triple });
              }
            }
          }

          // =========================
          // 2) Name map + lock (same logic as yours)
          // =========================

          if (nameMap2) {
            const toSave = {}; // store only meaningful names for cache

            for (const [k, v] of Object.entries(nameMap2)) {
              const mm = String(k).match(/C(\d+)/i);
              const id = mm ? parseInt(mm[1], 10) : NaN;
              if (!Number.isFinite(id)) continue;

              const gotName = sanitizeName(v);

              // ✅ Do not overwrite with empty name
              if (!gotName) continue;

              // ✅ Optional: prevent overwriting custom names with default device names
              if (/^Device\s+\d+$/i.test(gotName)) continue;

              const pending = pendingNameRef.current.get(id);
              if (pending && Date.now() <= pending.expiresAt) {
                const expected = String(pending.value ?? '').trim();
                if (gotName === expected) {
                  pendingNameRef.current.delete(id);
                  nameLockRef.current.set(id, 0);
                  toast(`Name saved: C${id}`);
                } else {
                  continue; // ignore stale overwrite during pending window
                }
              } else {
                const exp = nameLockRef.current.get(id) || 0;
                if (Date.now() < exp) continue; // still locked, ignore overwrites
              }

              put(id, { tagName: gotName, seen: true });
              toSave[`C${id}`] = gotName;
            }

            // ✅ Save to local cache (async, does not block UI)
            saveNameCache({
              cpid: derived.cpid,
              deviceId: derived.deviceId,
              partialMap: toSave,
            });
          }

          // =========================
          // 3) Command echoes (ON/OFF, Set Name, Set Rating)
          // =========================
          const cmdRaw = j?.data?.command || j?.d?.command;
          const cmdList = Array.isArray(cmdRaw)
            ? cmdRaw
            : (cmdRaw && typeof cmdRaw === 'object')
              ? [cmdRaw]
              : [];

          if (cmdList.length > 0) {
            // 3a) ON/OFF
            const first = cmdList[0] || {};
            const onVal = first.ON ?? first.on;
            const offVal = first.OFF ?? first.off;

            const act = onVal != null ? 'ON' : offVal != null ? 'OFF' : null;
            const ch = onVal ?? offVal;

            if (act && ch != null) {
              const m3 = String(ch ?? '').match(/C(\d+)/i);
              const id = m3 ? parseInt(m3[1], 10) : parseInt(ch, 10);
              if (Number.isFinite(id)) put(id, { status: act, seen: true });
            }

            // 3b) Set Name echo
            for (const one of cmdList) {
              const setNameObj = one?.['Set Name'];
              if (setNameObj && typeof setNameObj === 'object') {
                for (const [kk, vv] of Object.entries(setNameObj)) {
                  const mm = String(kk).match(/C(\d+)/i);
                  const id = mm ? parseInt(mm[1], 10) : NaN;
                  if (!Number.isFinite(id)) continue;

                  const newName = sanitizeName(vv);
                  if (!newName) continue;

                  put(id, { tagName: newName, seen: true });
                  nameLockRef.current.set(id, Date.now() + 8000);

                  // ✅ Save echo name to cache (keeps cache consistent)
                  saveNameCache({
                    cpid: derived.cpid,
                    deviceId: derived.deviceId,
                    partialMap: { [`C${id}`]: newName },
                  });
                }
                break;
              }
            }


            // 3c) Set Rating echo
            for (const one of cmdList) {
              const setRatingObj = one?.['Set Rating'];
              if (setRatingObj && typeof setRatingObj === 'object') {
                for (const [kk, vv] of Object.entries(setRatingObj)) {
                  const mm = String(kk).match(/C(\d+)/i);
                  const id = mm ? parseInt(mm[1], 10) : NaN;
                  if (!Number.isFinite(id)) continue;
                  if (!Array.isArray(vv) || vv.length < 2) continue;

                  const cur = Number(vv[0]);
                  const sens = Number(vv[1]);
                  if (!Number.isFinite(cur) || !Number.isFinite(sens)) continue;

                  put(id, { currentRating: cur, sensitivity: sens, seen: true });
                }
                break;
              }
            }
          }

          // =========================
          // 4) Rating map (device reply)
          // =========================
          const ratingMap =
            j?.d?.Rating ||
            j?.data?.Rating ||
            j?.d?.command?.Rating ||
            j?.data?.command?.Rating;

          if (ratingMap && typeof ratingMap === 'object') {
            for (const [k, v] of Object.entries(ratingMap)) {
              const mm = String(k).match(/C(\d+)/i);
              const id = mm ? parseInt(mm[1], 10) : NaN;
              if (!Number.isFinite(id)) continue;

              if (!Array.isArray(v) || v.length < 2) continue;
              const cur = Number(v[0]);
              const sens = Number(v[1]);
              if (!Number.isFinite(cur) || !Number.isFinite(sens)) continue;

              put(id, { currentRating: cur, sensitivity: sens, seen: true });

              const p = pendingRatingRef.current.get(id);
              if (p && Date.now() <= p.expiresAt) {
                const expCur = Number(p.value?.[0]);
                const expSens = Number(p.value?.[1]);
                if (cur === expCur && sens === expSens) {
                  pendingRatingRef.current.delete(id);
                  toast(`Rating saved: C${id}`);
                }
              }
            }
          }

          if (Object.keys(patch).length > 0) {
            enqueueTagPatch(patch);
          }
        },

        onError: (msg) => {
          console.log('[MQTT ERROR]', msg);
          setStatusTextSoft('DISCONNECTED');
          setConnectionStatus(CONN.DISCONNECTED);
          toast(msg || 'MQTT error');
        },
      });

    } catch (e) {
      console.log('[MQTT CONNECT CATCH]', e?.message || String(e));
      setStatusTextSoft('DISCONNECTED');
      setConnectionStatus(CONN.DISCONNECTED);
      toast(e?.message || String(e));
    }
  }, [
    isBusy,
    isConnected,
    host,
    port,
    username,
    password,
    clearTagsToUnknown,
    derived,
    requestNameMap,
    requestRatingMap,
    setStatusTextSoft,
    enqueueTagPatch,
    sendFastIntervalOnce,
    sendFastIntervalTick,
    startFastIntervalTimer,
    stopFastIntervalTimer,
  ]);

  const disconnectAndStop = useCallback(async (reason) => {
  console.log('[DISCONNECT]', reason);

  // 1) cancel all pending timeouts (80ms/2500ms/8200ms...)
  clearAllTimeouts();

  // 2) stop fast timer
  stopFastIntervalTimer();

  // 3) update UI state to block any publish immediately
  setConnectionStatus(CONN.DISCONNECTING);
  setStatusTextSoft('DISCONNECTING');

  try {
    await disconnectMqtt();
    console.log('[DISCONNECT] disconnectMqtt done');
  } catch (e) {
    console.log('[DISCONNECT] disconnectMqtt error', e?.message || String(e));
  } finally {
    setConnectionStatus(CONN.DISCONNECTED);
    setStatusTextSoft('DISCONNECTED');

    didRequestCfgRef.current = false;
    didSendFastIntervalRef.current = false;
  }
}, [
  clearAllTimeouts,
  stopFastIntervalTimer,
  setStatusTextSoft,
]);

const disconnectNow = useCallback(async () => {
  if (isBusy) return;
  await disconnectAndStop('menuDisconnect');
  clearTagsToUnknown();
}, [isBusy, disconnectAndStop, clearTagsToUnknown]);

useEffect(() => {
  const unsub = navigation.addListener('beforeRemove', () => {
    // 离开这个 screen（返回/跳转/replace）都一定断线
    disconnectAndStop('beforeRemove');
  });
  return unsub;
}, [navigation, disconnectAndStop]);

  useEffect(() => {
    return () => {
      // ✅ Reset guard when leaving the screen
      didFocusInitRef.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (didFocusInitRef.current) return () => { };
      didFocusInitRef.current = true;

      const t0 = Date.now();
      console.log('[NAV] focus', t0);

      setUiReady(false);
      // ✅ Load cached names immediately (does not block navigation animation)
      loadNameCache({
        cpid: derived.cpid,
        deviceId: derived.deviceId,
        setTags,
      });

      const task = InteractionManager.runAfterInteractions(() => {
        const t1 = Date.now();
        console.log('[NAV] afterInteractions', t1, 'cost=', t1 - t0);

        setUiReady(true);

        requestAnimationFrame(() => {
          const t2 = Date.now();
          console.log('[NAV] firstFrameAfterUiReady', t2, 'cost=', t2 - t0);

          safeSetTimeout(() => {
            const t3 = Date.now();
            console.log('[MQTT] connectNow()', t3, 'cost=', t3 - t0);
            connectNow();
          }, 300);
        });
      });

      return () => task?.cancel?.();
    }, [connectNow, derived.cpid, derived.deviceId])
  );

  //blur cleanup
useFocusEffect(
  useCallback(() => {
    console.log('[SCREEN] FOCUS DeviceDetail');
    return () => {
      console.log('[SCREEN] BLUR DeviceDetail');
      clearAllTimeouts();
      stopFastIntervalTimer();
      // 不在 blur 做 disconnect，交给 beforeRemove 统一处理
    };
  }, [clearAllTimeouts, stopFastIntervalTimer])
);

  // ===== Publish commands =====
  const handleToggle = useCallback((id, action) => {
    if (connectionStatus !== CONN.CONNECTED) return;

    // Give touch events priority: pause UI flush briefly and cancel pending timer
    suspendUiUntilRef.current = Date.now() + 250;
    if (patchTimerRef.current) {
      clearTimeout(patchTimerRef.current);
      patchTimerRef.current = null;
    }

    const act = action === 'OFF' ? 'OFF' : 'ON';
const lockDuration = Platform.OS === 'android' ? 5000 : 3000;
    toggleLockRef.current.set(id, Date.now() + lockDuration);
    // Instant UI feedback (no batching)
    applyTagPatchImmediate(id, { status: act, seen: true });

    // Publish in next tick (do not block UI thread)
    safeSetTimeout(() => {
      const cpid = derived.cpid;
      const gatewayId = derived.deviceId;
      if (!cpid || !gatewayId) return;

      const payload = JSON.stringify(
        buildCmdSupervisorExact({
          cpid,
          targetId: gatewayId,
          action: act,
          channelId: id,
          ackId: randomHex8(),
          useCPrefix: true,
        })
      );

      publishControl(payload).catch((e) => {
        toast(e?.message || String(e));
        toggleLockRef.current.delete(id);
        enqueueTagPatch({ [id]: { status: act === 'ON' ? 'OFF' : 'ON', seen: true } });
      });
    }, 0);
  }, [connectionStatus, derived.cpid, derived.deviceId, publishControl, enqueueTagPatch, applyTagPatchImmediate]);

  const publishSetName = useCallback(async (ch, newName) => {
    if (connectionStatus !== CONN.CONNECTED) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const channel = Number(ch);
    const nameStr = String(newName ?? '').trim();

    if (!Number.isFinite(channel) || !nameStr) {
      toast('Invalid channel/name');
      return;
    }

    // pending + lock
    pendingNameRef.current.set(channel, { value: nameStr, expiresAt: Date.now() + 8000 });
    nameLockRef.current.set(channel, Date.now() + 8000);

    const ackIdA = randomHex8();
    const ackIdB = randomHex8();

    // A) Object schema
    const payloadObjA = {
      cmdType: 5, // ✅ number
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: { 'Set Name': { [`C${channel}`]: nameStr } },
        ack: true,
        ackId: ackIdA,
      },
    };

    // B) Array schema
    const payloadObjB = {
      cmdType: 5, // ✅ number
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: [{ 'Set Name': { [`C${channel}`]: nameStr } }],
        ack: true,
        ackId: ackIdB,
      },
    };

    console.log('[PUB SetName A]', JSON.stringify(payloadObjA));
    console.log('[PUB SetName B]', JSON.stringify(payloadObjB));

    // Optimistic UI: update via batched patch (avoid copying whole tags map)
    enqueueTagPatch({
      [channel]: { tagName: nameStr, seen: true },
    });
    // ✅ Save immediately so next time screen opens it shows instantly
    saveNameCache({
      cpid: derived.cpid,
      deviceId: derived.deviceId,
      partialMap: { [`C${channel}`]: nameStr },
    });

    // ✅ write both formats using QoS0
    await publishWrite(JSON.stringify(payloadObjA));
    await publishWrite(JSON.stringify(payloadObjB));

    // ✅ read back to confirm
    const bank = (channel >= 1 && channel <= 80) ? 'Name1' : 'Name2';
    safeSetTimeout(() => requestNameBank(bank), 2500);


    toast(`Set Name C${channel}`);

    // timeout fallback
    safeSetTimeout(() => {
      const p = pendingNameRef.current.get(channel);
      if (!p) return;
      pendingNameRef.current.delete(channel);
      nameLockRef.current.set(channel, 0);
      toast(`Name save timeout: C${channel}`);
      requestNameBank(bank);
    }, 8200);

  }, [connectionStatus, derived.cpid, derived.deviceId, publishWrite, requestNameBank, enqueueTagPatch]);


  const publishSetRating = useCallback(async (ch, currentA, sensLevel) => {
    if (connectionStatus !== CONN.CONNECTED) return;

    const cpid = derived.cpid;
    const targetId = derived.deviceId;
    if (!cpid || !targetId) return;

    const channel = Number(ch);
    const cur = Number(currentA);
    const sens = Number(sensLevel);

    if (!Number.isFinite(channel) || !Number.isFinite(cur) || !Number.isFinite(sens)) {
      toast('Invalid current/sensitivity');
      return;
    }

    pendingRatingRef.current.set(channel, { value: [cur, sens], expiresAt: Date.now() + 8000 });

    const ackIdA = randomHex8();
    const ackIdB = randomHex8();

    // A) Object schema
    const payloadObjA = {
      cmdType: 4, // ✅ number
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: { 'Set Rating': { [`C${channel}`]: [cur, sens] } },
        ack: true,
        ackId: ackIdA,
      },
    };

    // B) Array schema
    const payloadObjB = {
      cmdType: 4, // ✅ number
      t: new Date().toISOString(),
      sdk: { e: 'DengKai', v: '1.0' },
      data: {
        cpid,
        id: targetId,
        command: [{ 'Set Rating': { [`C${channel}`]: [cur, sens] } }],
        ack: true,
        ackId: ackIdB,
      },
    };

    console.log('[PUB SetRating A]', JSON.stringify(payloadObjA));
    console.log('[PUB SetRating B]', JSON.stringify(payloadObjB));

    // ✅ Send both formats using QoS0
    await publishWrite(JSON.stringify(payloadObjA));
    await publishWrite(JSON.stringify(payloadObjB));

    // ✅ Read back soon to confirm
    safeSetTimeout(() => requestRatingMap?.(), 2500);

    toast(`Set Rating C${channel}`);

    // Timeout fallback
    safeSetTimeout(() => {
      const p = pendingRatingRef.current.get(channel);
      if (!p) return;
      pendingRatingRef.current.delete(channel);
      toast(`Rating save timeout: C${channel}`);
      requestRatingMap?.();
    }, 8200);
  }, [connectionStatus, derived.cpid, derived.deviceId, publishWrite, requestRatingMap]);

  const renderTab = (key, label, icon) => {
    const active = activeTab === key;
    const color = active ? '#2196F3' : '#757575';
    return (
      <TouchableOpacity key={key} style={styles.tabItem} onPress={() => switchTab(key)} activeOpacity={0.85}>
        <MaterialIcons name={icon} size={24} color={color} />
        <Text style={[styles.tabLabel, { color }]}>{label}</Text>
        {active && <View style={styles.tabIndicator} />}
      </TouchableOpacity>
    );
  };

  const selectedItem = selectedTagId != null ? tags?.[selectedTagId] || { id: selectedTagId } : null;

  const refreshNow = useCallback(async () => {
    // Clear cached names for this gateway (fix garbled names like "����")
    try {
      await AsyncStorage.removeItem(nameCacheKey(derived.cpid, derived.deviceId));
    } catch (e) {
      console.log('[NAME CACHE] remove failed', e?.message || String(e));
    }

    clearTagsToUnknown();
    toast('Refreshing...');
    setShowMenu(false);

    if (connectionStatus === CONN.CONNECTED) {
      didRequestCfgRef.current = false;
      requestNameMap();
      requestRatingMap();
      didRequestCfgRef.current = true;
    }
  }, [clearTagsToUnknown, connectionStatus, requestNameMap, requestRatingMap, derived.cpid, derived.deviceId]);
  /*const onGoBle = useCallback(() => {
    setShowMenu(false);
    Alert.alert('Bluetooth (BLE)', 'Coming soon.');
  }, []);*/

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          ref={menuButtonRef}
          onPress={toggleMenu}
          style={{ paddingHorizontal: 10, paddingVertical: 6 }}
        >
          <MaterialIcons name="more-vert" size={28} color="#333" />
        </TouchableOpacity>
      ),
    });
  }, [navigation, toggleMenu]);
  return (
    <View style={styles.container}>
      <Modal
        visible={showMenu}
        transparent
        animationType="none"
        onRequestClose={() => setShowMenu(false)}
      >
        {/* 全屏点击关闭 */}
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowMenu(false)}>
          {/* 阻止点到菜单时关闭 */}
          <Pressable
            onPress={() => { }}
            style={[
              styles.menuDropdown,
              {
                position: 'absolute',
                top: menuAnchor.y + menuAnchor.h - 30,
                right: Math.max(0, width - (menuAnchor.x + menuAnchor.w) - 2),

              },
            ]}

          >
            <TouchableOpacity
              style={[styles.menuItem, !isConnected && styles.disabledMenuItem]}
              disabled={!isConnected}
              onPress={() => { refreshNow(); setShowMenu(false); }}
            >
              <Text style={styles.menuText}>Refresh</Text>
            </TouchableOpacity>

            {isConnected ? (
              <TouchableOpacity
                style={[styles.menuItem, isBusy && styles.disabledMenuItem]}
                disabled={isBusy}
                onPress={() => {
                  disconnectNow();
                  setShowMenu(false);
                }}
              >
                <Text style={styles.menuText}>Disconnect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.menuItem, isBusy && styles.disabledMenuItem]}
                disabled={isBusy}
                onPress={() => {
                  connectNow();
                  setShowMenu(false);
                }}
              >
                <Text style={styles.menuText}>Connect</Text>
              </TouchableOpacity>
            )}

            {Platform.OS === 'android' && (
              <TouchableOpacity style={[styles.menuItem, styles.menuItemLast]} onPress={() => { setShowMenu(false); BackHandler.exitApp(); }}>
                <Text style={styles.menuText}>Exit</Text>
              </TouchableOpacity>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Header */}
      <View style={styles.header}>
        <Image source={require('../assets/images/circuitbreaker.png')} style={styles.icon} />

        <View style={styles.deviceInfoColumn}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {deviceName}
          </Text>
          <Text style={styles.deviceId} numberOfLines={1}>
            {hwId}
          </Text>
          <Text style={styles.deviceId} numberOfLines={1}>
            {host}:{port}
          </Text>
        </View>

        <View style={[styles.statusIndicator, { backgroundColor: getStatusColor(connectionStatus) }]}>
          <Text style={styles.statusText}>{connectionStatus.toUpperCase()}</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {renderTab(TAB.GRID, 'Grid', 'grid-on')}
        {renderTab(TAB.LIST, 'List', 'list')}
        {renderTab(TAB.THREE, '3-Phase', 'alt-route')}
      </View>

      <View style={{ flex: 1 }} onLayout={onContentLayout}>
        {!uiReady || contentW <= 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#0F172A' }}>
              Opening device...
            </Text>
            <Text style={{ marginTop: 6, color: '#64748B' }}>
              Loading UI & connecting MQTT
            </Text>
          </View>
        ) : (
          <View style={styles.contentWrap}>
            {/* GRID (always mounted) */}
            <View style={[styles.tabPage, activeTab === TAB.GRID ? styles.shown : styles.hidden]}>
              <DeviceGridView
                tags={tags}
                connectionStatus={connectionStatus}
                onToggle={handleToggle}
                onSelect={onSelectNoop}
                layoutWidth={contentW}   // ✅关键：传真实宽度
              />
            </View>

            {/* LIST (always mounted) */}
            <View style={[styles.tabPage, activeTab === TAB.LIST ? styles.shown : styles.hidden]}>
              <DeviceListView
                tags={tags}
                connectionStatus={connectionStatus}
                onToggle={handleToggle}
                onSelect={onSelectOpenConfig}
              />
            </View>

            {/* THREE (always mounted) */}
            <View style={[styles.tabPage, activeTab === TAB.THREE ? styles.shown : styles.hidden]}>
              <ThreePhaseView
                tags={tags}
                onToggle={handleToggle}
                onSelect={onSelectOpenConfig}
              />
            </View>
          </View>
        )}
      </View>

      {false && __DEV__ && (
        <View style={styles.debugBox}>
          <Text style={styles.debugText}>status: {statusText}</Text>
          <Text style={styles.debugText}>derived: cpid={derived.cpid} deviceId={derived.deviceId}</Text>
          <Text style={styles.debugText}>C17 tagName in state: {String(tags?.[17]?.tagName || '')}</Text>
          <Text style={styles.debugText}>C18 tagName in state: {String(tags?.[18]?.tagName || '')}</Text>
          <Text style={styles.debugText}>C201 tagName in state: {String(tags?.[201]?.tagName || '')}</Text>

          {selectedTagId != null ? (
            <Text style={styles.debugText}>
              cfg: name={tags?.[selectedTagId]?.tagName}  rating={tags?.[selectedTagId]?.currentRating}  sens={tags?.[selectedTagId]?.sensitivity}
            </Text>
          ) : null}
          {selectedTagId != null ? <Text style={styles.debugText}>selected: {selectedTagId}</Text> : null}
        </View>
      )}

      {/* Config dialog */}
      <DeviceConfigDialog
        visible={showConfig}
        onClose={() => setShowConfig(false)}
        item={selectedItem}
        onSaveName={(ch, name) => publishSetName(ch, name)}
        onSaveCurrent={(ch, cur, sens) => publishSetRating(ch, cur, sens)}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  contentWrap: { flex: 1 },
  tabPage: { ...StyleSheet.absoluteFillObject },
  shown: { opacity: 1, pointerEvents: 'auto' },
  hidden: { opacity: 0, pointerEvents: 'none' },

  container: { flex: 1, padding: 16, backgroundColor: '#F5F6F8' }, // ✅图1灰底

  menuItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EEE',
  },

  menuText: { fontSize: 16, color: '#333' },
  disabledMenuItem: { opacity: 0.5 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  deviceInfoColumn: { flex: 1, marginLeft: 12, marginRight: 16 },
  deviceName: { fontSize: 16, fontWeight: '600', color: '#1E293B', marginBottom: 4 },
  deviceId: { fontSize: 12, color: '#64748B', fontWeight: '400', opacity: 0.8 },
  statusIndicator: { alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 },
  statusText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
  icon: { width: 40, height: 40, resizeMode: 'contain' },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderRadius: 8,
    marginBottom: 12,
    overflow: 'hidden',
    elevation: 1,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  tabLabel: { fontSize: 14, fontWeight: 'bold', marginTop: 4 },
  tabIndicator: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: '#2196F3',
  },

  menuDropdown: {
    position: 'absolute',
    backgroundColor: 'white',
    borderRadius: 6,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    minWidth: 170,
    overflow: 'hidden',
  },

  menuItemLast: {
    borderBottomWidth: 0,
  },
  gridItem: {
    margin: 2,
    padding: 2,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    justifyContent: 'space-between',
    elevation: 0,
    overflow: 'hidden',
  },

  debugBox: { marginTop: 10, padding: 10, backgroundColor: '#FFFFFF', borderRadius: 8 },
  debugText: { color: '#334155' },
});