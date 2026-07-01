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
import ClassDetail from './ClassDetail';

const CAT_EMOJI = Object.fromEntries(CLASS_CATEGORIES.map((c) => [c.id, c.emoji]));
const ROTATE_MS = 9000; // auto-advance cadence (slow — users can also swipe)
const SWIPE_MIN = 40; // horizontal px to count a swipe as prev/next

export default function RecommendPane({
  courts = [],
  userLocation = null,
  sports = [],
  categories = [],
  onPickCourt,
}) {
  const { t, lang } = useI18n();
  const recs = useMemo(
    () => buildRecommendations({ courts, userLocation, sports, categories }),
    [courts, userLocation, sports.join(','), categories.join(',')]
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
        {recs.length > 1 && (
          <Text style={styles.count}>
            {(idx % recs.length) + 1}/{recs.length}
          </Text>
        )}
      </View>
      <View style={styles.row}>
        <Text style={styles.emoji}>{emoji}</Text>
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
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
    </Pressable>
    </View>
    {detail && <ClassDetail item={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0d1b2a',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    marginHorizontal: 18,
    marginBottom: 10,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  head: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8fb4e8',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  count: { marginLeft: 'auto', fontSize: 11, fontWeight: '700', color: '#5b6b7b' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  emoji: { fontSize: 26 },
  textCol: { flex: 1 },
  title: { fontSize: 15, fontWeight: '800', color: '#fff' },
  sub: { fontSize: 12, color: '#9fb0c2', marginTop: 1 },
  chip: {
    backgroundColor: '#1f9d55',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipText: { color: '#fff', fontSize: 12, fontWeight: '800' },
});
