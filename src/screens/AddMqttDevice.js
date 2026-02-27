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

  // ===== Dropdown (custom) =====
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

  // Start empty until user selects a preset
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [deviceId, setDeviceId] = useState('');

  // ===== UI state =====
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // "Select server" => clear all server fields
    if (presetKey === 'select') {
      setHost('');
      setPort('');
      setUsername('');
      setPassword('');
      return;
    }

    // "Custom" => clear all server fields (user will type manually)
    if (presetKey === 'custom') {
      setHost('');
      setPort('');
      setUsername('');
      setPassword('');
      return;
    }

    // Preset server => auto fill and lock
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

  const validate = () => {
    if (presetKey === 'select') return 'Please select server';
    if (!friendlyName.trim()) return 'Device Friendly Name required';
    if (!host.trim()) return 'MQTT Broker Host required';
    if (!parsedPort || parsedPort <= 0 || parsedPort > 65535) return 'Port invalid';
    if (!normalizedDeviceId) return 'Device ID required';
    return '';
  };

  const onAdd = async () => {
    if (busy) return;

    setError('');
    const v = validate();
    if (v) {
      setError(v);
      return;
    }

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
  friendlyName: friendlyName.trim(),
  name: friendlyName.trim(),
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


      // 3) Save only after auth passed
      await addMqttDevice(device);

      // 4) Go detail and auto-connect
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
      setError(e?.message || 'connection failed');
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
          <Text style={styles.sectionTitle}>MQTT DEVICE CONFIG</Text>

          {/* SERVER dropdown (custom UI like picture2) */}
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
              {presetKey === 'select' ? 'Select' : selectedPreset.label}
            </Text>

            {/* Chevron */}
            <Text style={styles.chevron}>{serverOpen ? '˄' : '˅'}</Text>
          </Pressable>


          <Label text="DEVICE FRIENDLY NAME" />
          <Input
            placeholder="e.g. EBQ Controller Main"
            value={friendlyName}
            onChangeText={setFriendlyName}
            editable={!busy}
          />

          <View style={styles.row}>
            <View style={{ flex: 2 }}>
              <Label text="MQTT BROKER HOST" />
              <Input
                value={host}
                onChangeText={setHost}
                editable={!busy && isCustom}
                styleOverride={isSelected && !isCustom ? styles.inputLocked : null}
                placeholder={isCustom ? 'e.g. mybroker.domain.com' : ''}
              />
            </View>

            <View style={{ width: 12 }} />

            <View style={{ flex: 1 }}>
              <Label text="PORT" />
              <Input
                value={String(port)}
                onChangeText={setPort}
                keyboardType="numeric"
                editable={!busy && isCustom}
                styleOverride={isSelected && !isCustom ? styles.inputLocked : null}
                placeholder={isCustom ? 'e.g. 8883' : ''}
              />
            </View>
          </View>

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Label text="USERNAME (OPTIONAL)" />
              <Input
                value={username}
                onChangeText={setUsername}
                editable={!busy && isCustom}
                styleOverride={isSelected && !isCustom ? styles.inputLocked : null}
                placeholder={isCustom ? 'username' : ''}
              />
            </View>

            <View style={{ width: 12 }} />

            <View style={{ flex: 1 }}>
              <Label text="PASSWORD (OPTIONAL)" />
              <Input
                value={password}
                onChangeText={setPassword}
                editable={!busy && isCustom}
                styleOverride={isSelected && !isCustom ? styles.inputLocked : null}
                placeholder={isCustom ? 'password' : ''}
              />
            </View>
          </View>

          <Label text="DEVICE ID (MAC)" />
          <Input
            value={normalizedDeviceId}
            onChangeText={(t) => setDeviceId(String(t || '').toUpperCase())}
            autoCapitalize="characters"
            editable={!busy}
            placeholder="e.g. A208F6C7F"
          />

          {/* Topic UI is intentionally hidden for user friendliness */}

          {!!error && <Text style={styles.error}>{error}</Text>}

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
                  <Text style={[styles.addText, { marginLeft: 10 }]}>Saving...</Text>
                </View>
              ) : (
                <Text style={styles.addText}>Add & Connect</Text>
              )}
            </TouchableOpacity>
          </View>

          {!isSelected && (
            <Text style={styles.hint}>Please select a server first.</Text>
          )}
          {isPresetServer && (
            <Text style={styles.hint}>Server details are auto-filled. Only Device ID is required.</Text>
          )}
        </View>
      </ScrollView>

      {/* Dropdown Menu */}
      <Modal
        transparent
        visible={serverOpen}
        animationType="fade"
        onRequestClose={() => setServerOpen(false)}
      >
        {/* Click outside to close */}
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
                onPress={() => {
                  setPresetKey(p.key);
                  setServerOpen(false);
                }}
                style={({ pressed }) => [
                  styles.dropdownItem,
                  pressed ? styles.dropdownItemPressed : null,
                ]}
              >
                <Text style={styles.dropdownText}>{p.label}</Text>
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

function Input({ styleOverride, ...props }) {
  return (
    <TextInput
      {...props}
      style={[styles.input, styleOverride]}
      placeholderTextColor="#94A3B8"
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },

  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
  },

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    marginBottom: 10,
    letterSpacing: 0.4,
  },

  label: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 12,
    marginBottom: 4,
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
    backgroundColor: '#F9FAFB',
    color: '#64748B',
  },

  row: { flexDirection: 'row' },

 // Modern select (like your last screenshot)
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
  borderColor: '#60A5FA',
},
selectText: {
  fontSize: 14,
  color: '#0F172A',
  fontWeight: '600',
  flex: 1,
},
selectPlaceholder: {
  color: '#64748B',
  fontWeight: '600',
},
chevron: {
  fontSize: 16,
  color: '#64748B',
  marginLeft: 12,
  marginTop: -1,
},

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
},

dropdownItemSelected: {
  backgroundColor: '#F1F5F9',
},

dropdownItemPressed: {
  backgroundColor: '#E8F0FF',
},

dropdownText: {
  fontSize: 14,
  color: '#334155',
  fontWeight: '600',
},



  error: {
    color: '#DC2626',
    marginTop: 10,
    fontSize: 12,
  },

  footer: {
    flexDirection: 'row',
    marginTop: 18,
  },

  cancelBtn: {
    flex: 1,
    padding: 12,
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
  },

  addBtn: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },

  addText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },

  hint: {
    marginTop: 12,
    fontSize: 12,
    color: '#64748B',
  },
});
