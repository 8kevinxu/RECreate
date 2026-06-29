// Classes & Activities tab: SF Rec & Park drop-in programs (fitness, dance, music,
// social games) that aren't court sports. Browse by category; each card shows the
// weekly schedule, location, and whether it's free drop-in or registration.
import React, { useMemo, useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CLASSES, CLASS_CATEGORIES } from '../data/classes';
import { haversineMiles, formatDistance } from '../lib/distance';

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};
// Short chip label: "Fitness & Wellness" -> "Fitness", "Social & Games" -> "Social".
const shortLabel = (label) => label.split(' & ')[0];
const ageBand = (m) => (m >= 55 ? '55' : m >= 18 ? '18' : 'all');
const hasSpots = (c) => c.dropIn || (c.spots ?? 0) > 0;

function FilterChip({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.fchip, on && styles.fchipOn]}>
      <Text style={[styles.fchipText, on && styles.fchipTextOn]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export default function ClassesScreen({ userLocation = null }) {
  const insets = useSafeAreaInsets();
  const [cat, setCat] = useState('all');
  const [query, setQuery] = useState('');
  const [age, setAge] = useState(null); // '18' | '55' | null
  const [radius, setRadius] = useState(null); // 5 | 10 | 15 | null (miles)
  const [freeOnly, setFreeOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(false);

  const distOf = (c) =>
    userLocation && c.lat != null
      ? haversineMiles(userLocation.lat, userLocation.lng, c.lat, c.lng)
      : null;

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CLASSES.filter((c) => {
      if (cat !== 'all' && c.category !== cat) return false;
      if (q && !c.name.toLowerCase().includes(q) && !c.location.toLowerCase().includes(q)) return false;
      if (age) {
        const b = ageBand(c.minAge || 0);
        if (b !== age && b !== 'all') return false;
      }
      if (freeOnly && c.cost !== 'Free') return false;
      if (openOnly && !hasSpots(c)) return false;
      if (radius) {
        const d = distOf(c);
        if (d == null || d > radius) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, query, age, radius, freeOnly, openOnly, userLocation]);

  return (
    <View style={[styles.page, { paddingTop: insets.top + 14 }]}>
      <Text style={styles.title}>Classes & Activities</Text>
      <Text style={styles.sub}>Drop-in programs at SF rec centers</Text>

      <View style={styles.search}>
        <Ionicons name="search" size={16} color="#8a99a8" />
        <TextInput
          style={styles.searchInput}
          placeholder="Search classes or rec centers"
          placeholderTextColor="#9aa7b4"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
        />
      </View>

      <View style={styles.catRow}>
        {[{ id: 'all', label: 'All', emoji: '✨' }, ...CLASS_CATEGORIES].map((c) => {
          const active = cat === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => setCat(c.id)}
              style={[styles.catChip, active && styles.catChipActive]}
            >
              <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                {c.emoji} {shortLabel(c.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.filterRow}>
        <FilterChip label="18+" on={age === '18'} onPress={() => setAge(age === '18' ? null : '18')} />
        <FilterChip label="55+" on={age === '55'} onPress={() => setAge(age === '55' ? null : '55')} />
        <FilterChip label="Free" on={freeOnly} onPress={() => setFreeOnly((v) => !v)} />
        <FilterChip label="Open spots" on={openOnly} onPress={() => setOpenOnly((v) => !v)} />
        {!!userLocation &&
          [5, 10, 15].map((r) => (
            <FilterChip
              key={r}
              label={`≤${r} mi`}
              on={radius === r}
              onPress={() => setRadius(radius === r ? null : r)}
            />
          ))}
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        showsVerticalScrollIndicator={false}
      >
        {list.length === 0 && (
          <Text style={styles.empty}>No classes match — try a different search or filters.</Text>
        )}
        {list.map((c) => {
          const d = distOf(c);
          return (
          <Pressable key={c.id} style={styles.card} onPress={() => Linking.openURL(c.url)}>
            <View style={styles.cardTop}>
              <Text style={styles.cardName}>
                {catMeta(c.category).emoji} {c.name}
              </Text>
              <View style={[styles.tag, c.dropIn ? styles.tagDropIn : styles.tagReg]}>
                <Text style={[styles.tagText, c.dropIn ? styles.tagDropInText : styles.tagRegText]}>
                  {c.dropIn ? 'Drop-in' : 'Register'}
                </Text>
              </View>
            </View>
            <Text style={styles.when}>🕒 {c.when}</Text>
            <Text style={styles.loc}>
              📍 {c.location}
              {d != null ? ` · ${formatDistance(d)}` : ''}
            </Text>
            <Text style={styles.meta}>
              {c.cost} · {c.ages}
            </Text>
          </Pressable>
          );
        })}

        <Text style={styles.disclaimer}>
          From SF Rec & Park (ActiveNet) — verify times and registration on sfrecpark.org
          before heading out. Tap a class for details.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#eef1f5', paddingHorizontal: 16 },
  title: { fontSize: 24, fontWeight: '800', color: '#0d1b2a' },
  sub: { fontSize: 13, color: '#6b7a8a', marginTop: 2, marginBottom: 10 },

  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dde3ea',
    paddingHorizontal: 11,
    height: 40,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: '#0d1b2a', paddingVertical: 0 },

  catRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 12,
  },
  catChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  catChipActive: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  catChipText: { color: '#46586a', fontWeight: '700', fontSize: 12 },
  catChipTextActive: { color: '#fff' },

  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  fchip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  fchipOn: { backgroundColor: '#e7f0fc', borderColor: '#2f74d6' },
  fchipText: { color: '#5b6b7b', fontWeight: '700', fontSize: 12 },
  fchipTextOn: { color: '#2f74d6' },
  empty: { fontSize: 13, color: '#9aa7b4', fontStyle: 'italic', paddingVertical: 16 },

  list: { flex: 1 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e6e9ee',
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  cardName: { flex: 1, fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  tag: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  tagDropIn: { backgroundColor: '#d4f3df' },
  tagReg: { backgroundColor: '#e7f0fc' },
  tagText: { fontSize: 11, fontWeight: '800' },
  tagDropInText: { color: '#1f8a4c' },
  tagRegText: { color: '#2f74d6' },
  when: { fontSize: 13, color: '#46586a', fontWeight: '600', marginTop: 8 },
  loc: { fontSize: 13, color: '#46586a', marginTop: 3 },
  meta: { fontSize: 12, color: '#8a99a8', marginTop: 6, fontWeight: '600' },

  disclaimer: { fontSize: 11, color: '#9aa7b4', fontStyle: 'italic', marginTop: 6, lineHeight: 16 },
});
