// src/screens/MqttDeviceListScreen.js
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { View, StyleSheet, FlatList, TouchableOpacity, Text, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

import MqttDeviceListItem from '../components/MqttDeviceListItem';
import { loadMqttDevices, removeMqttDevice, clearMqttDevices } from '../utils/MqttDeviceStorage';

import * as MqttManager from '../utils/MqttManager';

// Route name must match App.tsx: <Stack.Screen name="MqttDeviceDetail" ... />
const DETAIL_ROUTE = 'MqttDeviceDetail';

export default function MqttDeviceListScreen({ navigation }) {
  const [devices, setDevices] = useState([]);
  const [mqttState, setMqttState] = useState(MqttManager.getMqttState?.() ?? {
  deviceId: null, connected: false, connecting: false, status: 'IDLE', error: ''
});


  // Subscribe to global MQTT state so the list can show ONLINE/OFFLINE/CONNECTING
 useEffect(() => {
  return MqttManager.subscribeMqttState?.((next) => {
    setMqttState((prev) => {
      const same =
        String(prev?.deviceId ?? '') === String(next?.deviceId ?? '') &&
        !!prev?.connected === !!next?.connected &&
        !!prev?.connecting === !!next?.connecting &&
        String(prev?.status ?? '') === String(next?.status ?? '') &&
        String(prev?.error ?? '') === String(next?.error ?? '');

      // ✅ 如果没变化，就不更新 state（避免疯狂 rerender）
      return same ? prev : next;
    });
  });
}, []);

  // Refresh device list from storage (AsyncStorage)
  const refresh = useCallback(async () => {
    try {
      const list = await loadMqttDevices();
      setDevices(Array.isArray(list) ? list : []);
    } catch (e) {
      console.log('loadMqttDevices error:', e);
      setDevices([]);
    }
  }, []);

  // Auto refresh every time this screen is focused
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  useLayoutEffect(() => {
  navigation.setOptions({
    title: 'EBQ Control',
    headerRight: () => (
      <TouchableOpacity
        onPress={() => {
          Alert.alert(
            'Clear MQTT Devices',
            'Remove ALL saved MQTT devices?',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  await clearMqttDevices();
                  setDevices([]);   // 立即更新 UI
                },
              },
            ]
          );
        }}
        style={{ paddingHorizontal: 14 }}
      >
        {/* 用 delete 图标，而不是 refresh */}
        <MaterialIcons name="delete" size={22} color="#DC2626" />
      </TouchableOpacity>
    ),
  });
}, [navigation]);


  // Navigate to AddMqttDevice screen
  const goAdd = () => navigation.navigate('AddMqttDevice');

  // When user taps a device:
  // 1) connect to broker using that saved device config
  // 2) navigate to Device Detail page (connection status UI)
  // Navigate first (do NOT await connect here)
// Tap a row -> go to detail immediately
const onPressItem = (item) => {
  console.log('[MQTT-LIST] tap', item?.deviceId, item?.host, item?.port);
  requestAnimationFrame(() => {
    navigation.navigate('MqttDeviceDetail', { device: item });
  });
};


useEffect(() => {
  console.log('[MQTT-LIST] mounted');
}, []);


  return (
    <View style={styles.page}>
      <FlatList
        contentContainerStyle={styles.listPad}
        data={devices}
        keyExtractor={(item, idx) => String(item?.deviceId ?? item?.id ?? idx)}
        renderItem={({ item }) => {
          const id = String(item?.deviceId ?? item?.id ?? '');
          const isCurrent = mqttState.deviceId === id;

          const online = isCurrent && mqttState.connected;
          const connecting = isCurrent && mqttState.connecting;

          return (
            <MqttDeviceListItem
  device={item}
  online={online}
  connecting={connecting}
  onPress={() => onPressItem(item)}
  onLongPress={() => {
    const name = item?.friendlyName || item?.name || item?.deviceId || 'Device';
    Alert.alert(
      'Delete device?',
      `Remove "${name}" from saved list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const next = await removeMqttDevice(item?.deviceId);
              setDevices(next); // ✅ 立即更新 UI
            } catch (e) {
              Alert.alert('Delete failed', e?.message || String(e));
            }
          },
        },
      ]
    );
  }}
/>

          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No MQTT device</Text>
            <Text style={styles.emptySub}>Tap + to add device</Text>
          </View>
        }
      />

      {/* Floating Add button */}
      <TouchableOpacity style={styles.fab} onPress={goAdd} activeOpacity={0.9}>
        <Text style={styles.fabText}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F1F5F9' },
  listPad: { padding: 12 },

  empty: { paddingTop: 80, alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#0F172A' },
  emptySub: { marginTop: 6, fontSize: 12, color: '#64748B' },

  fab: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: '#10B981',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 10,
  },
  fabText: { color: '#fff', fontSize: 30, marginTop: -2 },
});