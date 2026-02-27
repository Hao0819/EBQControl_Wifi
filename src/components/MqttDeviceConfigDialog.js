import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, StyleSheet, Alert, Platform } from 'react-native';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

function sanitizeDecimalInput(text) {
  let t = String(text ?? '').replace(/,/g, '.').replace(/[^\d.]/g, '');
  const parts = t.split('.');
  if (parts.length > 2) t = parts[0] + '.' + parts.slice(1).join('');
  return t;
}

export default function MqttDeviceConfigDialog({ visible, onClose, item, onSaveName, onSaveCurrent }) {
  const [tagName, setTagName] = useState('');
  const [currentRating, setCurrentRating] = useState('');
  const [sensitivity, setSensitivity] = useState(1);

  // Initialize form only once when opened; stop syncing once user starts editing
  const didInitRef = useRef(false);
  const dirtyRef = useRef(false);

  // Store original values for diff
  const origRef = useRef({ name: '', cur: 0, sens: 1 });

  useEffect(() => {
    if (!visible) {
      didInitRef.current = false;
      dirtyRef.current = false;
      return;
    }
    if (!item) return;

    if (didInitRef.current) return;
    didInitRef.current = true;

    const initName = String(item.tagName || `Device ${item.id}`);
    setTagName(initName);

    const cr = Number(item.currentRating);
    const initCur = Number.isFinite(cr) ? Number(cr.toFixed(2)) : 0;
    setCurrentRating(Number(initCur).toFixed(2));

    const s = Number(item.sensitivity);
    const initSens = [1, 2, 3, 4].includes(s) ? s : 1;
    setSensitivity(initSens);

    origRef.current = { name: initName, cur: initCur, sens: initSens };
  }, [visible, item?.id]);

  const nameTrimmed = useMemo(() => String(tagName || '').trim(), [tagName]);

  const parsedCurrent = useMemo(() => {
    const n = parseFloat(String(currentRating).replace(/,/g, '.'));
    return Number.isFinite(n) ? n : NaN;
  }, [currentRating]);

  const didChangeName = useMemo(() => {
    return nameTrimmed !== String(origRef.current.name || '');
  }, [nameTrimmed, visible, item?.id]);

  const didChangeCurrent = useMemo(() => {
    const nowCur = Number.isFinite(parsedCurrent) ? Number(parsedCurrent.toFixed(2)) : NaN;
    const origCur = Number(origRef.current.cur);
    const origSens = Number(origRef.current.sens);
    if (!Number.isFinite(nowCur)) return false;
    return nowCur !== origCur || Number(sensitivity) !== origSens;
  }, [parsedCurrent, sensitivity, visible, item?.id]);

  const buildConfirmMessage = useCallback(() => {
  const parts = [];

  if (didChangeName) {
    parts.push(`Confirm update device name to "${nameTrimmed}"?`);
  }

  if (didChangeCurrent) {
    const newCur = clamp(Number(parsedCurrent), 0, 40);
    parts.push(`Confirm update maximum current rating to ${newCur.toFixed(1)}A?\nSensitivity Level: ${sensitivity}`);
  }

  return parts.join('\n\n');
}, [didChangeName, didChangeCurrent, nameTrimmed, parsedCurrent, sensitivity]);

  const handleUpdate = () => {
    if (!item) return;

    // No changes -> just close
    if (!didChangeName && !didChangeCurrent) {
      onClose?.();
      return;
    }

    // Validate name only if changed
    if (didChangeName) {
      if (!nameTrimmed) {
        Alert.alert('Error', 'Device Name cannot be empty');
        return;
      }
      if (nameTrimmed.length > 24) {
        Alert.alert('Error', 'Tag Name cannot exceed 24 characters');
        return;
      }
    }

    // Validate current only if changed
    if (didChangeCurrent) {
      if (!Number.isFinite(parsedCurrent) || parsedCurrent < 0 || parsedCurrent > 40.0) {
        Alert.alert('Error', 'Please enter a valid current rating (0-40A)');
        return;
      }
    }

    Alert.alert(
      'Confirm Update',
      buildConfirmMessage(),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => {
            // Only call what actually changed
            if (didChangeName) {
              onSaveName?.(item.id, nameTrimmed);
            }
            if (didChangeCurrent) {
              const val = clamp(Number(parsedCurrent), 0, 40);
              onSaveCurrent?.(item.id, val, sensitivity);
            }
            onClose?.();
          },
        },
      ]
    );
  };
  const canUpdate = didChangeName || didChangeCurrent;


  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.configDialog}>
          <Text style={styles.dialogTitle}>Configure EBQ {item?.id}</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Device Name</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter device name"
              value={tagName}
              onChangeText={(t) => {
                dirtyRef.current = true;
                setTagName(t);
              }}
              maxLength={24}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Current Rating (A)</Text>
            <TextInput
              style={styles.input}
              placeholder="0.0 - 40.0"
              keyboardType={Platform.OS === 'ios' ? 'decimal-pad' : 'numeric'}
              value={currentRating}
              onChangeText={(t) => {
                dirtyRef.current = true;
                setCurrentRating(sanitizeDecimalInput(t));
              }}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Sensitivity Level</Text>
            <View style={styles.sensitivityContainer}>
              {[1, 2, 3, 4].map((level) => (
                <TouchableOpacity
                  key={level}
                  style={[styles.sensitivityButton, sensitivity === level && styles.activeSensitivity]}
                  onPress={() => {
                    dirtyRef.current = true;
                    setSensitivity(level);
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.sensitivityText, sensitivity === level && styles.activeSensitivityText]}>
                    {level}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.buttonRow}>
            <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={onClose} activeOpacity={0.85}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
  style={[styles.button, styles.saveButton, !canUpdate && styles.disabledButton]}
  onPress={handleUpdate}
  activeOpacity={0.85}
  disabled={!canUpdate}
>
  <Text style={[styles.saveText, !canUpdate && styles.disabledButtonText]}>Update</Text>
</TouchableOpacity>

          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.30)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  configDialog: {
    backgroundColor: 'white',
    padding: 24,
    borderRadius: 12,
    width: '85%',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 20,
    textAlign: 'center',
  },
  inputGroup: { marginBottom: 16 },
  inputLabel: {
    fontSize: 14,
    color: '#64748B',
    marginBottom: 8,
    fontWeight: '500',
  },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: '#1E293B',
  },
  sensitivityContainer: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  sensitivityButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
  },
  sensitivityText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748B',
  },
  activeSensitivity: { backgroundColor: '#2196F3' },
  activeSensitivityText: { color: '#FFFFFF' },

  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  button: {
    flex: 1,
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: { backgroundColor: '#F1F5F9' },
  saveButton: { backgroundColor: '#2196F3' },
  cancelText: { fontSize: 14, fontWeight: '600', color: '#64748B' },
  saveText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF', textAlign: 'center' },
  disabledButton: { backgroundColor: '#CBD5E1' },
disabledButtonText: { color: '#F8FAFC' },

});