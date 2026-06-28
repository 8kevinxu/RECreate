// Nearby courts, ranked by distance, with a min-open-time filter so you don't
// trek to a gym that's about to close. Courts come in pre-filtered by the app's
// Open/time controls and annotated with distanceMi + remaining (minutes left).
import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { formatDistance } from '../lib/distance';
import { fmtDuration } from '../lib/datetime';
import { isFullyBooked } from '../lib/reservations';

const MIN_OPTIONS = [
  { label: 'Any', value: 0 },
  { label: '30m+', value: 30 },
  { label: '1h+', value: 60 },
];
const CLOSING_SOON = 30; // minutes — highlight courts closing within this

export default function NearbyList({
  visible,
  courts,
  sport = 'basketball',
  hasLocation,
  onSelect,
  onRequestLocation,
  onClose,
}) {
  const [minOpen, setMinOpen] = useState(0);

  const rows = useMemo(() => {
    const filtered = courts.filter((c) => (minOpen ? c.remaining >= minOpen : true));
    return filtered.sort((a, b) => {
      if (a.dropin.open !== b.dropin.open) return a.dropin.open ? -1 : 1; // open first
      if (hasLocation) return (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9);
      return 0;
    });
  }, [courts, minOpen, hasLocation]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>Nearby courts</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          {!hasLocation && (
            <Pressable style={styles.enableLoc} onPress={onRequestLocation}>
              <Text style={styles.enableLocText}>
                📍 Enable location to sort by distance
              </Text>
            </Pressable>
          )}

          <View style={styles.filterRow}>
            <Text style={styles.filterLabel}>Open for</Text>
            {MIN_OPTIONS.map((o) => {
              const active = minOpen === o.value;
              return (
                <Pressable
                  key={o.value}
                  onPress={() => setMinOpen(o.value)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <ScrollView style={styles.list}>
            {rows.length === 0 ? (
              <Text style={styles.muted}>No courts match — try a smaller "open for".</Text>
            ) : (
              rows.map((c) => {
                const full = isFullyBooked(c.reserved?.[sport]);
                return (
                <Pressable key={c.id} style={styles.row} onPress={() => onSelect(c.id)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>
                      {c.name}
                      {full && <Text style={styles.fullTag}>  🔴 Fully booked</Text>}
                    </Text>
                    <Text style={styles.sub}>
                      {[
                        c.indoor === false ? 'Outdoor' : 'Indoor',
                        c.neighborhood,
                        hasLocation && formatDistance(c.distanceMi),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <View style={styles.statusCol}>
                    {c.dropin.open ? (
                      <Text
                        style={[
                          styles.open,
                          c.remaining > 0 && c.remaining <= CLOSING_SOON && styles.closingSoon,
                        ]}
                      >
                        {c.remaining > 0
                          ? `${c.remaining <= CLOSING_SOON ? 'closing · ' : 'open · '}${fmtDuration(
                              c.remaining
                            )} left`
                          : 'open'}
                      </Text>
                    ) : (
                      <Text style={styles.closed}>{c.dropin.label}</Text>
                    )}
                  </View>
                </Pressable>
                );
              })
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 24,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },

  enableLoc: {
    backgroundColor: '#e3eefb',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  enableLocText: { color: '#2f74d6', fontWeight: '700', fontSize: 13, textAlign: 'center' },

  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  filterLabel: { fontSize: 13, color: '#5b6b7b', fontWeight: '700', marginRight: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: '#eef1f4' },
  chipActive: { backgroundColor: '#2f74d6' },
  chipText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  chipTextActive: { color: '#fff' },

  list: { marginTop: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  name: { fontSize: 15, color: '#0d1b2a', fontWeight: '700' },
  fullTag: { fontSize: 12, color: '#c0392b', fontWeight: '700' },
  sub: { fontSize: 12, color: '#7a8a9a', marginTop: 1 },
  statusCol: { alignItems: 'flex-end', paddingLeft: 10 },
  open: { fontSize: 13, color: '#1f9d55', fontWeight: '700' },
  closingSoon: { color: '#d9531e' },
  closed: { fontSize: 12, color: '#9aa7b4', fontWeight: '600', maxWidth: 130, textAlign: 'right' },
  muted: { fontSize: 13, color: '#9aa7b4', fontStyle: 'italic', paddingVertical: 12 },
});
