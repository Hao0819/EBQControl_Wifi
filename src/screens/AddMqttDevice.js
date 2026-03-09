// src/screens/AddMqttDevice.js
import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { CommonActions } from '@react-navigation/native';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';

import { authenticateForAddDevice } from '../utils/MqttManager';
import { addMqttDevice } from '../utils/MqttDeviceStorage';

// Server presets
const PRESETS = [
  { key: 'select', label: 'Select server', host: '', port: '', user: '', pass: '' },
  { key: 'myebq', label: 'myebq.ddns.net', host: 'myebq.ddns.net', port: '8883', user: 'dengkai', pass: 'myEBQ_dk' },
  { key: 'webiot', label: 'webiot.loranet.my', host: 'webiot.loranet.my', port: '8812', user: 'iotdbuser', pass: 'IoTdb2024' },
  { key: 'custom', label: 'Custom', host: '', port: '', user: '', pass: '' },
];

export default function AddMqttDevice({ navigation }) {
  // ===== Preset selection =====
  const [presetKey, setPresetKey] = useState('select');

  const selectedPreset = useMemo(() => {
    return PRESETS.find(p => p.key === presetKey) ?? PRESETS[0];
  }, [presetKey]);

  const isCustom = presetKey === 'custom';
  const isSelected = presetKey !== 'select';
  const isPresetServer = presetKey === 'myebq' || presetKey === 'webiot';

  // ===== Dropdown =====
  const [serverOpen, setServerOpen] = useState(false);
  const [serverAnchor, setServerAnchor] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const serverRef = useRef(null);

  const openServerMenu = useCallback(() => {
    if (serverRef.current?.measureInWindow) {
      serverRef.current.measureInWindow((x, y, w, h) => {
        setServerAnchor({ x, y, w, h });
        setServerOpen(true);
      });
    } else {
      setServerOpen(true);
    }
  }, []);

  // ===== Form fields =====
  const [friendlyName, setFriendlyName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceId, setDeviceId] = useState('');

  // ===== UI state =====
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (presetKey === 'select') {
      setHost(''); setPort(''); setUsername(''); setPassword('');
      return;
    }
    if (presetKey === 'custom') {
      setHost(''); setPort(''); setUsername(''); setPassword('');
      return;
    }
    setHost(selectedPreset.host);
    setPort(selectedPreset.port);
    setUsername(selectedPreset.user);
    setPassword(selectedPreset.pass);
  }, [presetKey, selectedPreset]);

  const normalizedDeviceId = useMemo(() => {
    return String(deviceId || '').trim().toUpperCase();
  }, [deviceId]);

  const parsedPort = useMemo(() => {
    const p = Number(String(port).trim());
    return Number.isFinite(p) ? p : 0;
  }, [port]);

  // ✅ If user leaves friendly name empty, fall back to device ID as the name
  const effectiveFriendlyName = useMemo(() => {
    const trimmed = friendlyName.trim();
    if (trimmed) return trimmed;
    if (normalizedDeviceId) return normalizedDeviceId;
    return '';
  }, [friendlyName, normalizedDeviceId]);

  const validate = () => {
    if (presetKey === 'select') return 'Please select a server to continue.';
    if (!host.trim()) return 'MQTT Broker Host is required.';
    if (!parsedPort || parsedPort <= 0 || parsedPort > 65535) return 'Port number is invalid.';
    if (!normalizedDeviceId) return 'Device ID (MAC address) is required.';
    return '';
  };

  const onAdd = async () => {
    if (busy) return;
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    setBusy(true);
    try {
      const cpId = '51c5c752';

      const auth = await authenticateForAddDevice({
        host: host.trim(),
        port: parsedPort,
        username: String(username || '').trim(),
        password: String(password || ''),
        cpId,
        deviceId: normalizedDeviceId,
      });

      const device = {
        friendlyName: effectiveFriendlyName,
        name: effectiveFriendlyName,
        deviceId: normalizedDeviceId,
        host: host.trim(),
        port: parsedPort,
        username: String(username || '').trim(),
        password: String(password || ''),
        useTls: auth.useTls,
        topic: auth.topicSub,
        topicBase: auth.topicBase,
        cpId,
        presetKey,
        lastStatus: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      await addMqttDevice(device);

      const rootNav = navigation.getParent?.() ?? navigation;
      rootNav.dispatch(
        CommonActions.reset({
          index: 1,
          routes: [
            { name: 'MqttDeviceList' },
            { name: 'MqttDeviceDetail', params: { device, autoConnect: true } },
          ],
        })
      );
    } catch (e) {
      setError(e?.message || 'Connection failed. Please check your settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#F1F5F9' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>ADD MQTT DEVICE</Text>

          {/* SERVER */}
          <Label text="SERVER" />
          <Pressable
            ref={serverRef}
            onPress={() => !busy && openServerMenu()}
            style={({ pressed }) => [
              styles.selectBox,
              serverOpen && styles.selectBoxOpen,
              pressed && !busy ? { opacity: 0.95 } : null,
              busy ? { opacity: 0.7 } : null,
            ]}
          >
            <Text style={[styles.selectText, presetKey === 'select' && styles.selectPlaceholder]}>
              {presetKey === 'select' ? 'Select a server...' : selectedPreset.label}
            </Text>
            <Text style={styles.chevron}>{serverOpen ? '˄' : '˅'}</Text>
          </Pressable>

          {/* DEVICE FRIENDLY NAME */}
          <Label text="DEVICE NAME (OPTIONAL)" />
          <TextInput
            style={styles.input}
            placeholder={
              normalizedDeviceId
                ? `Leave blank to use "${normalizedDeviceId}"`
                : 'e.g. Office Controller, Lab Sensor'
            }
            placeholderTextColor="#94A3B8"
            value={friendlyName}
            onChangeText={setFriendlyName}
            editable={!busy}
          />
          {/* Show preview of effective name */}
          {!friendlyName.trim() && normalizedDeviceId ? (
            <Text style={styles.nameFallbackHint}>
              Will be saved as: <Text style={styles.nameFallbackValue}>{normalizedDeviceId}</Text>
            </Text>
          ) : friendlyName.trim() ? (
            <Text style={styles.nameFallbackHint}>
              Will be saved as: <Text style={styles.nameFallbackValue}>{friendlyName.trim()}</Text>
            </Text>
          ) : null}

          {/* HOST + PORT */}
          <View style={styles.row}>
            <View style={{ flex: 2 }}>
              <Label text="BROKER HOST" />
              <TextInput
                style={[styles.input, isSelected && !isCustom ? styles.inputLocked : null]}
                value={host}
                onChangeText={setHost}
                editable={!busy && isCustom}
                placeholder={isCustom ? 'e.g. broker.hivemq.com' : ''}
                placeholderTextColor="#94A3B8"
              />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Label text="PORT" />
              <TextInput
                style={[styles.input, isSelected && !isCustom ? styles.inputLocked : null]}
                value={String(port)}
                onChangeText={setPort}
                keyboardType="numeric"
                editable={!busy && isCustom}
                placeholder={isCustom ? '1883' : ''}
                placeholderTextColor="#94A3B8"
              />
            </View>
          </View>

          {/* USERNAME + PASSWORD */}
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Label text="USERNAME (OPTIONAL)" />
              <TextInput
                style={[styles.input, isSelected && !isCustom ? styles.inputLocked : null]}
                value={username}
                onChangeText={setUsername}
                editable={!busy && isCustom}
                placeholder={isCustom ? 'username' : ''}
                placeholderTextColor="#94A3B8"
                autoCapitalize="none"
              />
            </View>
            <View style={{ width: 12 }} />
            <View style={{ flex: 1 }}>
              <Label text="PASSWORD (OPTIONAL)" />
              <TextInput
                style={[styles.input, isSelected && !isCustom ? styles.inputLocked : null]}
                value={password}
                onChangeText={setPassword}
                editable={!busy && isCustom}
                placeholder={isCustom ? 'password' : ''}
                placeholderTextColor="#94A3B8"
                secureTextEntry
              />
            </View>
          </View>

          {/* DEVICE ID */}
          <Label text="DEVICE ID (MAC ADDRESS)" />
          <TextInput
            style={styles.input}
            value={normalizedDeviceId}
            onChangeText={(t) => setDeviceId(String(t || '').toUpperCase())}
            autoCapitalize="characters"
            editable={!busy}
            placeholder="e.g. A208F6C7F"
            placeholderTextColor="#94A3B8"
          />

          {!!error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠ {error}</Text>
            </View>
          )}

          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.cancelBtn, busy && { opacity: 0.6 }]}
              onPress={() => navigation.goBack()}
              disabled={busy}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.addBtn, busy && { opacity: 0.7 }]}
              onPress={onAdd}
              disabled={busy}
            >
              {busy ? (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="#FFFFFF" />
                  <Text style={[styles.addText, { marginLeft: 8 }]}>Connecting...</Text>
                </View>
              ) : (
                <Text style={styles.addText}>Add & Connect</Text>
              )}
            </TouchableOpacity>
          </View>

          {/* Hints */}
          {!isSelected && (
            <Text style={styles.hint}> Please select a server to get started.</Text>
          )}
          {isPresetServer && (
            <Text style={styles.hint}>✓ Server credentials are pre-filled. Only Device ID is required.</Text>
          )}
        </View>
      </ScrollView>

      {/* Dropdown Modal */}
      <Modal
        transparent
        visible={serverOpen}
        animationType="fade"
        onRequestClose={() => setServerOpen(false)}
      >
        <Pressable style={styles.overlay} onPress={() => setServerOpen(false)}>
          <View
            style={[
              styles.dropdown,
              {
                left: serverAnchor.x,
                top: serverAnchor.y + serverAnchor.h + 1,
                width: serverAnchor.w || 260,
              },
            ]}
          >
            {PRESETS.filter(p => p.key !== 'select').map(p => (
              <Pressable
                key={p.key}
                onPress={() => { setPresetKey(p.key); setServerOpen(false); }}
                style={({ pressed }) => [
                  styles.dropdownItem,
                  pressed ? styles.dropdownItemPressed : null,
                  presetKey === p.key ? styles.dropdownItemActive : null,
                ]}
              >
                <Text style={[
                  styles.dropdownText,
                  presetKey === p.key ? styles.dropdownTextActive : null,
                ]}>
                  {p.label}
                </Text>
                {presetKey === p.key && <Text style={styles.dropdownCheck}>✓</Text>}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Label({ text }) {
  return <Text style={styles.label}>{text}</Text>;
}

const styles = StyleSheet.create({
  container: { padding: 16 },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 12,
    letterSpacing: 0.6,
  },

  label: {
    fontSize: 11,
    fontWeight: '600',
    color: '#64748B',
    marginTop: 14,
    marginBottom: 4,
    letterSpacing: 0.3,
  },

  input: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1E293B',
    backgroundColor: '#fff',
  },

  inputLocked: {
    backgroundColor: '#F8FAFC',
    color: '#94A3B8',
  },

  row: { flexDirection: 'row' },

  // Name fallback hint
  nameFallbackHint: {
    marginTop: 4,
    fontSize: 11,
    color: '#94A3B8',
  },
  nameFallbackValue: {
    color: '#2563EB',
    fontWeight: '600',
  },

  // Select box
  selectBox: {
    borderWidth: 1.5,
    borderColor: '#93C5FD',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectBoxOpen: {
    borderColor: '#2563EB',
  },
  selectText: {
    fontSize: 14,
    color: '#0F172A',
    fontWeight: '600',
    flex: 1,
  },
  selectPlaceholder: {
    color: '#94A3B8',
    fontWeight: '400',
  },
  chevron: {
    fontSize: 16,
    color: '#64748B',
    marginLeft: 12,
  },

  // Error
  errorBox: {
    marginTop: 12,
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#DC2626',
  },
  errorText: {
    color: '#DC2626',
    fontSize: 13,
  },

  footer: {
    flexDirection: 'row',
    marginTop: 20,
  },

  cancelBtn: {
    flex: 1,
    padding: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    alignItems: 'center',
    marginRight: 10,
    backgroundColor: '#FFFFFF',
  },
  cancelText: {
    color: '#475569',
    fontWeight: '600',
    fontSize: 14,
  },

  addBtn: {
    flex: 2,
    padding: 13,
    borderRadius: 8,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },

  hint: {
    marginTop: 12,
    fontSize: 12,
    color: '#64748B',
    lineHeight: 18,
  },

  // Dropdown
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  dropdown: {
    position: 'absolute',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.10,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dropdownItemActive: {
    backgroundColor: '#EFF6FF',
  },
  dropdownItemPressed: {
    backgroundColor: '#E8F0FF',
  },
  dropdownText: {
    fontSize: 14,
    color: '#334155',
    fontWeight: '600',
  },
  dropdownTextActive: {
    color: '#2563EB',
  },
  dropdownCheck: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '700',
  },
});