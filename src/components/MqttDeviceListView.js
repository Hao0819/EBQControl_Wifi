// src/components/DeviceListView.js
import React, { memo, useCallback, useRef, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList } from 'react-native';

const IDS_1P = Array.from({ length: 120 }, (_, i) => i + 1);

const ListItem = memo(({ item, connectionStatus, onToggle, onSelect }) => {
  const isActive = String(connectionStatus || '').toLowerCase() === 'connected';
  const statusUpper = String(item?.status || 'UNKNOWN').toUpperCase();
  const isUnknown = statusUpper === 'UNKNOWN';
  const isPoweredOn = statusUpper === 'ON';

  const statusColor = {
    ON: '#10B981',
    OFF: '#EF4444',
    SELECT: '#3B82F6',
    OVER: '#F59E0B',
    UNKNOWN: '#94A3B8',
  }[statusUpper] || '#94A3B8';

  return (
<View style={[styles.listItem, isUnknown && styles.disabledItem]}>
  {/* Left area: click to open config */}
  <TouchableOpacity
    style={styles.leftPressArea}
    onPress={() => !isUnknown && onSelect?.(item.id)}
    disabled={isUnknown}
    activeOpacity={0.85}
    delayPressIn={0}
  >
    <View style={styles.statusBadgeContainer}>
      <View style={[styles.statusBadge, { backgroundColor: statusColor }]} />
      <Text style={styles.tagId}> {item.id}</Text>
    </View>

    <Text style={styles.tagName} numberOfLines={1} ellipsizeMode="tail">
      {String(item?.tagName || '').trim() || `Device ${item?.id}`}
    </Text>
  </TouchableOpacity>

  {/* Right area: current + ON/OFF */}
  <View style={styles.rightContainer}>
    <View style={styles.currentContainer}>
      <Text style={styles.currentText}>{item?.current ?? '-'}</Text>
      <Text style={styles.currentUnit}>A</Text>
    </View>

    <View style={styles.buttonGroup}>
      {/* ON */}
      <TouchableOpacity
        style={[
          styles.actionButton,
          isPoweredOn && styles.activeOnButton,
          (!isActive || isUnknown) && styles.disabledButton,
        ]}
        onPressIn={() => onToggle?.(item.id, 'ON')}
        delayPressIn={0}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        disabled={!isActive || isPoweredOn || isUnknown}
        activeOpacity={0.85}
      >
        <Text style={[styles.buttonText, isPoweredOn ? styles.activeButtonText : styles.inactiveButtonText]}>
          ON
        </Text>
      </TouchableOpacity>

      {/* OFF */}
      <TouchableOpacity
        style={[
          styles.actionButton,
          !isPoweredOn && styles.activeOffButton,
          (!isActive || isUnknown) && styles.disabledButton,
        ]}
        onPressIn={() => onToggle?.(item.id, 'OFF')}
        delayPressIn={0}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        onStartShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        disabled={!isActive || !isPoweredOn || isUnknown}
        activeOpacity={0.85}
      >
        <Text style={[styles.buttonText, !isPoweredOn ? styles.activeButtonText : styles.inactiveButtonText]}>
          OFF
        </Text>
      </TouchableOpacity>
    </View>
  </View>
</View>
  );
});

const DeviceListView = memo(({ tags = {}, connectionStatus, onToggle, onSelect }) => {
  // ✅ 让 renderItem 不因为 tags 更新而变新函数
  const tagsRef = useRef(tags);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

  const renderItem = useCallback(
    ({ item: id }) => {
      const it = tagsRef.current?.[id] || { id, status: 'UNKNOWN', current: '-', seen: false, tagName: `Device ${id}` };
      return (
        <ListItem
          item={it}
          onToggle={onToggle}
          onSelect={onSelect}
          connectionStatus={connectionStatus}
        />
      );
    },
    [onToggle, onSelect, connectionStatus]
  );

  const getItemLayout = useCallback((_, index) => {
    const rowH = 80;
    return { length: rowH, offset: rowH * index, index };
  }, []);

  return (
    <FlatList
      data={IDS_1P}
      renderItem={renderItem}
      keyExtractor={(id) => `tag-${id}`}
      getItemLayout={getItemLayout}
      initialNumToRender={15}
      maxToRenderPerBatch={20}
      windowSize={9}
      removeClippedSubviews
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingTop: 6, paddingBottom: 12 }}
    />
  );
});

const styles = StyleSheet.create({
  leftPressArea: {
  flexDirection: 'row',
  alignItems: 'center',
  flex: 1,
  minWidth: 0,
},

  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
    elevation: 2,
  },
  statusBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
    minWidth: 40,
  },
  statusBadge: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  tagId: { fontSize: 16, fontWeight: '600', color: '#1E293B', width: 40 },
  tagName: { flex: 1, fontSize: 18, color: '#64748B', marginRight: 16 },
  rightContainer: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  currentContainer: { flexDirection: 'row', alignItems: 'baseline' },
  currentText: { fontSize: 18, fontWeight: '600', color: '#1E293B', marginRight: 4 },
  currentUnit: { fontSize: 12, color: '#64748B' },
  buttonGroup: { flexDirection: 'row', gap: 2 },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#E2E8F0',
    width: 50,
    alignItems: 'center',
  },
  activeOnButton: { backgroundColor: '#10B981' },
  activeOffButton: { backgroundColor: '#EF4444' },
  disabledButton: { opacity: 0.5 },
  buttonText: { fontSize: 12, fontWeight: '600' },
  activeButtonText: { color: '#FFFFFF' },
  inactiveButtonText: { color: '#64748B' },
  disabledItem: { backgroundColor: '#F8FAFC', opacity: 0.6 },
});

export default DeviceListView;
