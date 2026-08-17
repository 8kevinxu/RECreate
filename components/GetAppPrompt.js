// The web build's install prompt, in two forms that are really one decision:
// "can this person install the app right now?"
//
//   surface 'bar' — a mobile browser that CAN install but shows no smart banner
//                   (iOS Chrome/Firefox/Edge). A slim dismissible strip above
//                   the floating nav, shaped like App.js's location banner so it
//                   reads as app chrome rather than an ad.
//   surface 'qr'  — a desktop browser, which cannot install anything. A "Download
//                   for iPhone" button there asks someone to remember a chore; a
//                   QR closes the loop with the phone already in their hand.
//                   components/QRCode.js already renders one with no native
//                   module and no new dependency (friend invites use it).
//
// Eligibility, timing and the dismissal ledger all live in lib/getApp.web.js —
// this file only draws what that decided. On native the hook returns null, so
// this component renders nothing and costs one comparison.
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../lib/i18n';
import { APP_STORE_URL } from '../lib/getApp';
import QRCode from './QRCode';

// App.js reads this to lift the floating nav and the recenter button clear of
// the bar — exported so the two numbers can never drift apart.
export const GET_APP_BAR_H = 60;

export default function GetAppPrompt({ surface, onDismiss, bottomInset = 0 }) {
  const { t } = useI18n();
  if (!surface) return null;

  const open = () => {
    Linking.openURL(APP_STORE_URL).catch(() => {});
    onDismiss?.(); // they acted on it; don't ask this browser again
  };

  if (surface === 'qr') {
    return (
      <View style={styles.card}>
        <Pressable
          style={styles.cardClose}
          onPress={onDismiss}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.dismiss')}
        >
          <Ionicons name="close" size={16} color="#9aa7b4" />
        </Pressable>
        <Text style={styles.cardTitle}>{t('getapp.qrTitle')}</Text>
        <Text style={styles.cardBody}>{t('getapp.qrBody')}</Text>
        <QRCode value={APP_STORE_URL} size={132} accessibilityLabel={t('getapp.qrScan')} />
        <Text style={styles.cardFoot}>{t('getapp.free')}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.bar, { bottom: Math.max(bottomInset, 8) }]}>
      <Text style={styles.barIcon}>🏀</Text>
      <Text style={styles.barText} numberOfLines={2}>
        {t('getapp.barText')}
      </Text>
      <Pressable style={styles.barCta} onPress={open} accessibilityRole="button">
        <Text style={styles.barCtaText}>{t('getapp.cta')}</Text>
      </Pressable>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('a11y.dismiss')}
      >
        <Ionicons name="close" size={17} color="#7d8d9d" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // Sits directly above BottomNav's floating pill. App.js pushes the nav and the
  // recenter button up by GET_APP_BAR_H while this is mounted, so nothing here
  // needs to dodge them.
  bar: {
    position: 'absolute',
    left: 14,
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0d1b2a',
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: 14,
    // Under App.js's navWrap (50) — the two never overlap, and losing to the
    // nav is the right outcome if a future layout change makes them.
    zIndex: 45,
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  barIcon: { fontSize: 19 },
  barText: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '600', lineHeight: 17 },
  barCta: {
    backgroundColor: '#e8730c',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  barCtaText: { color: '#fff', fontSize: 12.5, fontWeight: '800' },

  card: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 272,
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    zIndex: 45,
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardClose: { position: 'absolute', top: 10, right: 12, zIndex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '800', color: '#0d1b2a' },
  cardBody: {
    fontSize: 12.5,
    lineHeight: 17,
    color: '#46586a',
    textAlign: 'center',
    paddingHorizontal: 4,
  },
  cardFoot: { fontSize: 11, fontWeight: '700', color: '#9aa7b4', letterSpacing: 0.4 },
});
