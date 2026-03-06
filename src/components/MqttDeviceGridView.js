// src/components/MqttDeviceGridView.js

import React, { memo, useMemo, useCallback, useRef } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, Text, View } from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

const IDS_1P = Array.from({ length: 120 }, (_, i) => i + 1);

const MIN_COLUMNS = 3;
const MAX_COLUMNS = 10;

const GRID_BG = '#eff2f6';
const GRID_PADDING_H = 0;
const ITEM_MARGIN = 2;
const MIN_ITEM_SIZE = 68;
const TILE_RATIO = 1.0;

const GridItem = memo(
  ({
    item,
    onToggle,
    onSelect,
    connectionStatus,
    itemSize,
    itemHeight,
  }) => {
    const isActive = String(connectionStatus || '').toLowerCase() === 'connected';

    // ✅ 直接用 tags 状态，不再有 localOverride
    const effectiveStatus = String(item?.status || 'UNKNOWN').toUpperCase();

    const isDim = !item?.seen;
    const isUnknown = effectiveStatus === 'UNKNOWN';
    const isDisabled = isDim || isUnknown;

    const operationalStatus =
      isUnknown ? 'UNKNOWN'
        : effectiveStatus === 'ON' ? 'ON'
          : effectiveStatus === 'OFF' ? 'OFF'
            : effectiveStatus === 'SELECT' ? 'SELECT'
              : 'UNKNOWN';

    const isPoweredOn = operationalStatus === 'ON';

    const badgeColor = isDisabled ? '#94A3B8' : (isPoweredOn ? '#10B981' : '#EF4444');
    const powerColor = isPoweredOn ? '#10B981' : '#EF4444';
    const currentText = isDisabled ? '-' : (item?.current ?? '-');

    return (
      <TouchableOpacity
        style={[
          styles.gridItem,
          { width: itemSize, height: itemHeight },
          isDisabled && styles.disabledGridItem,
          operationalStatus === 'SELECT' && styles.selectedBackground,
        ]}
        onPress={() => !isDisabled && onSelect?.(item.id)}
        disabled={isDisabled}
        activeOpacity={0.85}
      >
        {/* Top row: ID + dot (left), power button (right) */}
        <View style={styles.topContainer}>
          <View style={styles.idBadgeContainer}>
            <Text style={[styles.tagId, isDisabled && styles.disabledText]}>{item.id}</Text>
            <View style={[styles.statusBadge, { backgroundColor: badgeColor }]} />
          </View>

          <TouchableOpacity
            style={[styles.powerButton, (!isActive || isDisabled) && styles.disabledButton]}
            onPress={() => {
              if (!isActive || isDisabled) return;
              const next = isPoweredOn ? 'OFF' : 'ON';
              onToggle?.(item.id, next);
            }}
            disabled={!isActive || isDisabled}
            activeOpacity={0.85}
          >
            <MaterialIcons name="power-settings-new" size={20} color={powerColor} />
          </TouchableOpacity>
        </View>

        {/* Current row */}
        <View style={styles.currentContainer}>
          <Text style={[styles.currentText, isDisabled && styles.disabledText]} numberOfLines={1}>
            {currentText}
          </Text>
          <View style={styles.unitContainer}>
            <Text style={[styles.currentUnit, isDisabled && styles.disabledText]}>A</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  },
  (prev, next) =>
    prev.item?.status === next.item?.status &&
    prev.item?.current === next.item?.current &&
    prev.item?.seen === next.item?.seen &&
    prev.connectionStatus === next.connectionStatus &&
    prev.itemSize === next.itemSize &&
    prev.itemHeight === next.itemHeight
);

const DeviceGridView = memo(({ tags, onToggle, onSelect, connectionStatus, numColumns, layoutWidth }) => {
  const baseWidth = Number(layoutWidth) > 0 ? Number(layoutWidth) : 0;
  if (baseWidth <= 0) return <View style={{ flex: 1, backgroundColor: GRID_BG }} />;

  const contentWidth = useMemo(
    () => Math.max(0, baseWidth - GRID_PADDING_H * 2),
    [baseWidth]
  );

  const columns = useMemo(() => {
    if (Number.isFinite(numColumns) && numColumns > 0) {
      return Math.max(1, Math.floor(numColumns));
    }
    const outerMin = MIN_ITEM_SIZE + ITEM_MARGIN * 2;
    const raw = Math.floor(contentWidth / outerMin);
    return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, raw || MIN_COLUMNS));
  }, [numColumns, contentWidth]);

  const itemSize = useMemo(() => {
    const totalMargins = columns * ITEM_MARGIN * 2;
    const size = (contentWidth - totalMargins) / columns;
    return Math.max(1, Math.floor(size));
  }, [contentWidth, columns]);

  const itemHeight = useMemo(() => Math.max(1, Math.round(itemSize * TILE_RATIO)), [itemSize]);

  const listKey = useMemo(() => `grid-${columns}`, [columns]);

  const renderItem = useCallback(
    ({ item: id }) => {
      const it = tags?.[id] || { id, status: 'UNKNOWN', current: '-', seen: false };

      return (
        <GridItem
          item={it}
          onToggle={onToggle}
          onSelect={onSelect}
          connectionStatus={connectionStatus}
          itemSize={itemSize}
          itemHeight={itemHeight}
        />
      );
    },
    [tags, onToggle, onSelect, connectionStatus, itemSize, itemHeight]
  );

  const getItemLayout = useCallback(
    (_data, index) => {
      const row = Math.floor(index / columns);
      const rowH = itemHeight + ITEM_MARGIN * 2;
      return { length: rowH, offset: row * rowH, index };
    },
    [itemHeight, columns]
  );

  return (
    <View style={{ flex: 1, backgroundColor: GRID_BG }}>
      <FlatList
        style={{ backgroundColor: GRID_BG }}
        key={listKey}
        data={IDS_1P}
        renderItem={renderItem}
        keyExtractor={(id) => `grid-${id}`}
        numColumns={columns}
        getItemLayout={getItemLayout}
        initialNumToRender={columns * 8}
        maxToRenderPerBatch={columns * 8}
        windowSize={7}
        updateCellsBatchingPeriod={80}
        removeClippedSubviews
        contentContainerStyle={[
          styles.gridContainer,
          { paddingHorizontal: GRID_PADDING_H, paddingBottom: itemSize * 0.2 },
        ]}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  gridContainer: { paddingTop: 4 },
  gridItem: {
    margin: ITEM_MARGIN,
    padding: 2,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    justifyContent: 'space-between',
    overflow: 'hidden',
    borderColor: '#E5E7EB',
    borderWidth: StyleSheet.hairlineWidth,
  },
  topContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  idBadgeContainer: { flexDirection: 'row', alignItems: 'center' },
  tagId: { fontSize: 14, fontWeight: '600', color: '#1E293B' },
  statusBadge: { width: 6, height: 6, borderRadius: 5, marginLeft: 2 },
  powerButton: { padding: 1, borderRadius: 4, borderWidth: 1, borderColor: '#E2E8F0' },
  disabledButton: { opacity: 0.5, borderColor: '#CBD5E1' },
  currentContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  currentText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1E293B',
    textAlign: 'center',
  },
  unitContainer: {
    position: 'absolute',
    bottom: 4,
    right: 2,
  },
  currentUnit: { fontSize: 12, color: '#64748B', fontWeight: '400' },
  disabledGridItem: { backgroundColor: '#F8FAFC', opacity: 0.7 },
  disabledText: { color: '#94A3B8' },
  selectedBackground: { backgroundColor: '#82CAFF', borderWidth: 1, borderColor: '#90CAF9' },
});

export default DeviceGridView;