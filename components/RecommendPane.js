// "Recommended for you": a compact card at the top of the Social tab that auto-
// revolves through suggestions tailored to the user's interests — open-gym games
// for their favorite sports ("Play basketball at Palega · 2:00 PM") and rec-center
// classes with openings in their favorite categories ("Zumba at Sunset Rec ·
// Openings"). Tapping a game opens that court; a class opens its registration page.
// Hidden when there's nothing to recommend. Data comes from lib/recommend.
import React, { useEffect, useMemo, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { buildRecommendations } from '../lib/recommend';
import { CLASS_CATEGORIES, CLASSES } from '../data/classes';
import { sportMeta } from '../lib/sports';
import { fmtClock } from '../lib/datetime';
import { useI18n, sportLabel } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { loadMyStats } from '../lib/playerCheckins';
import ClassDetail from './ClassDetail';

const CAT_EMOJI = Object.fromEntries(CLASS_CATEGORIES.map((c) => [c.id, c.emoji]));
const ROTATE_MS = 5000; // auto-advance cadence (users can also swipe)
const SWIPE_MIN = 40; // horizontal px to count a swipe as prev/next
const MAX_DOTS = 7; // Instagram-style: cap visible dots, shrinking the edges

// Windowed pagination dots. With few recs, show one dot each; with many, slide a
// fixed window over them and shrink the edge dots (like Instagram's carousel) so the
// row stays a constant width. Returns [{ i, tier }] where tier scales the dot size.
function dotList(len, active) {
  if (len <= MAX_DOTS) return Array.from({ length: len }, (_, i) => ({ i, tier: 'full' }));
  const start = Math.max(0, Math.min(active - Math.floor(MAX_DOTS / 2), len - MAX_DOTS));
  return Array.from({ length: MAX_DOTS }, (_, k) => {
    const i = start + k;
    const moreLeft = start > 0;
    const moreRight = start + MAX_DOTS < len;
    let tier = 'full';
    if ((k === 0 && moreLeft) || (k === MAX_DOTS - 1 && moreRight)) tier = 'sm';
    else if ((k === 1 && moreLeft) || (k === MAX_DOTS - 2 && moreRight)) tier = 'md';
    return { i, tier };
  });
}

export default function RecommendPane({
  courts = [],
  userLocation = null,
  sports = [],
  categories = [],
  age = null,
  includeClasses = true, // false in courts-only cities (the class catalog is SF-only)
  onPickCourt,
}) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const hasInterests = sports.length > 0 || categories.length > 0;

  // When the user has set no interests, fall back to their check-in history so
  // recommendations reflect what they actually play (and where). Signed-out / no
  // history → stays null, and buildRecommendations recommends nearby.
  const [history, setHistory] = useState(null);
  useEffect(() => {
    let alive = true;
    if (hasInterests || !user?.id) {
      setHistory(null);
      return () => {
        alive = false;
      };
    }
    (async () => {
      const stats = await loadMyStats(user.id);
      if (!alive) return;
      if (stats && stats.total > 0) {
        const bySport = Object.entries(stats.perSport)
          .sort((a, b) => b[1] - a[1])
          .map(([s]) => s);
        setHistory({ sports: bySport, courtIds: [stats.favoriteCourtId].filter(Boolean) });
      } else {
        setHistory(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user?.id, hasInterests]);

  const recs = useMemo(
    () => buildRecommendations({ courts, userLocation, sports, categories, history, age, includeClasses }),
    [courts, userLocation, sports.join(','), categories.join(','), history, age, includeClasses]
  );
  const [idx, setIdx] = useState(0);
  const [nudge, setNudge] = useState(0); // bumped on manual swipe to reset the timer
  const [detail, setDetail] = useState(null); // full class object when a class is tapped
  const len = recs.length;

  // Advance by ±1 (wrapping) and restart the auto-rotate clock so a manual swipe
  // gets a full dwell before the next auto-advance.
  const go = (dir) => {
    if (len < 2) return;
    setIdx((i) => (i + dir + len) % len);
    setNudge((n) => n + 1);
  };

  useEffect(() => setIdx(0), [len]);
  useEffect(() => {
    if (len < 2) return undefined;
    const id = setInterval(() => setIdx((i) => (i + 1) % len), ROTATE_MS);
    return () => clearInterval(id);
  }, [len, nudge]);

  // Horizontal swipe → prev/next. Recreated when the count changes so `go` closes
  // over the current length; a near-stationary touch stays a tap (Pressable onPress).
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (g.dx <= -SWIPE_MIN) go(1);
          else if (g.dx >= SWIPE_MIN) go(-1);
        },
      }),
    [len]
  );

  if (!recs.length) return null;
  const r = recs[Math.min(idx, recs.length - 1)];

  const onPress = () => {
    if (r.kind === 'class') {
      setDetail(CLASSES.find((c) => c.id === r.id) || null);
    } else {
      onPickCourt?.(r.courtId, r.sport);
    }
  };

  let emoji;
  let title;
  let sub;
  let chip;
  if (r.kind === 'sport') {
    emoji = sportMeta(r.sport).emoji;
    title = t('rec.playAt', { sport: sportLabel(t, r.sport), court: r.courtName });
    sub = r.distanceMi != null ? t('rec.miAway', { mi: r.distanceMi.toFixed(1) }) : '';
    chip = r.ongoing ? t('rec.now') : fmtClock(Math.floor(r.startMin / 60), r.startMin % 60);
  } else {
    emoji = CAT_EMOJI[r.category] || '✨';
    title = r['name_' + lang] || r.name;
    sub = r.location;
    chip = t('rec.openings');
  }

  return (
    <>
    <View {...panResponder.panHandlers}>
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.headRow}>
        <Text style={styles.head}>{t('rec.title')}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.emoji}>{emoji}</Text>
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {!!sub && (
            <Text style={styles.sub} numberOfLines={1}>
              {sub}
            </Text>
          )}
        </View>
        <View style={styles.chip}>
          <Text style={styles.chipText}>{chip}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#b8c6d4" />
      </View>
      {len > 1 && (
        <View style={styles.dots}>
          {dotList(len, idx % len).map(({ i, tier }) => (
            <View
              key={i}
              style={[
                styles.dot,
                styles['dot_' + tier],
                i === idx % len ? styles.dotActive : styles.dotIdle,
              ]}
            />
          ))}
        </View>
      )}
    </Pressable>
    </View>
    {detail && <ClassDetail item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0d1b2a',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 17,
    marginHorizontal: 16,
    marginBottom: 10,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 13 },
  head: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8fb4e8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  emoji: { fontSize: 36 },
  textCol: { flex: 1 },
  title: { fontSize: 18, fontWeight: '800', color: '#fff', lineHeight: 23 },
  sub: { fontSize: 13.5, color: '#9fb0c2', marginTop: 3 },
  chip: {
    backgroundColor: '#1f9d55',
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 5,
  },
  chipText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
    marginTop: 13,
  },
  dot: { borderRadius: 4 },
  dot_full: { width: 6, height: 6, borderRadius: 3 },
  dot_md: { width: 5, height: 5, borderRadius: 2.5 },
  dot_sm: { width: 4, height: 4, borderRadius: 2 },
  dotActive: { backgroundColor: '#e8eef6' },
  dotIdle: { backgroundColor: '#3a4b5e' },
});
