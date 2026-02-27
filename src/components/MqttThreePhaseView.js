import React, { memo, useCallback, useRef, useEffect } from 'react';
import { TouchableOpacity, FlatList, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from 'react-native-vector-icons/MaterialIcons';

const IDS_3P = Array.from({ length: 24 }, (_, i) => 201 + i);

const ThreePhaseItem = memo(({ item, onToggle, onSelect }) => {
  const statusUpper = String(item?.status || 'UNKNOWN').toUpperCase();
  const isUnknown = (!item?.seen) || statusUpper === 'UNKNOWN';

  const statusColor = ({
    ON: '#10B981',
    OFF: '#EF4444',
    SELECT: '#3B82F6',
    OVER: '#F59E0B',
    UNKNOWN: '#94A3B8',
  }[statusUpper]) || '#94A3B8';

  return (
    <TouchableOpacity
      style={[styles.container, isUnknown && styles.disabledItem]}
      onPress={() => !isUnknown && onSelect?.(item.id)}
      disabled={isUnknown}
      activeOpacity={0.85}
    >
      <View style={styles.header}>
        <View style={styles.statusContainer}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.tagId, isUnknown && styles.disabledText]}>
            {item.id}  {item.tagName || `Device ${item.id}`}
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.powerButton,
            statusUpper === 'ON' && styles.powerButtonActive,
            isUnknown && styles.disabledButton,
          ]}
          onPress={() => onToggle?.(item.id, statusUpper === 'ON' ? 'OFF' : 'ON')}
          disabled={isUnknown}
          activeOpacity={0.85}
        >
          <MaterialIcons
            name="power-settings-new"
            size={24}
            color={statusUpper === 'ON' ? '#FFFFFF' : '#64748B'}
          />
        </TouchableOpacity>
      </View>

      <View style={styles.currentsContainer}>
        <View style={styles.phase}>
          <Text style={[styles.currentValue, isUnknown && styles.disabledText]}>{item.current1 ?? '-'}</Text>
          <Text style={styles.currentUnit}>A</Text>
        </View>
        <View style={styles.phase}>
          <Text style={[styles.currentValue, isUnknown && styles.disabledText]}>{item.current2 ?? '-'}</Text>
          <Text style={styles.currentUnit}>A</Text>
        </View>
        <View style={styles.phase}>
          <Text style={[styles.currentValue, isUnknown && styles.disabledText]}>{item.current3 ?? '-'}</Text>
          <Text style={styles.currentUnit}>A</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}, (p, n) =>
  p.item?.status === n.item?.status &&
  p.item?.seen === n.item?.seen &&
  p.item?.tagName === n.item?.tagName &&
  p.item?.current1 === n.item?.current1 &&
  p.item?.current2 === n.item?.current2 &&
  p.item?.current3 === n.item?.current3
);

const ThreePhaseView = memo(({ tags = {}, onToggle, onSelect }) => {
  const tagsRef = useRef(tags);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

  const renderItem = useCallback(({ item: id }) => {
    const it = tagsRef.current?.[id] || {
      id,
      status: 'UNKNOWN',
      seen: false,
      tagName: `Device ${id}`,
      current1: '-',
      current2: '-',
      current3: '-',
    };
    return <ThreePhaseItem item={it} onToggle={onToggle} onSelect={onSelect} />;
  }, [onToggle, onSelect]);

  const getItemLayout = useCallback((_, index) => {
    const rowH = 110;
    return { length: rowH, offset: rowH * index, index };
  }, []);

  return (
    <FlatList
      data={IDS_3P}
      renderItem={renderItem}
      keyExtractor={(id) => `three-phase-${id}`}
      getItemLayout={getItemLayout}
      extraData={tags}
      contentContainerStyle={styles.listContainer}
      removeClippedSubviews
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={7}
      showsVerticalScrollIndicator={false}
    />
  );
});

const styles = StyleSheet.create({
  listContainer: { padding: 16 },
  container: {
    backgroundColor: 'white',
    borderRadius: 8,
    padding: 16,
    marginBottom: 8,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusContainer: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  tagId: { fontSize: 16, fontWeight: '600', color: '#1E293B' },
  currentsContainer: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 8 },
  phase: { alignItems: 'center', flex: 1 },
  currentValue: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginRight: 4 },
  currentUnit: { fontSize: 12, color: '#64748B', marginTop: 2 },
  powerButton: { padding: 8, borderRadius: 20, backgroundColor: '#E2E8F0' },
  powerButtonActive: { backgroundColor: '#10B981' },
  disabledItem: { backgroundColor: '#F8FAFC', opacity: 0.6 },
  disabledText: { color: '#94A3B8' },
  disabledButton: { backgroundColor: '#E2E8F0', opacity: 0.5 },
});

export default ThreePhaseView;
