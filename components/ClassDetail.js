// Extended detail sheet for a single class/activity. Opened by tapping a class
// card on the Classes tab or a class recommendation in the Social tab. Shows the
// full structured info we have (schedule, location, cost, ages, availability, the
// catalog blurb) and links out to ActiveNet to register. Free walk-in drop-ins that
// can't be registered online get a notice explaining to just show up at the start time.
import React from 'react';
import {
  Dimensions,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CLASS_CATEGORIES } from '../data/classes';
import { confirmReportData } from '../lib/reports';
import { openDirections } from '../lib/maps';
import { localizeWhen, formatDateRange } from '../lib/datetime';
import { useI18n } from '../lib/i18n';

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};

// How registration works for this activity — the answer to "one session or the
// whole run?". Drop-ins have no series sign-up; a one-day activity is that single
// date; everything else is a course you enroll in for the entire term.
function regModelText(t, c) {
  if (c.dropIn) return t('cls.regDropIn');
  if (c.oneDay) return t('cls.regOneDay');
  if (c.start) return t('cls.regFullSession');
  return null;
}

// Availability line, mirroring the Classes-tab logic (qualitative when uncapped).
function spaceText(t, c) {
  if (c.unlimited) return t('classes.unlimited');
  const n = c.spots;
  if (n == null) return c.dropIn ? t('classes.lotsSpots') : null;
  if (n <= 0) return t('classes.full');
  if (n <= 5) return t('classes.left', { n });
  // SF ActiveNet reports big numbers → collapse to "lots"; NYC Parks reports a
  // real small capacity → show the exact count the user can act on.
  if (n >= 20 && c.source !== 'nycparks') return t('classes.lotsSpots');
  return t('classes.openings', { n });
}

function Row({ icon, label, value }) {
  if (!value) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

export default function ClassDetail({ item, onClose }) {
  const insets = useSafeAreaInsets();
  const { t, lang } = useI18n();
  if (!item) return null;
  const c = item;
  const meta = catMeta(c.category);
  const name = c['name_' + lang] || c.name;
  const spots = spaceText(t, c);
  const dates = formatDateRange(c.start, c.end);
  const regModel = regModelText(t, c);

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/* The tap-to-close backdrop is a SIBLING stacked behind the sheet, not a
          wrapper around it: a Pressable ancestor swallows the ScrollView's pan
          gesture on device (new-arch RN), freezing the sheet's scroll. Touches
          on the sheet bubble up the sheet's own branch and never reach the
          sibling Pressable, so no empty-onPress guard is needed either. */}
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('a11y.close')}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={styles.handle} />
          {/* The sheet's maxHeight is a STATIC NUMERIC value in StyleSheet.create
              (Dimensions-based, like CourtDetail's card — the one sheet proven to
              scroll on device): native Yoga does not shrink flex children to a
              parent's *percent* maxHeight, and an inline/array maxHeight also
              failed to constrain on device — only this static registered form has
              worked. The flexShrink ScrollView then shrinks to the remaining space
              and scrolls; the pinned Directions/Register buttons live OUTSIDE the
              scroll area so they're always tappable no matter the content length. */}
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={styles.emoji}>{meta.emoji || '✨'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{name}</Text>
                {!!meta.id && (
                  <Text style={styles.category}>
                    {t('cat.' + meta.id)}
                    {(c.tags || []).length
                      ? ' · ' + c.tags.map((tg) => t('cat.' + tg)).join(' · ')
                      : ''}
                  </Text>
                )}
              </View>
              <View style={[styles.tag, c.dropIn ? styles.tagDropIn : styles.tagReg]}>
                <Text style={[styles.tagText, c.dropIn ? styles.tagDropInText : styles.tagRegText]}>
                  {c.dropIn ? t('classes.dropIn') : t('classes.register')}
                </Text>
              </View>
            </View>

            <View style={styles.rows}>
              <Row icon="🕒" label={t('cls.schedule')} value={localizeWhen(c.when)} />
              <Row icon="🗓️" label={t(c.oneDay ? 'cls.date' : 'cls.dates')} value={dates} />
              <Row icon="📍" label={t('cls.location')} value={c.location} />
              <Row icon="💵" label={t('cls.cost')} value={c.cost} />
              <Row icon="🎂" label={t('cls.ages')} value={c.ages} />
              <Row icon="🧑‍🏫" label={t('cls.instructor')} value={c.instructor} />
              <Row icon="🎟️" label={t('cls.availability')} value={spots} />
              <Row
                icon="🔁"
                label={t('cls.sessions')}
                value={
                  c.sessions
                    ? t('cls.sessionsVal', {
                        count: c.sessions.count,
                        first: c.sessions.first,
                        last: c.sessions.last,
                      })
                    : ''
                }
              />
              <Row icon="⏳" label={t('cls.regDeadline')} value={c.regDeadline} />
              <Row icon="📝" label={t('cls.about')} value={c.desc || t('cls.noDesc')} />
            </View>

            {regModel && (
              <View style={styles.regInfo}>
                <Text style={styles.regInfoIcon}>🎟️</Text>
                <Text style={styles.regInfoText}>{regModel}</Text>
              </View>
            )}

            {c.noOnlineReg && (
              <View style={styles.notice}>
                <Text style={styles.noticeIcon}>ℹ️</Text>
                <Text style={styles.noticeText}>{t('cls.noOnlineReg')}</Text>
              </View>
            )}

            {/* "This data looks wrong" flag, same flow as the court/pool cards. */}
            <Pressable
              onPress={() => confirmReportData(`class:${c.id}`)}
              accessibilityRole="button"
              accessibilityLabel={t('report.classInfo')}
            >
              <Text style={styles.reportLink}>{t('report.classInfo')}</Text>
            </Pressable>
          </ScrollView>

          {c.lat != null && (
            <Pressable style={styles.dirBtn} onPress={() => openDirections(c.lat, c.lng, c.location)}>
              <Ionicons name="navigate" size={15} color="#2f74d6" />
              <Text style={styles.dirBtnText}>{t('directions')}</Text>
            </Pressable>
          )}

          {!!c.url && (
            <Pressable style={styles.cta} onPress={() => Linking.openURL(c.url).catch(() => {})}>
              <Text style={styles.ctaText}>
                {c.noOnlineReg
                  ? t('cls.viewOnSite')
                  : t(c.source === 'nycparks' ? 'cls.registerNyc' : 'cls.register')}
              </Text>
              <Ionicons name="open-outline" size={16} color="#fff" />
            </Pressable>
          )}
          <Text style={styles.note}>
            {t(c.source === 'nycparks' ? 'cls.nycNote' : 'cls.activeNetNote')}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    // Static numeric cap — see the Yoga note in the component. A percent here
    // (or an inline maxHeight) breaks native scrolling.
    maxHeight: Dimensions.get('window').height * 0.85,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d3dbe3',
    alignSelf: 'center',
    marginBottom: 14,
  },
  scroll: { flexGrow: 0, flexShrink: 1, marginBottom: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 18 },
  emoji: { fontSize: 34 },
  name: { fontSize: 20, fontWeight: '800', color: '#0d1b2a' },
  category: { fontSize: 13, color: '#6b7a8a', fontWeight: '600', marginTop: 2 },
  tag: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  tagDropIn: { backgroundColor: '#e3f3ea' },
  tagReg: { backgroundColor: '#eef1f5' },
  tagText: { fontSize: 11, fontWeight: '800' },
  tagDropInText: { color: '#1f9d55' },
  tagRegText: { color: '#5b6b7b' },
  rows: { gap: 14, marginBottom: 18 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  rowText: { flex: 1 },
  rowLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#8a99a8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  rowValue: { fontSize: 15, color: '#1d2b3a', fontWeight: '600', marginTop: 2 },
  regInfo: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#eaf2fb',
    borderWidth: 1,
    borderColor: '#cfe0f5',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  regInfoIcon: { fontSize: 15, marginTop: 1 },
  regInfoText: { flex: 1, fontSize: 13, color: '#2b5178', fontWeight: '600', lineHeight: 18 },
  notice: {
    flexDirection: 'row',
    gap: 8,
    backgroundColor: '#fef6e6',
    borderWidth: 1,
    borderColor: '#f2d999',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  noticeIcon: { fontSize: 15, marginTop: 1 },
  noticeText: { flex: 1, fontSize: 13, color: '#7a5a12', fontWeight: '600', lineHeight: 18 },
  dirBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#cfe0f5',
    borderRadius: 12,
    paddingVertical: 11,
    marginBottom: 10,
  },
  dirBtnText: { color: '#2f74d6', fontWeight: '700', fontSize: 14 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#1f9d55',
    borderRadius: 12,
    paddingVertical: 14,
  },
  ctaText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  note: { fontSize: 11, color: '#9fb0c2', textAlign: 'center', marginTop: 10 },
  reportLink: { fontSize: 11, color: '#9aa7b4', fontWeight: '700', marginTop: 12 },
});
