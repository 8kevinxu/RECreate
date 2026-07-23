// Classes & Activities tab: SF Rec & Park drop-in programs (fitness, dance, music,
// social games) that aren't court sports. Browse by category; filters live behind
// a button (grouped Age / Cost / Distance). Each card shows the schedule, a
// color-coded price badge, and how many spots are open.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
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
import { CITY_CLASSES } from '../data/cities';
import { haversineMiles, formatDistance } from '../lib/distance';
import { openDirections } from '../lib/maps';
import { localizeWhen } from '../lib/datetime';
import { fetchLiveAvailability } from '../lib/classesLive';
import { useI18n } from '../lib/i18n';
import ClassDetail from './ClassDetail';
import ScrollTopFab from './ScrollTopFab';

// "updated 8s ago" style relative time for the live-availability stamp.
function agoLabel(t, ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return t('ago.justNow');
  if (s < 60) return t('ago.sec', { n: s });
  const m = Math.round(s / 60);
  return m < 60 ? t('ago.min', { n: m }) : t('ago.hour', { n: Math.round(m / 60) });
}

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};

// A class passes an age chip when its [minAge, maxAge] range admits someone in
// that group (maxAge absent = no upper bound). Kids-only programs (e.g. camps
// "ages 5-10", parent-and-tot "under 5") are capped by maxAge and so never pass
// Teen/18+/55+. The 55+ chip is senior-targeted programs specifically — an
// open-ended adult class doesn't qualify just because a senior could attend.
const ageEligible = (c, band) => {
  const lo = c.minAge || 0;
  const hi = c.maxAge == null ? Infinity : c.maxAge;
  if (band === 'teen') return lo <= 17 && hi >= 11;
  if (band === '18') return hi >= 18;
  return lo >= 55 || /senior/i.test(c.name); // '55'
};

// Start time (minutes from midnight) parsed from a `when` string like
// "Tue & Wed · 8:30 AM - 10:30 AM" — the time part after the day separator.
function startMin(when) {
  if (!when) return null;
  const timePart = String(when).split('·').pop();
  const m = timePart.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (m) {
    const h = (Number(m[1]) % 12) + (/PM/i.test(m[3]) ? 12 : 0);
    return h * 60 + (m[2] ? Number(m[2]) : 0);
  }
  return /noon/i.test(timePart) ? 720 : null;
}
// Time-of-day bucket: morning < 12 PM, afternoon 12–5 PM, evening ≥ 5 PM.
const timeBand = (min) => (min == null ? null : min < 720 ? 'morning' : min < 1020 ? 'afternoon' : 'evening');

// Weekdays a class meets (Set of 0=Sun..6=Sat), parsed from the day part of `when`
// ("Tue & Wed & Thu & Fri · …"). Null when none are recognized.
const DOW_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function daysOf(when) {
  if (!when) return null;
  const dayPart = String(when).split('·')[0];
  const set = new Set();
  const re = /\b(sun|mon|tue|wed|thu|fri|sat)\b/gi;
  let m;
  while ((m = re.exec(dayPart))) set.add(DOW_IDX[m[1].toLowerCase()]);
  return set.size ? set : null;
}

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
// Returns an i18n key (+ count) so the caller renders it in the current language.
function spaceInfo(c) {
  if (c.unlimited) return { key: 'classes.unlimited', tone: 'good' };
  const n = c.spots;
  if (n == null) return c.dropIn ? { key: 'classes.lotsSpots', tone: 'good' } : null;
  if (n <= 0) return { key: 'classes.full', tone: 'bad' };
  if (n <= 5) return { key: 'classes.left', n, tone: 'warn' };
  if (n >= 20) return { key: 'classes.lotsSpots', tone: 'good' };
  return { key: 'classes.openings', n, tone: 'good' };
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

export default function ClassesScreen({ userLocation = null, city = 'sf' }) {
  const insets = useSafeAreaInsets();
  const { t, lang } = useI18n();
  // The active city's catalog: SF's ActiveNet classes, or the city's own list
  // (NYC: free Parks programs). The ActiveNet live-availability overlay and its
  // delist-hiding are SF-only — other sources have no realtime feed.
  const isSF = city === 'sf';
  const catalog = isSF ? CLASSES : CITY_CLASSES[city] || [];
  // Bundled title translation (build-classes.js); falls back to the English name.
  const className = (c) => c['name_' + lang] || c.name;
  const [cat, setCat] = useState('all');
  const [query, setQuery] = useState('');
  const [age, setAge] = useState(null); // 'teen' | '18' | '55' | null
  const [time, setTime] = useState(null); // 'morning' | 'afternoon' | 'evening' | null
  const [day, setDay] = useState(null); // 0=Sun..6=Sat, or null (any day)
  const [radius, setRadius] = useState(null); // 1 | 3 | 5 | null (miles)
  const [freeOnly, setFreeOnly] = useState(false);
  const [hasSpots, setHasSpots] = useState(false); // hide classes that are full
  const [walkIn, setWalkIn] = useState(false); // only walk-ins (no registration)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detail, setDetail] = useState(null); // class tapped open for its detail sheet

  // Live availability overlay (openings "right now"), fetched from ActiveNet.
  const [live, setLive] = useState(null); // { 'anc-<id>': { spots, unlimited } }
  const [liveStatus, setLiveStatus] = useState('loading'); // 'loading' | 'ok' | 'fail'
  const [liveAt, setLiveAt] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Collapsing header: the title/subtitle/info block shrinks + fades as one unit as
  // you scroll the list down, and grows smoothly back as you scroll up. Driven
  // directly off the scroll offset (finger-tracked) rather than toggled with
  // start/stop animations, so the expand-back is smooth instead of choppy.
  const scrollY = useRef(new Animated.Value(0)).current;
  const scrollRef = useRef(null);
  const lastY = useRef(0);
  const [headerH, setHeaderH] = useState(0);
  const [showTop, setShowTop] = useState(false); // "back to top" arrow visibility
  const onListScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    {
      useNativeDriver: false, // animating layout height can't use the native driver
      // Show the back-to-top arrow when the user swipes UP while collapsed (scrolled
      // past the header); hide it when scrolling down or back near the top.
      listener: (e) => {
        const y = e.nativeEvent.contentOffset.y;
        const dy = y - lastY.current;
        lastY.current = y;
        if (y < 12) setShowTop(false);
        else if (dy < -4 && y > headerH) setShowTop(true);
        else if (dy > 4) setShowTop(false);
      },
    }
  );
  const scrollToTop = () => scrollRef.current?.scrollTo({ y: 0, animated: true });
  // Decouple fade from height so the block never shows a top-down clip reveal (which
  // made the info bullet "lag in" last). Phase 1 (first 30% of scroll): stay at FULL
  // height and just fade — so the whole block appears/disappears as one unit, never
  // clipped. Phase 2 (remaining 70%): already invisible, collapse the height to
  // reclaim space. Reversed on the way up: height grows invisibly, then the full
  // block fades in together.
  const FADE = headerH * 0.3;
  const collapsibleStyle = headerH
    ? {
        overflow: 'hidden',
        height: scrollY.interpolate({
          inputRange: [0, FADE, headerH],
          outputRange: [headerH, headerH, 0],
          extrapolate: 'clamp',
        }),
        opacity: scrollY.interpolate({
          inputRange: [0, FADE],
          outputRange: [1, 0],
          extrapolate: 'clamp',
        }),
      }
    : { overflow: 'hidden' };

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
    if (isSF) refreshLive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSF]);

  // Overlay live openings onto a class when we have them.
  const withLive = (c) => (live && live[c.id] ? { ...c, ...live[c.id] } : c);

  const activeCount =
    (age ? 1 : 0) +
    (time ? 1 : 0) +
    (day !== null ? 1 : 0) +
    (freeOnly ? 1 : 0) +
    (walkIn ? 1 : 0) +
    (radius ? 1 : 0) +
    (hasSpots ? 1 : 0);

  const distOf = (c) =>
    userLocation && c.lat != null
      ? haversineMiles(userLocation.lat, userLocation.lng, c.lat, c.lng)
      : null;

  // Categories with at least one class in this catalog (counting primary +
  // tags), so empty chips self-hide — e.g. 'philanthropy' only shows for NYC.
  const presentCats = useMemo(() => {
    const set = new Set();
    for (const c of catalog) {
      set.add(c.category);
      for (const tg of c.tags || []) set.add(tg);
    }
    return set;
  }, [catalog]);

  // If the selected category no longer exists (e.g. after switching city),
  // fall back to All so the list doesn't silently filter to nothing.
  useEffect(() => {
    if (cat !== 'all' && !presentCats.has(cat)) setCat('all');
  }, [cat, presentCats]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    // ActiveNet delists cancelled/ended classes, so a class missing from a *healthy*
    // live catalog fetch is no longer offered — hide it (real-time on native; web
    // falls back to the baseline). The size guard avoids mass-hiding on a thin fetch.
    const liveComplete =
      isSF && liveStatus === 'ok' && live && Object.keys(live).length >= catalog.length * 0.8;
    const filtered = catalog.filter((c) => {
      if (liveComplete && !live[c.id]) return false;
      // A class matches a category by its primary `category` OR any secondary
      // `tags` (e.g. a philanthropy-tagged event still shows under 'social').
      if (cat !== 'all' && c.category !== cat && !(c.tags || []).includes(cat)) return false;
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !className(c).toLowerCase().includes(q) &&
        !c.location.toLowerCase().includes(q)
      )
        return false;
      if (age && !ageEligible(c, age)) return false;
      if (time && timeBand(startMin(c.when)) !== time) return false;
      if (day !== null && !daysOf(c.when)?.has(day)) return false;
      if (freeOnly && c.cost !== 'Free') return false;
      if (walkIn && !c.dropIn) return false;
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
    // Sink full classes to the bottom, otherwise keep the source (alphabetic) order.
    // Stable partition (not sort) so ordering within each group is untouched.
    const isFull = (c) => {
      const sp = spaceInfo(withLive(c));
      return !!sp && sp.tone === 'bad';
    };
    return [...filtered.filter((c) => !isFull(c)), ...filtered.filter(isFull)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, cat, query, age, time, day, radius, freeOnly, hasSpots, walkIn, live, liveStatus, userLocation, lang]);

  const clearAll = () => {
    setAge(null);
    setTime(null);
    setDay(null);
    setFreeOnly(false);
    setRadius(null);
    setHasSpots(false);
    setWalkIn(false);
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top + 14 }]}>
      <Animated.View style={collapsibleStyle}>
        <View
          onLayout={(e) => {
            // Natural height of the block (measured on the inner view, so the outer
            // clamp/clip never feeds back into the measurement).
            const h = e.nativeEvent.layout.height;
            if (h && Math.abs(h - headerH) > 1) setHeaderH(h);
          }}
        >
          <Text style={styles.title}>{t('classes.title')}</Text>
          <Text style={styles.sub}>{t(isSF ? 'classes.sub' : 'classes.subNyc')}</Text>
          <View style={styles.infoBullet}>
            <Ionicons name="information-circle-outline" size={15} color="#5b7a9a" />
            <Text style={styles.infoBulletText}>
              {t(isSF ? 'classes.activeNetInfo' : 'classes.nycInfo')}
            </Text>
          </View>
        </View>
      </Animated.View>

      <View style={styles.search}>
        <Ionicons name="search" size={16} color="#8a99a8" />
        <TextInput
          style={styles.searchInput}
          placeholder={t('classes.searchPh')}
          placeholderTextColor="#9aa7b4"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
        />
      </View>

      <View style={styles.catRow}>
        {[{ id: 'all', emoji: '✨' }, ...CLASS_CATEGORIES.filter((c) => presentCats.has(c.id))].map((c) => {
          const active = cat === c.id;
          return (
            <Pressable
              key={c.id}
              onPress={() => setCat(c.id)}
              style={[styles.catChip, active && styles.catChipActive]}
            >
              <Text style={[styles.catChipText, active && styles.catChipTextActive]}>
                {c.emoji} {t('cat.' + c.id)}
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
            {t('filters')}
          </Text>
          {activeCount > 0 && (
            <View style={styles.filterCount}>
              <Text style={styles.filterCountText}>{activeCount}</Text>
            </View>
          )}
        </Pressable>
        <Text style={styles.resultCount}>
          {list.length} {t(list.length === 1 ? 'classes.classOne' : 'classes.classMany')}
        </Text>
      </View>

      {isSF && (
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
              ? t('classes.liveLoading')
              : liveStatus === 'ok'
              ? t('classes.liveOk', { ago: agoLabel(t, liveAt) })
              : t('classes.liveFail')}
          </Text>
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
        showsVerticalScrollIndicator={false}
        onScroll={onListScroll}
        scrollEventThrottle={16}
        refreshControl={
          isSF ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => refreshLive(true)}
              tintColor="#2f74d6"
            />
          ) : undefined
        }
      >
        {list.length === 0 && <Text style={styles.empty}>{t('classes.empty')}</Text>}
        {list.map((c) => {
          const d = distOf(c);
          const pt = priceTone(c.cost);
          const sp = spaceInfo(withLive(c));
          return (
            <Pressable key={c.id} style={styles.card} onPress={() => setDetail(withLive(c))}>
              <View style={styles.cardTop}>
                <Text style={styles.cardName}>
                  {catMeta(c.category).emoji} {className(c)}
                </Text>
                <View style={[styles.tag, c.dropIn ? styles.tagDropIn : styles.tagReg]}>
                  <Text style={[styles.tagText, c.dropIn ? styles.tagDropInText : styles.tagRegText]}>
                    {c.dropIn ? t('classes.dropIn') : t('classes.register')}
                  </Text>
                </View>
              </View>
              <Text style={styles.when}>🕒 {localizeWhen(c.when)}</Text>
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
                    <Text style={[styles.spaceText, spaceStyles[sp.tone].text]}>
                      {t(sp.key, sp.n != null ? { n: sp.n } : undefined)}
                    </Text>
                  </View>
                )}
                <View style={{ flex: 1 }} />
                {c.lat != null && (
                  <Pressable style={styles.dirBtn} onPress={() => openDirections(c.lat, c.lng, c.location)}>
                    <Ionicons name="navigate" size={12} color="#2f74d6" />
                    <Text style={styles.dirBtnText}>{t('directions')}</Text>
                  </Pressable>
                )}
              </View>
              <Text style={styles.ages}>{c.ages}</Text>
            </Pressable>
          );
        })}

        <Text style={styles.disclaimer}>{t(isSF ? 'classes.disclaimer' : 'cls.nycNote')}</Text>
      </ScrollView>

      <ScrollTopFab show={showTop} onPress={scrollToTop} bottom={insets.bottom + 92} />

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
              <Text style={styles.sheetTitle}>{t('filters')}</Text>
              {activeCount > 0 && (
                <Pressable onPress={clearAll} hitSlop={8}>
                  <Text style={styles.clearAll}>{t('clearAll')}</Text>
                </Pressable>
              )}
            </View>

            <Text style={styles.groupLabel}>{t('filter.age')}</Text>
            <View style={styles.groupChips}>
              <FilterChip label={t('filter.teen')} on={age === 'teen'} onPress={() => setAge(age === 'teen' ? null : 'teen')} />
              <FilterChip label="18+" on={age === '18'} onPress={() => setAge(age === '18' ? null : '18')} />
              <FilterChip label="55+" on={age === '55'} onPress={() => setAge(age === '55' ? null : '55')} />
            </View>

            <Text style={styles.groupLabel}>{t('filter.time')}</Text>
            <View style={styles.groupChips}>
              {['morning', 'afternoon', 'evening'].map((tb) => (
                <FilterChip
                  key={tb}
                  label={t('filter.' + tb)}
                  on={time === tb}
                  onPress={() => setTime(time === tb ? null : tb)}
                />
              ))}
            </View>

            <Text style={styles.groupLabel}>{t('filter.days')}</Text>
            <View style={styles.groupChips}>
              {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                <FilterChip
                  key={d}
                  label={t('day.' + d)}
                  on={day === d}
                  onPress={() => setDay(day === d ? null : d)}
                />
              ))}
            </View>

            <Text style={styles.groupLabel}>{t('filter.availability')}</Text>
            <View style={styles.groupChips}>
              <FilterChip label={t('filter.hasSpots')} on={hasSpots} onPress={() => setHasSpots((v) => !v)} />
              <FilterChip label={t('filter.walkIn')} on={walkIn} onPress={() => setWalkIn((v) => !v)} />
            </View>

            <Text style={styles.groupLabel}>{t('filter.cost')}</Text>
            <View style={styles.groupChips}>
              <FilterChip label={t('filter.freeOnly')} on={freeOnly} onPress={() => setFreeOnly((v) => !v)} />
            </View>

            {!!userLocation && (
              <>
                <Text style={styles.groupLabel}>{t('filter.distance')}</Text>
                <View style={styles.groupChips}>
                  {[1, 3, 5].map((r) => (
                    <FilterChip
                      key={r}
                      label={t('filter.distChip', { r })}
                      on={radius === r}
                      onPress={() => setRadius(radius === r ? null : r)}
                    />
                  ))}
                </View>
              </>
            )}

            <Pressable style={styles.doneBtn} onPress={() => setFiltersOpen(false)}>
              <Text style={styles.doneText}>
                {t('classes.show')} {list.length}{' '}
                {t(list.length === 1 ? 'classes.classOne' : 'classes.classMany')}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {detail && <ClassDetail item={detail} onClose={() => setDetail(null)} />}
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
  sub: { fontSize: 13, color: '#6b7a8a', marginTop: 2, marginBottom: 8 },
  infoBullet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: '#eef4fb',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  infoBulletText: { flex: 1, fontSize: 12, color: '#46586a', fontWeight: '600', lineHeight: 16 },

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
