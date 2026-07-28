// The assistant's home once it stopped being a tab: a launcher that floats over
// every screen, and the sheet it opens.
//
// Three things live here rather than in AssistantThread, and each is the reason
// the thread alone couldn't do this job:
//
// 1. THE CONVERSATION. Turns used to be state inside the thread, so they died
//    whenever you left the Social tab. A launcher that follows you across tabs
//    makes that unacceptable — you ask about a court, tap through to the map, and
//    come back to an empty thread. Host outlives every screen, so the thread reads
//    its turns from props and the conversation survives navigation.
//
// 2. THE LAUNCHER SHAPE. On the map the app already floats five controls (sport
//    dial, two filters, recenter, nav pill), so a sixth full-size button is one
//    too many. There it collapses to a tab on the screen edge; everywhere else,
//    where the only other floating thing is the nav pill, it's a normal FAB.
//
// 3. THE SHEET. Two device-only gotchas apply, both documented in CLAUDE.md and
//    both invisible on web — see SHEET_MAX_HEIGHT and the backdrop below.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../lib/i18n';
import { enabled as assistantEnabled } from '../lib/assistant';
import AssistantThread from './AssistantThread';

// A percent maxHeight is ignored when native Yoga sizes children, and an inline
// or style-array numeric one fails to constrain too. Only a static numeric value
// registered in StyleSheet.create lets the flexShrink:1 ScrollView inside
// actually shrink and scroll on device. Same pattern as CourtDetail's card.
const SHEET_MAX_HEIGHT = Math.round(Dimensions.get('window').height * 0.86);

export default function AssistantHost({
  tab = 'home',
  city = 'sf',
  userLocation = null,
  sport = null,
  openCourt = null, // { id, name } when a court card is showing
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  // Owned here so it survives tab switches; the thread renders from it.
  const [turns, setTurns] = useState([]);
  const slide = useRef(new Animated.Value(0)).current;

  // What the user is looking at, which is what makes "is it open tomorrow?"
  // answerable. Pointers only — the service looks up every fact from the id.
  const context = useMemo(
    () => ({
      screen: openCourt ? 'court' : tab === 'home' ? 'map' : tab,
      ...(openCourt && { courtId: openCourt.id, courtName: openCourt.name }),
      ...(sport && { sport }),
    }),
    [tab, openCourt, sport],
  );

  const show = useCallback(() => {
    setOpen(true);
    slide.setValue(0);
    Animated.spring(slide, { toValue: 1, useNativeDriver: true, bounciness: 2, speed: 16 }).start();
  }, [slide]);

  const hide = useCallback(() => setOpen(false), []);

  if (!assistantEnabled) return null;

  // The map is the crowded screen, so the launcher hides against the edge there.
  const collapsed = tab === 'home' && !openCourt;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <>
      {!open &&
        (collapsed ? (
          <Pressable
            onPress={show}
            style={[styles.edgeTab, { bottom: insets.bottom + 210 }]}
            hitSlop={{ top: 10, bottom: 10, left: 14, right: 6 }}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.open')}
          >
            <Ionicons name="chevron-back" size={13} color="#fff" />
            <Text style={styles.edgeSparkle}>✨</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={show}
            style={[styles.fab, { bottom: insets.bottom + 96 }]}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.open')}
          >
            <Ionicons name="sparkles" size={19} color="#fff" />
          </Pressable>
        ))}

      {/* The zIndex belongs on the overlay wrapper below, not just on the sheet
          inside it. A positioned View with no zIndex forms its own stacking
          context, so the children's 60/61 only order them against each other —
          the wrapper still loses to App's navWrap (50) at the parent level, and
          the nav pill goes on eating taps meant for the composer. */}
      {open && (
        <View style={styles.overlay} pointerEvents="box-none">
          {/* The backdrop is a SIBLING behind the sheet, never a parent wrapping
              it. A Pressable ancestor swallows the ScrollView's pan gesture on
              device and the thread silently stops scrolling. Touches on the sheet
              bubble up the sheet's own branch and never reach this, so it needs
              no empty-onPress guard. */}
          {/* Tappable, but deliberately not announced: the header's ✕ is the
              close control, and labelling the scrim too puts two identical
              "Close the assistant" buttons in the reading order. */}
          <Pressable
            style={styles.backdrop}
            onPress={hide}
            importantForAccessibility="no"
            accessibilityElementsHidden
          />
          <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
            <View style={styles.grabWrap}>
              <View style={styles.grab} />
            </View>
            <View style={styles.sheetHead}>
              <Ionicons name="sparkles" size={15} color="#2f74d6" />
              <Text style={styles.sheetTitle}>{t('assistant.tab')}</Text>
              <Pressable
                onPress={hide}
                style={styles.close}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('assistant.close')}
              >
                <Ionicons name="close" size={17} color="#6b7a8a" />
              </Pressable>
            </View>
            <AssistantThread
              city={city}
              userLocation={userLocation}
              context={context}
              turns={turns}
              onTurnsChange={setTurns}
              embedded
            />
          </Animated.View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  // Flush to the right edge so it reads as something to pull out, and parked
  // well above the nav pill — the middle of the map is where panning happens.
  edgeTab: {
    position: 'absolute',
    right: 0,
    zIndex: 30,
    width: 26,
    height: 52,
    borderTopLeftRadius: 13,
    borderBottomLeftRadius: 13,
    backgroundColor: '#0d1b2a',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: -2, height: 2 },
    elevation: 5,
  },
  edgeSparkle: { fontSize: 11, lineHeight: 13 },
  fab: {
    position: 'absolute',
    right: 14,
    zIndex: 30,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#0d1b2a',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.26,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 60 },
  // Above App's navWrap (zIndex 50). The sheet is modal, so the floating nav
  // pill belongs under the scrim like everything else — left below it, the pill
  // sits on top of the composer and silently eats taps meant for the input.
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(13,27,42,0.34)', zIndex: 60 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 61,
    maxHeight: SHEET_MAX_HEIGHT,
    backgroundColor: '#f4f6f8',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 20,
  },
  grabWrap: { alignItems: 'center', paddingTop: 8 },
  grab: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#d5dce3' },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 15,
    paddingTop: 9,
    paddingBottom: 4,
  },
  sheetTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: '#0d1b2a', letterSpacing: -0.2 },
  close: { padding: 3 },
});
