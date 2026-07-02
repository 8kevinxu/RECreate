// First-launch onboarding: a few swipeable slides explaining what RECreate does,
// ending on a location-permission primer so the OS prompt appears in context
// (right after the user taps "Enable location") instead of cold on app open.
// Shown once — App.js gates it on an AsyncStorage flag and calls onFinish with
// whether the user opted into location.
import React, { useMemo, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';

const SWIPE_MIN = 40; // horizontal px to count a swipe as prev/next

// Four value-prop slides, then the location primer (special-cased in render).
const SLIDES = [
  { emoji: '🏃', title: 'onb.s1.title', body: 'onb.s1.body' },
  { emoji: '🗺️', title: 'onb.s2.title', body: 'onb.s2.body' },
  { emoji: '🚦', title: 'onb.s3.title', body: 'onb.s3.body' },
  { emoji: '🤝', title: 'onb.s4.title', body: 'onb.s4.body' },
  { emoji: '📍', title: 'onb.loc.title', body: 'onb.loc.body', location: true },
];

export default function Onboarding({ onFinish }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [idx, setIdx] = useState(0);
  const len = SLIDES.length;
  const slide = SLIDES[idx];
  const isLast = idx === len - 1;

  const go = (dir) => setIdx((i) => Math.max(0, Math.min(len - 1, i + dir)));

  // Horizontal swipe → prev/next (a near-stationary touch stays a tap).
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

  return (
    <View style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.topBar}>
        {!isLast && (
          <Pressable hitSlop={12} onPress={() => onFinish(false)}>
            <Text style={styles.skip}>{t('onb.skip')}</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.body} {...panResponder.panHandlers}>
        <Text style={styles.emoji}>{slide.emoji}</Text>
        <Text style={styles.title}>{t(slide.title)}</Text>
        <Text style={styles.text}>{t(slide.body)}</Text>
      </View>

      <View style={styles.footer}>
        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.dot, i === idx ? styles.dotActive : styles.dotIdle]} />
          ))}
        </View>

        {slide.location ? (
          <>
            <Pressable style={styles.primaryBtn} onPress={() => onFinish(true)}>
              <Ionicons name="location" size={18} color="#fff" />
              <Text style={styles.primaryText}>{t('onb.loc.enable')}</Text>
            </Pressable>
            <Pressable hitSlop={10} style={styles.laterBtn} onPress={() => onFinish(false)}>
              <Text style={styles.laterText}>{t('onb.loc.later')}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable style={styles.primaryBtn} onPress={() => go(1)}>
            <Text style={styles.primaryText}>{t('onb.next')}</Text>
          </Pressable>
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
