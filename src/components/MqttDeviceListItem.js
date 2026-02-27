// src/components/MqttDeviceListItem.js
import React from 'react';
import { View, Text, Pressable, StyleSheet, Image } from 'react-native';

const ICON = require('../assets/images/circuitbreaker.png');

export default function MqttDeviceListItem({ device, onPress, onLongPress, online=false, connecting=false }) {
  const name = device?.friendlyName || device?.name || 'MQTT Device';
  const id = device?.deviceId || device?.id || '';

  let badgeText = 'OFFLINE';
  let badgeStyle = styles.badgeOff;
  if (connecting) { badgeText = 'CONNECTING'; badgeStyle = styles.badgeConn; }
  else if (online) { badgeText = 'ONLINE'; badgeStyle = styles.badgeOn; }

  return (
    
    <Pressable
  style={({ pressed }) => [styles.card, pressed && styles.pressed]}
  onPress={onPress}
  onLongPress={onLongPress}
  delayLongPress={350}
  android_disableSound
  hitSlop={8}
>
  <Image source={ICON} style={styles.icon} resizeMode="contain" />

  <View style={styles.mid}>
    <Text style={styles.name} numberOfLines={1}>{name}</Text>
    {!!id && <Text style={styles.sub} numberOfLines={1}>{id}</Text>}
  </View>

  <View style={styles.right}>
    <Text style={styles.chev}>›</Text>
  </View>
</Pressable>

  );
}

const styles = StyleSheet.create({
  card: {
    pressed: { opacity: 0.85 },
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  icon: { width: 34, height: 34, marginRight: 12 },
  mid: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '700', color: '#0F172A' },
  sub: { marginTop: 4, fontSize: 12, color: '#64748B' },

  right: { flexDirection: 'row', alignItems: 'center' },
  badge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, marginRight: 10 },
  badgeText: { fontSize: 12, color: '#fff', fontWeight: '700' },
  badgeOn: { backgroundColor: '#22C55E' },
  badgeOff: { backgroundColor: '#94A3B8' },
  badgeConn: { backgroundColor: '#F59E0B' },
  chev: { fontSize: 22, color: '#94A3B8' },
});
