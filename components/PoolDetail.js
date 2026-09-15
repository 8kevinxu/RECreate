// The pool view inside the court card when a "swimming" court carries a `pool`
// block (see lib/poolCourts.js), split to match every other sport's card:
// `PoolPeek` is what shows on tap (a closure notice, and which sessions are on
// right now), and `PoolDetail` is the "Schedule & reviews" body — the weekly
// schedule as colored session pills starting from the viewed day (warm/cool
// groups for North Beach), the pool's blurb, a collapsible fee table, and links
// to the official schedule PDF(s). The session pills REPLACE the card's generic
// week rows for pools: those come from dropins.swimming, which flattens the
// public-swim sessions into bare time ranges and drops lessons, so showing both
// put two schedules on one card that could disagree.
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
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

// Sessions that say nothing to someone deciding whether to go now: a private
// rental, a camp, or an unclassified PDF cell. Lessons stay — they occupy lanes.
const NOW_HIDDEN = new Set(['rental', 'camp', 'other']);

// The tap-state lines. For a pool, *which* session is on matters more than
// open/closed (a lap swimmer arriving during Parent & Tot is turned away), so
// the peek names it: sessions on at `date`, else the next start later that day.
// Nothing when the day is done — the status badge already says when it's next.
export function PoolPeek({ pool, date, isPicked }) {
  const { t } = useI18n();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const day = ((pool.sessions && pool.sessions[date.getDay()]) || []).filter(
    (s) => !NOW_HIDDEN.has(s.kind)
  );
  const active = day.filter((s) => nowMin >= s.start && nowMin < s.end);
  const nextStart = Math.min(...day.filter((s) => s.start > nowMin).map((s) => s.start));
  const items = active.length ? active : day.filter((s) => s.start === nextStart);

  // One pill per kind (two back-to-back lap blocks are one "Lap Swim").
  const seen = new Set();
  const pills = items.filter((s) => !seen.has(s.kind) && seen.add(s.kind));
  // Share one trailing "until" only when every session ends together — a single
  // time beside Lap Swim and Rec / Family that end at different times would be
  // wrong for one of them.
  const sharedEnd = new Set(pills.map((s) => s.end)).size === 1;

  return (
    <>
      {/* NYC Parks' own explanation when a pool publishes no sessions — e.g.
          "closed for reconstruction". On the peek, not behind the toggle,
          because it's the reason the badge beside it says closed. */}
      {!!pool.notice && <Text style={styles.notice}>ⓘ {pool.notice}</Text>}
      {pills.length > 0 && (
        <View style={styles.nowRow}>
          <Text style={styles.nowText}>
            {active.length
              ? isPicked
                ? t('pool.atLabel', { t: fmtMin(nowMin) })
                : t('pool.nowLabel')
              : t(isPicked ? 'pool.later' : 'pool.laterToday')}
          </Text>
          {pills.map((s) => (
            <View key={s.kind} style={[styles.nowPill, { backgroundColor: tone(s.kind).bg }]}>
              <Text style={[styles.nowPillText, { color: tone(s.kind).fg }]}>
                {t('pool.kind.' + s.kind)}
                {active.length && !sharedEnd ? ' · ' + t('pool.until', { t: fmtMin(s.end) }) : ''}
              </Text>
            </View>
          ))}
          <Text style={styles.nowText}>
            {!active.length
              ? t('pool.startsAt', { t: fmtMin(nextStart) })
              : sharedEnd
              ? t('pool.until', { t: fmtMin(pills[0].end) })
              : ''}
          </Text>
        </View>
      )}
    </>
  );
}

// `date` is the viewed moment (a picked time, or now): the week starts on its
// day, since the question is what's coming up, not what happened on Sunday.
export default function PoolDetail({ pool, date = new Date() }) {
  const { t } = useI18n();
  const [showFees, setShowFees] = useState(false);
  const sessions = pool.sessions || [];
  const startDay = date.getDay();
  const todayDay = new Date().getDay();
  // Fees ride on the pool (lib/poolCourts.js): SF charges per visit, NYC's
  // outdoor pools are free and its indoor ones need a rec-center membership.
  const fees = pool.fees || { effective: '', groups: [] };

  return (
    <View style={styles.wrap}>
      {!!pool.season && <Text style={styles.season}>🗓 {pool.season}</Text>}

      {[0, 1, 2, 3, 4, 5, 6].map((offset) => {
        const i = (startDay + offset) % 7;
        const day = sessions[i];
        const isToday = i === todayDay && offset === 0;
        return day && day.length ? (
          <View key={i} style={styles.weekDay}>
            <View style={styles.weekDowRow}>
              <Text style={[styles.weekDow, isToday && styles.weekDowToday]}>{t(DOW_KEYS[i])}</Text>
              {isToday && <Text style={styles.todayChip}>{t('pool.today')}</Text>}
            </View>
            <SessionPills sessions={day} t={t} />
          </View>
        ) : null;
      })}

      {!!pool.desc && <Text style={styles.desc}>{pool.desc}</Text>}

      <Pressable style={styles.feesToggle} onPress={() => setShowFees((v) => !v)}>
        <Ionicons name={showFees ? 'chevron-up' : 'cash-outline'} size={15} color="#2f74d6" />
        <Text style={styles.feesToggleText}>{t('pools.feesTitle')}</Text>
      </Pressable>
      {showFees && (
        <View>
          <Text style={styles.feesEffective}>{t('pools.feesEffective', { date: fees.effective })}</Text>
          {fees.groups.map((g) => (
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 6 },
  season: { fontSize: 12, color: '#6b7a8a', fontWeight: '600', marginBottom: 2 },
  weekDay: { marginTop: 10 },
  weekDowRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  weekDow: { fontSize: 12, fontWeight: '800', color: '#0d1b2a' },
  weekDowToday: { color: '#2f74d6' },
  todayChip: {
    fontSize: 10,
    fontWeight: '800',
    color: '#2f74d6',
    backgroundColor: '#e7f0fc',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  nowRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2, marginBottom: 4 },
  nowText: { fontSize: 12, color: '#46586a', fontWeight: '600' },
  nowPill: { borderRadius: 7, paddingHorizontal: 7, paddingVertical: 3 },
  nowPillText: { fontSize: 11.5, fontWeight: '800' },
  sessRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sess: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  sessKind: { fontSize: 12, fontWeight: '800' },
  sessTime: { fontSize: 11, fontWeight: '600', marginTop: 1 },
  poolTag: { fontSize: 11, fontWeight: '800', color: '#46586a', marginTop: 6, marginBottom: 4 },
  desc: { fontSize: 12, color: '#46586a', marginTop: 10, lineHeight: 17 },
  notice: { fontSize: 12, color: '#8a5a1b', marginTop: 2, marginBottom: 4, lineHeight: 17 },

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
});
