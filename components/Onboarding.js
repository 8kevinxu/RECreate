// First-launch onboarding: swipeable value-prop slides, then a few setup steps —
// pick the metro, pick interests (sports + class activities), and an optional
// account nudge. Shown once; App.js gates it on the recreate.onboarded.v1 flag.
// onFinish reports the picks/intent back so App.js can persist interests
// (locally, so recs personalize even signed-out) and route to sign-up if asked.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n, sportLabel } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { SPORTS } from '../lib/sports';
import { CITIES } from '../lib/cities';
import { CLASS_CATEGORIES } from '../data/classes';
import AuthModal from './AuthModal';

// Value-prop slides, then the setup steps (each special-cased in render). The
// city step sits at index 1 because everything after it is city-scoped — the
// interests picker offers the active city's playable sports, and before a metro
// is settled that list is whatever DEFAULT_CITY happens to be. It doubles as the
// location ask (there is no separate location slide): the fix answers the city
// question by itself, so asking both would be asking twice.
const SLIDES = [
  { type: 'info', emoji: '🏃', title: 'onb.s1.title', body: 'onb.s1.body' },
  { type: 'city' },
  { type: 'info', emoji: '🗺️', title: 'onb.s2.title', body: 'onb.s2.body' },
  { type: 'info', emoji: '🚦', title: 'onb.s3.title', body: 'onb.s3.body' },
  { type: 'interests' },
  { type: 'account' },
];

// No official feed gives a metro a glyph; these are the two landmarks the cities
// are read by. A city added without one falls back to the generic pin.
const CITY_EMOJI = { sf: '🌉', nyc: '🗽' };

const toggle = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

// `sports` is the active city's playable sports (App.js) — a first-run picker
// shouldn't offer an interest the city around you has nowhere to play. `courts`
// is the whole merged list (every city), used only to count each metro's pins.
export default function Onboarding({
  sports = SPORTS,
  courts = [],
  onFinish,
  onEnableLocation,
  onPickCity,
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [idx, setIdx] = useState(0);
  const [selSports, setSelSports] = useState([]);
  const [selCats, setSelCats] = useState([]);
  const [enabledLoc, setEnabledLoc] = useState(false);
  const [selCity, setSelCity] = useState(null);
  const [locMiss, setLocMiss] = useState(null); // 'nofix' | 'outside' after a failed attempt
  const [authOpen, setAuthOpen] = useState(false); // inline sign-up sheet

  const len = SLIDES.length;
  const slide = SLIDES[idx];

  const go = (dir) => setIdx((i) => Math.max(0, Math.min(len - 1, i + dir)));

  const finish = () =>
    onFinish({
      interests: { sports: selSports, categories: selCats },
      enabledLocation: enabledLoc,
    });

  // Location is the fast path through the city step: a fix names the metro, so a
  // successful one moves on. A denial or a fix outside both metros leaves the
  // user here on purpose — the manual list right below is the answer, and
  // advancing would silently strand them on DEFAULT_CITY.
  const enableLocation = async () => {
    setEnabledLoc(true);
    const res = await onEnableLocation?.();
    if (!res?.located) return setLocMiss('nofix');
    if (!res.city) return setLocMiss('outside');
    setLocMiss(null);
    go(1);
  };

  // A manual pick counts as chosen, so a later fix can't move them off it.
  const chooseCity = () => {
    onPickCity?.(selCity);
    go(1);
  };

  // Pins per metro, for the "765 spots" line — counted rather than curated so it
  // can't drift from the data the map actually renders.
  const cityCounts = useMemo(() => {
    const m = {};
    for (const c of courts) {
      const id = c.city || 'sf';
      m[id] = (m[id] || 0) + 1;
    }
    return m;
  }, [courts]);

  // Distinguish "signed up successfully" from "dismissed the sheet": if the user
  // becomes signed in while onboarding is open, finish and land on the map.
  // Dismissing the sheet without signing in just closes it (handled by onClose).
  const wasSignedIn = useRef(!!user);
  useEffect(() => {
    if (user && !wasSignedIn.current) {
      wasSignedIn.current = true;
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const nSel = selSports.length + selCats.length;

  return (
    <View style={[styles.overlay, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.topBar}>
        {idx > 0 ? (
          <Pressable hitSlop={12} onPress={() => go(-1)}>
            <Ionicons name="chevron-back" size={26} color="#5b7a9a" />
          </Pressable>
        ) : (
          <View style={styles.topSpacer} />
        )}
        {slide.type === 'info' ? (
          <Pressable hitSlop={12} onPress={finish}>
            <Text style={styles.skip}>{t('onb.skip')}</Text>
          </Pressable>
        ) : (
          <View style={styles.topSpacer} />
        )}
      </View>

      {/* ---- slide body ---- */}
      {slide.type === 'info' && (
        <View style={styles.body}>
          <Text style={styles.emoji}>{slide.emoji}</Text>
          <Text style={styles.title}>{t(slide.title)}</Text>
          <Text style={styles.text}>{t(slide.body)}</Text>
        </View>
      )}

      {slide.type === 'city' && (
        <View style={styles.body}>
          <Text style={styles.emoji}>📍</Text>
          <Text style={styles.title}>{t('onb.city.title')}</Text>
          <Text style={[styles.text, { marginBottom: locMiss ? 14 : 28 }]}>{t('onb.city.body')}</Text>
          {!!locMiss && (
            <Text style={styles.locMiss}>
              {t(locMiss === 'outside' ? 'onb.city.outside' : 'onb.city.nofix')}
            </Text>
          )}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>{t('onb.city.or')}</Text>
            <View style={styles.dividerLine} />
          </View>
          <View style={styles.cityWrap}>
            {CITIES.map((c) => {
              const on = selCity === c.id;
              const n = cityCounts[c.id] || 0;
              return (
                <Pressable
                  key={c.id}
                  style={[styles.cityRow, on && styles.cityRowOn]}
                  onPress={() => setSelCity(c.id)}
                >
                  <Text style={styles.cityEmoji}>{CITY_EMOJI[c.id] || '📍'}</Text>
                  <Text style={[styles.cityName, on && styles.cityNameOn]}>{t('city.' + c.id)}</Text>
                  {n > 0 && (
                    <Text style={[styles.cityMeta, on && styles.cityMetaOn]}>
                      {t('onb.city.count', { n })}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
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
              {sports.map((s) => {
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

        {/* Either half of the same question, so the button never dead-ends and
            needs no disabled state. */}
        {slide.type === 'city' && (
          <Pressable style={styles.primaryBtn} onPress={selCity ? chooseCity : enableLocation}>
            {!selCity && <Ionicons name="location" size={18} color="#fff" />}
            <Text style={styles.primaryText}>
              {selCity ? t('onb.continue') : t('onb.city.useLoc')}
            </Text>
          </Pressable>
        )}

        {slide.type === 'interests' && (
          <Pressable style={styles.primaryBtn} onPress={() => go(1)}>
            <Text style={styles.primaryText}>{nSel ? t('onb.continue') : t('onb.skip')}</Text>
          </Pressable>
        )}

        {slide.type === 'account' && (
          <>
            <Pressable style={styles.primaryBtn} onPress={() => setAuthOpen(true)}>
              <Text style={styles.primaryText}>{t('onb.acct.create')}</Text>
            </Pressable>
            <Pressable hitSlop={10} style={styles.laterBtn} onPress={finish}>
              <Text style={styles.laterText}>{t('onb.acct.later')}</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* Inline sign-up — reuses AuthModal (terms/validation). Dismissing the sheet
          only closes it (back to the account slide); a successful sign-up is caught
          by the sign-in effect above, which finishes onboarding onto the map. */}
      {authOpen && <AuthModal visible onClose={() => setAuthOpen(false)} initialMode="signup" />}
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
  topBar: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topSpacer: { width: 26 },
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
  // city
  locMiss: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#46586a',
    textAlign: 'center',
    maxWidth: 320,
    marginBottom: 22,
  },
  divider: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  dividerLine: { flex: 1, height: 1.5, backgroundColor: '#d5e1ee' },
  dividerText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#7a8ba0',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  cityWrap: { alignSelf: 'stretch', gap: 10 },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#d5e1ee',
  },
  cityRowOn: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  cityEmoji: { fontSize: 20 },
  cityName: { fontSize: 15, fontWeight: '700', color: '#3a4b5e' },
  cityNameOn: { color: '#fff' },
  cityMeta: { marginLeft: 'auto', fontSize: 13, fontWeight: '700', color: '#93a5b8' },
  cityMetaOn: { color: 'rgba(255,255,255,0.74)' },
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
