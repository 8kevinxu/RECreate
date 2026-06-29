// Classes & Activities tab: SF Rec & Park drop-in programs (fitness, dance, music,
// social games) that aren't court sports. Browse by category; filters live behind
// a button (grouped Age / Cost / Distance). Each card shows the schedule, a
// color-coded price badge, and how many spots are open.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  RefreshControl,
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
import { openDirections } from '../lib/maps';
import { fetchLiveAvailability } from '../lib/classesLive';

// "updated 8s ago" style relative time for the live-availability stamp.
function agoLabel(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};
// Short chip label: "Fitness & Wellness" -> "Fitness", "Social & Games" -> "Social".
const shortLabel = (label) => label.split(' & ')[0];
const ageBand = (m) => (m >= 55 ? '55' : m >= 18 ? '18' : m >= 11 ? 'teen' : 'all');

// Price tier for the color-coded badge: free = green, cheap = yellow, pricier = red.
const PRICE_YELLOW_MAX = 10; // dollars; at or below is yellow, above is red
function priceTone(cost) {
  if (/free/i.test(cost)) return 'free';
  const m = String(cost).match(/(\d+(?:\.\d+)?)/);
  if (!m) return 'unknown'; // "See site", "—"
  const v = Number(m[1]);
  if (v === 0) return 'free';
  return v <= PRICE_YELLOW_MAX ? 'mid' : 'high';
}

// Open-spots indicator from ActiveNet's real `openings` count. Exact when known,
// qualitative when it's a lot or a no-cap drop-in. Returns null when unknown.
function spaceInfo(c) {
  if (c.unlimited) return { text: 'Lots of spots', tone: 'good' };
  const n = c.spots;
  if (n == null) return c.dropIn ? { text: 'Lots of spots', tone: 'good' } : null;
  if (n <= 0) return { text: 'Full', tone: 'bad' };
  if (n <= 5) return { text: `${n} left`, tone: 'warn' };
  if (n >= 20) return { text: 'Lots of spots', tone: 'good' };
  return { text: `${n} openings`, tone: 'good' };
}

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
  const [age, setAge] = useState(null); // 'teen' | '18' | '55' | null
  const [radius, setRadius] = useState(null); // 1 | 3 | 5 | null (miles)
  const [freeOnly, setFreeOnly] = useState(false);
  const [hasSpots, setHasSpots] = useState(false); // hide classes that are full
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Live availability overlay (openings "right now"), fetched from ActiveNet.
  const [live, setLive] = useState(null); // { 'anc-<id>': { spots, unlimited } }
  const [liveStatus, setLiveStatus] = useState('loading'); // 'loading' | 'ok' | 'fail'
  const [liveAt, setLiveAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshLive = async (isPull) => {
    if (isPull) setRefreshing(true);
    else setLiveStatus((s) => (s === 'ok' ? 'ok' : 'loading'));
    const res = await fetchLiveAvailability(isPull); // pull-to-refresh forces past the cache
    if (res) {
      setLive(res.map);
      setLiveStatus('ok');
      setLiveAt(res.at);
    } else {
      setLiveStatus((s) => (s === 'ok' ? 'ok' : 'fail')); // keep prior live data if any
    }
    if (isPull) setRefreshing(false);
  };

  useEffect(() => {
    refreshLive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overlay live openings onto a class when we have them.
  const withLive = (c) => (live && live[c.id] ? { ...c, ...live[c.id] } : c);

  const activeCount = (age ? 1 : 0) + (freeOnly ? 1 : 0) + (radius ? 1 : 0) + (hasSpots ? 1 : 0);

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
      if (hasSpots) {
        // Drop only classes we *know* are full (uses the live overlay when present).
        const sp = spaceInfo(live && live[c.id] ? { ...c, ...live[c.id] } : c);
        if (sp && sp.tone === 'bad') return false;
      }
      if (radius) {
        const d = distOf(c);
        if (d == null || d > radius) return false;
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, query, age, radius, freeOnly, hasSpots, live, userLocation]);

  const clearAll = () => {
    setAge(null);
    setFreeOnly(false);
    setRadius(null);
    setHasSpots(false);
  };

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

      <View style={styles.toolRow}>
        <Pressable
          style={[styles.filterBtn, activeCount > 0 && styles.filterBtnActive]}
          onPress={() => setFiltersOpen(true)}
        >
          <Ionicons name="options-outline" size={16} color={activeCount > 0 ? '#2f74d6' : '#46586a'} />
          <Text style={[styles.filterBtnText, activeCount > 0 && styles.filterBtnTextActive]}>
            Filters
          </Text>
          {activeCount > 0 && (
            <View style={styles.filterCount}>
              <Text style={styles.filterCountText}>{activeCount}</Text>
            </View>
          )}
        </Pressable>
        <Text style={styles.resultCount}>
          {list.length} {list.length === 1 ? 'class' : 'classes'}
        </Text>
      </View>

      <View style={styles.liveRow}>
        <View
          style={[
            styles.liveDot,
            liveStatus === 'ok' && styles.liveDotOk,
            liveStatus === 'fail' && styles.liveDotFail,
          ]}
        />
        <Text style={styles.liveText}>
          {liveStatus === 'loading'
            ? 'Checking live availability…'
            : liveStatus === 'ok'
            ? `Live availability · updated ${agoLabel(liveAt)}`
            : 'Showing saved availability — pull to refresh'}
        </Text>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refreshLive(true)}
            tintColor="#2f74d6"
          />
        }
      >
        {list.length === 0 && (
          <Text style={styles.empty}>No classes match — try a different search or filters.</Text>
        )}
        {list.map((c) => {
          const d = distOf(c);
          const pt = priceTone(c.cost);
          const sp = spaceInfo(withLive(c));
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

              <View style={styles.pillRow}>
                <View style={[styles.pricePill, priceStyles[pt].pill]}>
                  <Text style={[styles.priceText, priceStyles[pt].text]}>{c.cost}</Text>
                </View>
                {sp && (
                  <View style={[styles.spacePill, spaceStyles[sp.tone].pill]}>
                    <Text style={[styles.spaceText, spaceStyles[sp.tone].text]}>{sp.text}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }} />
                {c.lat != null && (
                  <Pressable style={styles.dirBtn} onPress={() => openDirections(c.lat, c.lng, c.location)}>
                    <Ionicons name="navigate" size={12} color="#2f74d6" />
                    <Text style={styles.dirBtnText}>Directions</Text>
                  </Pressable>
                )}
              </View>
              <Text style={styles.ages}>{c.ages}</Text>
            </Pressable>
          );
        })}

        <Text style={styles.disclaimer}>
          From SF Rec & Park (ActiveNet) — verify times and registration on sfrecpark.org
          before heading out. Tap a class for details.
        </Text>
      </ScrollView>

      <Modal
        visible={filtersOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFiltersOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setFiltersOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Filters</Text>
              {activeCount > 0 && (
                <Pressable onPress={clearAll} hitSlop={8}>
                  <Text style={styles.clearAll}>Clear all</Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.groupLabel}>Age</Text>
            <View style={styles.groupChips}>
              <FilterChip label="Teen" on={age === 'teen'} onPress={() => setAge(age === 'teen' ? null : 'teen')} />
              <FilterChip label="18+" on={age === '18'} onPress={() => setAge(age === '18' ? null : '18')} />
              <FilterChip label="55+" on={age === '55'} onPress={() => setAge(age === '55' ? null : '55')} />
            </View>

            <Text style={styles.groupLabel}>Availability</Text>
            <View style={styles.groupChips}>
              <FilterChip label="Has spots" on={hasSpots} onPress={() => setHasSpots((v) => !v)} />
            </View>

            <Text style={styles.groupLabel}>Cost</Text>
            <View style={styles.groupChips}>
              <FilterChip label="Free only" on={freeOnly} onPress={() => setFreeOnly((v) => !v)} />
            </View>

            {!!userLocation && (
              <>
                <Text style={styles.groupLabel}>Distance</Text>
                <View style={styles.groupChips}>
                  {[1, 3, 5].map((r) => (
                    <FilterChip
                      key={r}
                      label={`< ${r} mi`}
                      on={radius === r}
                      onPress={() => setRadius(radius === r ? null : r)}
                    />
                  ))}
                </View>
              </>
            )}

            <Pressable style={styles.doneBtn} onPress={() => setFiltersOpen(false)}>
              <Text style={styles.doneText}>
                Show {list.length} {list.length === 1 ? 'class' : 'classes'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// Price badge palettes (circular bordered pill around the cost).
const priceStyles = {
  free: { pill: { borderColor: '#1f9d55', backgroundColor: '#e7f5ec' }, text: { color: '#1f8a4c' } },
  mid: { pill: { borderColor: '#e0a800', backgroundColor: '#fdf6e0' }, text: { color: '#9a7400' } },
  high: { pill: { borderColor: '#e5484d', backgroundColor: '#fdeaea' }, text: { color: '#c23b3b' } },
  unknown: { pill: { borderColor: '#c8d2dc', backgroundColor: '#f1f4f7' }, text: { color: '#6b7a8a' } },
};
const spaceStyles = {
  good: { pill: { backgroundColor: '#e7f5ec' }, text: { color: '#1f8a4c' } },
  warn: { pill: { backgroundColor: '#fdf0e0' }, text: { color: '#b56a14' } },
  bad: { pill: { backgroundColor: '#fdeaea' }, text: { color: '#c23b3b' } },
};

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
    marginBottom: 10,
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

  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  filterBtnActive: { borderColor: '#2f74d6', backgroundColor: '#e7f0fc' },
  filterBtnText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  filterBtnTextActive: { color: '#2f74d6' },
  filterCount: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#2f74d6',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  filterCountText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  resultCount: { fontSize: 13, color: '#8a99a8', fontWeight: '600' },

  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e0a800' },
  liveDotOk: { backgroundColor: '#1f9d55' },
  liveDotFail: { backgroundColor: '#9aa7b4' },
  liveText: { fontSize: 12, color: '#6b7a8a', fontWeight: '600' },

  fchip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  fchipOn: { backgroundColor: '#e7f0fc', borderColor: '#2f74d6' },
  fchipText: { color: '#5b6b7b', fontWeight: '700', fontSize: 13 },
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

  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  pricePill: {
    paddingHorizontal: 11,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  priceText: { fontSize: 13, fontWeight: '800' },
  spacePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  spaceText: { fontSize: 12, fontWeight: '700' },
  dirBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: '#e7f0fc',
  },
  dirBtnText: { color: '#2f74d6', fontWeight: '800', fontSize: 12 },
  ages: { fontSize: 12, color: '#8a99a8', fontWeight: '600', marginTop: 8 },

  disclaimer: { fontSize: 11, color: '#9aa7b4', fontStyle: 'italic', marginTop: 6, lineHeight: 16 },

  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d7dee6',
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  clearAll: { fontSize: 14, color: '#2f74d6', fontWeight: '700' },
  groupLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#6b7a8a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 8,
  },
  groupChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  doneBtn: {
    backgroundColor: '#2f74d6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  doneText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
