import AsyncStorage from '@react-native-async-storage/async-storage';

// ✅ Storage key for MQTT devices list
const KEY = 'MQTT_DEVICES_V1';

/**
 * Load MQTT device list from AsyncStorage
 */
export async function loadMqttDevices() {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Save MQTT device list to AsyncStorage
 */
export async function saveMqttDevices(list) {
  await AsyncStorage.setItem(KEY, JSON.stringify(list || []));
}

/**
 * Add/Update one MQTT device (use deviceId as unique key)
 * - If deviceId already exists, it will be replaced.
 * - New device is inserted at the top.
 */
export async function addMqttDevice(device) {
  const list = await loadMqttDevices();
  const next = [device, ...list.filter(d => String(d.deviceId) !== String(device.deviceId))];
  await saveMqttDevices(next);
  return next;
}

export async function clearMqttDevices() {
  await AsyncStorage.removeItem('MQTT_DEVICES_V1');
  return [];
}

export async function removeMqttDevice(deviceId) {
  const list = await loadMqttDevices();
  const next = list.filter(d => String(d.deviceId) !== String(deviceId));
  await saveMqttDevices(next);
  return next;
}
