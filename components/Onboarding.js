// First-launch onboarding: swipeable value-prop slides, then a few setup steps —
// pick interests (sports + class activities), enable location in context, and an
// optional account nudge. Shown once; App.js gates it on the recreate.onboarded.v1
// flag. onFinish reports the picks/intent back so App.js can persist interests
// (locally, so recs personalize even signed-out) and route to sign-up if asked.
import React, { useMemo, useState } from 'react';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n, sportLabel } from '../lib/i18n';
import { SPORTS } from '../lib/sports';
import { CLASS_CATEGORIES } from '../data/classes';

const SWIPE_MIN = 40; // horizontal px to count a swipe as prev/next on info slides

// Value-prop slides, then the setup steps (each special-cased in render).
const SLIDES = [
  { type: 'info', emoji: '🏃', title: 'onb.s1.title', body: 'onb.s1.body' },
  { type: 'info', emoji: '🗺️', title: 'onb.s2.title', body: 'onb.s2.body' },
  { type: 'info', emoji: '🚦', title: 'onb.s3.title', body: 'onb.s3.body' },
  { type: 'info', emoji: '🤝', title: 'onb.s4.title', body: 'onb.s4.body' },
  { type: 'interests' },
  { type: 'location' },
  { type: 'account' },
];

const toggle = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

export default function Onboarding({ onFinish, onEnableLocation }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [idx, setIdx] = useState(0);
  const [selSports, setSelSports] = useState([]);
  const [selCats, setSelCats] = useState([]);
  const [enabledLoc, setEnabledLoc] = useState(false);

  const len = SLIDES.length;
  const slide = SLIDES[idx];
  const isLast = idx === len - 1;

  const go = (dir) => setIdx((i) => Math.max(0, Math.min(len - 1, i + dir)));

  const finish = (createAccount) =>
    onFinish({
      interests: { sports: selSports, categories: selCats },
      createAccount,
      enabledLocation: enabledLoc,
    });

  const enableLocation = () => {
    setEnabledLoc(true);
    onEnableLocation?.();
    go(1);
  };

  // Horizontal swipe → prev/next, only on the plain info slides (interactive
  // slides have their own controls and scroll content).
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) =>
          slide.type === 'info' &&
          Math.abs(g.dx) > 10 &&
          Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderRelease: (_, g) => {
          if (g.dx <= -SWIPE_MIN) go(1);
          else if (g.dx >= SWIPE_MIN) go(-1);
        },
      }),
    [slide.type, len]
  );

  const nSel = selSports.length + selCats.length;

  return (
    <View style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.topBar}>
        {slide.type === 'info' && (
          <Pressable hitSlop={12} onPress={() => finish(false)}>
            <Text style={styles.skip}>{t('onb.skip')}</Text>
          </Pressable>
        )}
      </View>

      {/* ---- slide body ---- */}
      {slide.type === 'info' && (
        <View style={styles.body} {...panResponder.panHandlers}>
          <Text style={styles.emoji}>{slide.emoji}</Text>
          <Text style={styles.title}>{t(slide.title)}</Text>
          <Text style={styles.text}>{t(slide.body)}</Text>
        </View>
      )}

      {slide.type === 'interests' && (
        <View style={styles.body}>
          <Text style={styles.title}>{t('onb.int.title')}</Text>
          <Text style={[styles.text, { marginBottom: 22 }]}>{t('onb.int.body')}</Text>
          <ScrollView
            style={styles.chipScroll}
            contentContainerStyle={styles.chipScrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.section}>{t('onb.int.sports')}</Text>
            <View style={styles.chipWrap}>
              {SPORTS.map((s) => {
                const on = selSports.includes(s.id);
                return (
                  <Pressable
                    key={s.id}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => setSelSports((a) => toggle(a, s.id))}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {s.emoji} {sportLabel(t, s.id)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.section, { marginTop: 18 }]}>{t('onb.int.activities')}</Text>
            <View style={styles.chipWrap}>
              {CLASS_CATEGORIES.map((c) => {
                const on = selCats.includes(c.id);
                return (
                  <Pressable
                    key={c.id}
                    style={[styles.chip, on && styles.chipOn]}
                    onPress={() => setSelCats((a) => toggle(a, c.id))}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {c.emoji} {t('cat.' + c.id)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      )}

      {slide.type === 'location' && (
        <View style={styles.body}>
          <Text style={styles.emoji}>📍</Text>
          <Text style={styles.title}>{t('onb.loc.title')}</Text>
          <Text style={styles.text}>{t('onb.loc.body')}</Text>
        </View>
      )}

      {slide.type === 'account' && (
        <View style={styles.body}>
          <Text style={styles.emoji}>👤</Text>
          <Text style={styles.title}>{t('onb.acct.title')}</Text>
          <Text style={styles.text}>{t('onb.acct.body')}</Text>
        </View>
      )}

      {/* ---- footer: dots + controls ---- */}
      <View style={styles.footer}>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.dot, i === idx ? styles.dotActive : styles.dotIdle]} />
          ))}
        </View>

        {slide.type === 'info' && (
          <Pressable style={styles.primaryBtn} onPress={() => go(1)}>
            <Text style={styles.primaryText}>{t('onb.next')}</Text>
          </Pressable>
        )}

        {slide.type === 'interests' && (
          <Pressable style={styles.primaryBtn} onPress={() => go(1)}>
            <Text style={styles.primaryText}>{nSel ? t('onb.continue') : t('onb.skip')}</Text>
          </Pressable>
        )}

        {slide.type === 'location' && (
          <>
            <Pressable style={styles.primaryBtn} onPress={enableLocation}>
              <Ionicons name="location" size={18} color="#fff" />
              <Text style={styles.primaryText}>{t('onb.loc.enable')}</Text>
            </Pressable>
            <Pressable hitSlop={10} style={styles.laterBtn} onPress={() => go(1)}>
              <Text style={styles.laterText}>{t('onb.loc.later')}</Text>
            </Pressable>
          </>
        )}

        {slide.type === 'account' && (
          <>
            <Pressable style={styles.primaryBtn} onPress={() => finish(true)}>
              <Text style={styles.primaryText}>{t('onb.acct.create')}</Text>
            </Pressable>
            <Pressable hitSlop={10} style={styles.laterBtn} onPress={() => finish(false)}>
              <Text style={styles.laterText}>{t('onb.acct.later')}</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#eef5fc',
    zIndex: 100,
    paddingHorizontal: 28,
  },
  topBar: { height: 32, alignItems: 'flex-end', justifyContent: 'center' },
  skip: { fontSize: 15, fontWeight: '700', color: '#7a8ba0' },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 84, marginBottom: 28 },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0d1b2a',
    textAlign: 'center',
    marginBottom: 14,
  },
  text: {
    fontSize: 16,
    lineHeight: 23,
    color: '#46586a',
    textAlign: 'center',
    maxWidth: 320,
  },
  // interests
  chipScroll: { alignSelf: 'stretch', flexGrow: 0, maxHeight: 340 },
  chipScrollContent: { paddingBottom: 4 },
  section: {
    fontSize: 12,
    fontWeight: '800',
    color: '#7a8ba0',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 10,
    alignSelf: 'center',
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, justifyContent: 'center' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#d5e1ee',
  },
  chipOn: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  chipText: { fontSize: 14, fontWeight: '700', color: '#3a4b5e' },
  chipTextOn: { color: '#fff' },
  // footer
  footer: { alignItems: 'center' },
  dots: { flexDirection: 'row', gap: 7, marginBottom: 22 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotActive: { backgroundColor: '#2f74d6', width: 22 },
  dotIdle: { backgroundColor: '#c3d2e2' },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2f74d6',
    borderRadius: 14,
    paddingVertical: 16,
    width: '100%',
  },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  laterBtn: { paddingVertical: 14, marginTop: 4 },
  laterText: { color: '#7a8ba0', fontSize: 15, fontWeight: '700' },
});
