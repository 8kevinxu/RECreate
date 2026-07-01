// Extended detail sheet for a single class/activity. Opened by tapping a class
// card on the Classes tab or a class recommendation in the Social tab. Shows the
// full structured info we have (schedule, location, cost, ages, availability, the
// catalog blurb) and links out to ActiveNet to register. Free walk-in drop-ins that
// can't be registered online get a notice explaining to just show up at the start time.
import React from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CLASS_CATEGORIES } from '../data/classes';
import { openDirections } from '../lib/maps';
import { localizeWhen } from '../lib/datetime';
import { useI18n } from '../lib/i18n';

const catMeta = (id) => CLASS_CATEGORIES.find((c) => c.id === id) || {};

// Availability line, mirroring the Classes-tab logic (qualitative when uncapped).
function spaceText(t, c) {
  if (c.unlimited) return t('classes.unlimited');
  const n = c.spots;
  if (n == null) return c.dropIn ? t('classes.lotsSpots') : null;
  if (n <= 0) return t('classes.full');
  if (n <= 5) return t('classes.left', { n });
  if (n >= 20) return t('classes.lotsSpots');
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

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={styles.emoji}>{meta.emoji || '✨'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{name}</Text>
                {!!meta.id && (
                  <Text style={styles.category}>{t('cat.' + meta.id)}</Text>
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
              <Row icon="📍" label={t('cls.location')} value={c.location} />
              <Row icon="💵" label={t('cls.cost')} value={c.cost} />
              <Row icon="🎂" label={t('cls.ages')} value={c.ages} />
              <Row icon="🎟️" label={t('cls.availability')} value={spots} />
              <Row icon="📝" label={t('cls.about')} value={c.desc || t('cls.noDesc')} />
            </View>

            {c.noOnlineReg && (
              <View style={styles.notice}>
                <Text style={styles.noticeIcon}>ℹ️</Text>
                <Text style={styles.noticeText}>{t('cls.noOnlineReg')}</Text>
              </View>
            )}

            {c.lat != null && (
              <Pressable style={styles.dirBtn} onPress={() => openDirections(c.lat, c.lng, c.location)}>
                <Ionicons name="navigate" size={15} color="#2f74d6" />
                <Text style={styles.dirBtnText}>{t('directions')}</Text>
              </Pressable>
            )}

            {!!c.url && (
              <Pressable style={styles.cta} onPress={() => Linking.openURL(c.url).catch(() => {})}>
                <Text style={styles.ctaText}>{c.noOnlineReg ? t('cls.viewOnSite') : t('cls.register')}</Text>
                <Ionicons name="open-outline" size={16} color="#fff" />
              </Pressable>
            )}
            <Text style={styles.note}>{t('cls.activeNetNote')}</Text>
          </ScrollView>
        </Pressable>
      </Pressable>
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
    maxHeight: '85%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d3dbe3',
    alignSelf: 'center',
    marginBottom: 14,
  },
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
});
