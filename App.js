import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import CourtMap from './components/CourtMap';
import { useCourts } from './lib/useCourts';
import {
  getOpenStatus,
  getBasketballStatus,
  getBasketballWeek,
} from './lib/hours';

export default function App() {
  const mapRef = useRef(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(true);
  const [now, setNow] = useState(new Date());

  // Refresh "open now" status every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Ask for location once on mount; fall back silently to the SF-wide view.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUserLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          });
        }
      } catch (e) {
        // Ignore — map still works centered on San Francisco.
      } finally {
        setLocating(false);
      }
    })();
  }, []);

  // Court data: bundled → cached → freshly fetched (see useCourts).
  const { courts: courtData } = useCourts();

  // Annotated with facility status + basketball open-gym status.
  const courts = useMemo(() => {
    return courtData.map((c) => ({
      ...c,
      status: getOpenStatus(c, now),
      bball: getBasketballStatus(c, now),
    }));
  }, [courtData, now]);

  // "Open now" = drop-in basketball is happening right now.
  const visibleCourts = useMemo(() => {
    return courts.filter((c) => !openOnly || c.bball.open);
  }, [courts, openOnly]);

  // Map markers fade when there's no open-gym basketball right now.
  const mapCourts = useMemo(
    () =>
      visibleCourts.map((c) => ({
        id: c.id,
        lat: c.lat,
        lng: c.lng,
        indoor: c.indoor,
        open: c.bball.open,
      })),
    [visibleCourts]
  );

  const selected = useMemo(
    () => courts.find((c) => c.id === selectedId) || null,
    [courts, selectedId]
  );

  const handleSelect = (id) => {
    setSelectedId(id);
    const court = courts.find((c) => c.id === id);
    if (court) mapRef.current?.focusCourt(court);
  };

  const recenter = () => {
    if (userLocation) mapRef.current?.recenter(userLocation);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.title}>🏀 HoopMap SF</Text>
        <Text style={styles.subtitle}>
          {openOnly
            ? `${visibleCourts.length} with open gym right now`
            : `${visibleCourts.length} indoor courts · SF Rec & Parks`}
        </Text>
      </View>

      <View style={styles.filterBar}>
        <Pressable
          onPress={() => setOpenOnly((v) => !v)}
          style={[styles.openToggle, openOnly && styles.openToggleActive]}
        >
          <Text
            style={[
              styles.openToggleText,
              openOnly && styles.openToggleTextActive,
            ]}
          >
            {openOnly ? '✓ Open now' : 'Open now'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.mapWrap}>
        <CourtMap
          ref={mapRef}
          courts={mapCourts}
          userLocation={userLocation}
          onSelectCourt={handleSelect}
        />

        {locating && (
          <View style={styles.locating}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.locatingText}>Finding you…</Text>
          </View>
        )}

        {userLocation && (
          <Pressable style={styles.recenterBtn} onPress={recenter}>
            <Text style={styles.recenterIcon}>◎</Text>
          </Pressable>
        )}
      </View>

      {selected && (
        <CourtDetail court={selected} onClose={() => setSelectedId(null)} />
      )}
    </SafeAreaView>
  );
}

function CourtDetail({ court, onClose }) {
  const { status, bball } = court;
  const week = getBasketballWeek(court);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{court.name}</Text>
          {!!(court.neighborhood || court.address) && (
            <Text style={styles.cardSub}>
              {[court.neighborhood, court.address].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
        <Pressable hitSlop={10} onPress={onClose}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.badgeRow}>
        <View
          style={[styles.badge, bball.open ? styles.badgeOpen : styles.badgeClosed]}
        >
          <Text style={styles.badgeText}>🏀 {bball.label}</Text>
        </View>
        <View
          style={[styles.badge, status.open ? styles.badgeFacOpen : styles.badgeFacClosed]}
        >
          <Text style={styles.badgeText}>Facility {status.open ? 'open' : 'closed'}</Text>
        </View>
      </View>

      <ScrollView style={{ maxHeight: 168 }}>
        <Text style={styles.sectionLabel}>Open-gym basketball</Text>
        {week.map((d) => (
          <View
            key={d.day}
            style={[styles.weekRow, d.isToday && styles.weekRowToday]}
          >
            <Text style={[styles.weekDay, d.isToday && styles.weekTodayText]}>
              {d.day}
              {d.isToday ? ' •' : ''}
            </Text>
            <Text
              style={[
                styles.weekTimes,
                !d.hasBball && styles.weekClosed,
                d.isToday && styles.weekTodayText,
              ]}
            >
              {d.label}
            </Text>
          </View>
        ))}

        {!!court.notes && <Text style={styles.notes}>{court.notes}</Text>}
        <Text style={styles.disclaimer}>
          Open-gym times (summer) vary seasonally — verify on sfrecpark.org.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0d1b2a' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#9db4cc', fontSize: 13, marginTop: 2 },

  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: '#1b2b3d',
    borderRadius: 10,
    padding: 3,
    flex: 1,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: '#2f74d6' },
  segmentText: { color: '#9db4cc', fontWeight: '600', fontSize: 13 },
  segmentTextActive: { color: '#fff' },

  openToggle: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#1b2b3d',
  },
  openToggleActive: { backgroundColor: '#1f9d55' },
  openToggleText: { color: '#9db4cc', fontWeight: '700', fontSize: 13 },
  openToggleTextActive: { color: '#fff' },

  mapWrap: { flex: 1, margin: 12, borderRadius: 16, overflow: 'hidden' },

  locating: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(13,27,42,0.85)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  locatingText: { color: '#fff', fontSize: 13 },

  recenterBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  recenterIcon: { fontSize: 22, color: '#2f74d6' },

  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  cardTitle: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  cardSub: { fontSize: 13, color: '#5b6b7b', marginTop: 2 },
  close: { fontSize: 18, color: '#90a0b0', paddingLeft: 8 },

  badgeRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 10 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  badgeOpen: { backgroundColor: '#d4f3df' },
  badgeClosed: { backgroundColor: '#f3d9d9' },
  badgeFacOpen: { backgroundColor: '#e3eefb' },
  badgeFacClosed: { backgroundColor: '#eceff2' },
  badgeText: { fontSize: 12, fontWeight: '700', color: '#2a3a4a' },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  weekRowToday: { backgroundColor: '#fff3e6' },
  weekDay: { fontSize: 13, color: '#2a3a4a', fontWeight: '600', width: 44 },
  weekTimes: { fontSize: 13, color: '#2a3a4a', flex: 1, textAlign: 'right' },
  weekClosed: { color: '#aab4bd' },
  weekTodayText: { color: '#e8730c', fontWeight: '700' },

  notes: { fontSize: 13, color: '#5b6b7b', marginTop: 8, lineHeight: 18 },
  disclaimer: {
    fontSize: 11,
    color: '#9aa7b4',
    marginTop: 10,
    fontStyle: 'italic',
  },
});
