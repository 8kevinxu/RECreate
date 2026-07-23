// The full pool view rendered inside the court card when a "swimming" court
// carries a `pool` block (see lib/poolCourts.js): the weekly schedule (colored
// session pills, warm/cool groups for North Beach), the pool's blurb, a
// collapsible fee table, and links to the official schedule PDF(s). Extracted
// from the old PoolsScreen so pools keep their rich detail on the map.
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { POOL_FEES } from '../data/pools';
import { confirmReportData } from '../lib/reports';
import { fmtClock } from '../lib/datetime';
import { useI18n } from '../lib/i18n';

const DOW_KEYS = ['day.0', 'day.1', 'day.2', 'day.3', 'day.4', 'day.5', 'day.6'];
const KIND_TONE = {
  lap: { bg: '#e3effb', fg: '#1f5fa8' },
  family: { bg: '#e7f5ec', fg: '#1f8a4c' },
  senior: { bg: '#f3ecfb', fg: '#6b3fa0' },
  lessons: { bg: '#fdf2e0', fg: '#b56a14' },
  adult_lessons: { bg: '#fdf2e0', fg: '#b56a14' },
  parent_child: { bg: '#fde9f1', fg: '#b03a73' },
  exercise: { bg: '#e0f5f3', fg: '#1f8a86' },
  camp: { bg: '#eef1f4', fg: '#5b6b7b' },
  rental: { bg: '#eef1f4', fg: '#5b6b7b' },
  other: { bg: '#eef1f4', fg: '#5b6b7b' },
};
const tone = (k) => KIND_TONE[k] || KIND_TONE.other;
const fmtMin = (m) => fmtClock(Math.floor(m / 60), m % 60);

// North Beach has warm + cool pools under one roof; its sessions carry
// pool: "warm" | "cool". Single-pool facilities yield one anonymous group.
const POOL_TAGS = ['warm', 'cool'];
const groupByPool = (sessions) => {
  if (!sessions.some((s) => s.pool)) return [[null, sessions]];
  const groups = [];
  const untagged = sessions.filter((s) => !s.pool);
  if (untagged.length) groups.push([null, untagged]);
  for (const p of POOL_TAGS) {
    const g = sessions.filter((s) => s.pool === p);
    if (g.length) groups.push([p, g]);
  }
  return groups;
};

function SessionPills({ sessions, t }) {
  return groupByPool(sessions).map(([pool, group]) => (
    <View key={pool || 'all'}>
      {!!pool && <Text style={styles.poolTag}>{t('pool.' + pool + 'Pool')}</Text>}
      <View style={styles.sessRow}>
        {group.map((s, i) => (
          <View key={i} style={[styles.sess, { backgroundColor: tone(s.kind).bg }]}>
            <Text style={[styles.sessKind, { color: tone(s.kind).fg }]}>{t('pool.kind.' + s.kind)}</Text>
            <Text style={[styles.sessTime, { color: tone(s.kind).fg }]}>
              {fmtMin(s.start)}–{fmtMin(s.end)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  ));
}

export default function PoolDetail({ pool, poolId }) {
  const { t } = useI18n();
  const [showFees, setShowFees] = useState(false);
  const sessions = pool.sessions || [];

  return (
    <View style={styles.wrap}>
      {!!pool.season && <Text style={styles.season}>🗓 {pool.season}</Text>}

      {sessions.map((day, i) =>
        day && day.length ? (
          <View key={i} style={styles.weekDay}>
            <Text style={styles.weekDow}>{t(DOW_KEYS[i])}</Text>
            <SessionPills sessions={day} t={t} />
          </View>
        ) : null
      )}

      {!!pool.desc && <Text style={styles.desc}>{pool.desc}</Text>}

      <Pressable style={styles.feesToggle} onPress={() => setShowFees((v) => !v)}>
        <Ionicons name={showFees ? 'chevron-up' : 'cash-outline'} size={15} color="#2f74d6" />
        <Text style={styles.feesToggleText}>{t('pools.feesTitle')}</Text>
      </Pressable>
      {showFees && (
        <View>
          <Text style={styles.feesEffective}>{t('pools.feesEffective', { date: POOL_FEES.effective })}</Text>
          {POOL_FEES.groups.map((g) => (
            <View key={g.id} style={styles.feeGroup}>
              <View style={styles.feeGroupHead}>
                <Text style={styles.feeGroupLabel}>{g.label}</Text>
                <Text style={styles.feeDropIn}>{t('pools.dropInPrice', { price: g.dropIn })}</Text>
              </View>
              {g.passes.map(([label, price], i) => (
                <View key={i} style={styles.feeRow}>
                  <Text style={styles.feeLabel}>{label}</Text>
                  <Text style={styles.feePrice}>${price}</Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      )}

      <View style={styles.pdfRow}>
        {(pool.scheduleUrls || []).map((u, i) => (
          <Pressable key={i} style={styles.pdfBtn} onPress={() => Linking.openURL(u.url)}>
            <Ionicons name="document-text-outline" size={12} color="#46586a" />
            <Text style={styles.pdfText}>
              {pool.scheduleUrls.length > 1 && /warm/i.test(u.label)
                ? t('pool.pdfWarm')
                : pool.scheduleUrls.length > 1 && /cool/i.test(u.label)
                ? t('pool.pdfCool')
                : t('pool.pdf')}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={() => confirmReportData(`pool:${poolId}`)}
        accessibilityRole="button"
        accessibilityLabel={t('report.schedule')}
      >
        <Text style={styles.reportLink}>{t('report.schedule')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 6 },
  season: { fontSize: 12, color: '#6b7a8a', fontWeight: '600', marginBottom: 2 },
  weekDay: { marginTop: 10 },
  weekDow: { fontSize: 12, fontWeight: '800', color: '#0d1b2a', marginBottom: 5 },
  sessRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sess: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  sessKind: { fontSize: 12, fontWeight: '800' },
  sessTime: { fontSize: 11, fontWeight: '600', marginTop: 1 },
  poolTag: { fontSize: 11, fontWeight: '800', color: '#46586a', marginTop: 6, marginBottom: 4 },
  desc: { fontSize: 12, color: '#46586a', marginTop: 10, lineHeight: 17 },

  feesToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 12 },
  feesToggleText: { color: '#2f74d6', fontWeight: '800', fontSize: 13 },
  feesEffective: { fontSize: 11, color: '#9aa7b4', marginTop: 4, marginBottom: 2 },
  feeGroup: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#eef1f4', paddingTop: 10 },
  feeGroupHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  feeGroupLabel: { fontSize: 14, fontWeight: '800', color: '#0d1b2a' },
  feeDropIn: { fontSize: 13, fontWeight: '800', color: '#1f8a4c' },
  feeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  feeLabel: { fontSize: 13, color: '#46586a' },
  feePrice: { fontSize: 13, fontWeight: '700', color: '#0d1b2a' },

  pdfRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  pdfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#f1f4f7',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pdfText: { color: '#46586a', fontWeight: '700', fontSize: 12 },
  reportLink: { fontSize: 11, color: '#9aa7b4', fontWeight: '700', marginTop: 12 },
});
