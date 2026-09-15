// The court card's player-reported closure banner (lib/closures.js). Soft by
// design: it says who reported what and asks everyone else to back it up or
// call it wrong. The schedule badges below it keep saying what the city posts.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '../lib/i18n';
import { timeAgo } from '../lib/crowd';
import { dayChipLabel, dayDelta } from '../lib/datetime';
import { parseYmd } from '../lib/closures';

function titleKey(c) {
  if (c.disputed) return 'closure.disputed';
  const fac = c.sport == null;
  if (c.kind === 'maintenance') return fac ? 'closure.facMaintenance' : 'closure.maintenance';
  if (c.kind === 'partial') return fac ? 'closure.facPartial' : 'closure.partial';
  return fac ? 'closure.facClosed' : 'closure.closed';
}

export default function ClosureBanner({
  closure: c,
  now,
  busy,
  onVote,
  onRemove,
  onReportNote,
  signedIn = true,
  onNeedSignIn,
}) {
  const { t } = useI18n();
  const grey = c.disputed;

  const untilLabel = c.until
    ? dayDelta(parseYmd(c.until)) === 0
      ? t('closure.untilToday')
      : t('closure.until', { date: dayChipLabel(parseYmd(c.until)) })
    : t('closure.noDate');
  const meta = c.disputed
    ? [t('closure.split', { up: c.supporters, down: c.refuters }), timeAgo(c.confirmedAt, now)]
    : [
        untilLabel,
        t(c.supporters === 1 ? 'closure.playersOne' : 'closure.playersMany', { n: c.supporters }),
        timeAgo(c.confirmedAt, now),
      ];

  // Undated and unconfirmed for 3+ days: the question replaces the assertion.
  // An old "support" doesn't count as an answer to it — that's what went stale.
  const shownVote = c.stale && c.myVote === 1 ? 0 : c.myVote;
  const yesLabel = c.stale
    ? t('closure.yesStill')
    : shownVote === 1
    ? t('closure.supported')
    : t('closure.support');
  const noLabel = c.stale ? t('closure.noOpen') : t('closure.incorrect');
  const tap = (v) => onVote(shownVote === v ? 0 : v);

  const voteBtn = (v, label) => {
    const on = shownVote === v;
    const color = v === 1 ? '#1f9d55' : '#e23b3b';
    return (
      <Pressable
        key={v}
        disabled={busy}
        onPress={() => tap(v)}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        style={[
          styles.btn,
          grey ? styles.btnGrey : styles.btnAmber,
          on && { backgroundColor: color, borderColor: color },
          busy && styles.btnBusy,
        ]}
      >
        <Ionicons name={v === 1 ? 'checkmark' : 'close'} size={15} color={on ? '#fff' : color} />
        <Text style={[styles.btnText, on && styles.btnTextOn]}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.box, grey ? styles.boxGrey : styles.boxAmber]}>
      <View style={styles.head}>
        <Ionicons
          name="warning-outline"
          size={18}
          color={grey ? '#9aa7b4' : '#d08a0a'}
          style={styles.icon}
        />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, grey && styles.titleGrey]}>{t(titleKey(c))}</Text>
          <Text style={[styles.meta, grey && styles.metaGrey]}>{meta.join(' · ')}</Text>
          {!!c.note && (
            <Text style={[styles.note, grey && styles.noteGrey]}>“{c.note}”</Text>
          )}
          {!!c.note && !c.mine && (
            <Pressable hitSlop={6} onPress={onReportNote} accessibilityRole="button">
              <Text style={styles.reportNote}>{t('closure.reportNote')}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {!signedIn ? (
        // Voting needs an account (every tally counts people), so signed out the
        // buttons become a row that says so before anyone taps a dead button.
        // The "Reported…" title still carries that this is only a report.
        <Pressable
          onPress={onNeedSignIn}
          accessibilityRole="button"
          style={[styles.signIn, grey ? styles.btnGrey : styles.btnAmber]}
        >
          <Ionicons name="lock-closed-outline" size={14} color={grey ? '#6b7a8a' : '#7a6a55'} />
          <Text style={[styles.signInText, grey && styles.metaGrey]}>
            {t(c.stale ? (c.kind === 'maintenance' ? 'closure.stillMaint' : 'closure.stillClosed') : 'closure.signInToVote')}
          </Text>
          <Text style={styles.signInCta}>{t('auth.signIn')} ›</Text>
        </Pressable>
      ) : c.mine ? (
        <View style={styles.mineRow}>
          <Text style={[styles.mineText, grey && styles.metaGrey]}>{t('closure.mine')}</Text>
          <Pressable hitSlop={8} disabled={busy} onPress={onRemove} accessibilityRole="button">
            <Text style={styles.remove}>{t('closure.remove')}</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {c.stale ? (
            <Text style={[styles.prompt, grey && styles.titleGrey]}>
              {t(c.kind === 'maintenance' ? 'closure.stillMaint' : 'closure.stillClosed')}
            </Text>
          ) : (
            <View style={{ height: 10 }} />
          )}
          <View style={styles.btnRow}>
            {voteBtn(1, yesLabel)}
            {voteBtn(-1, noLabel)}
          </View>
          {shownVote !== 0 && (
            <Text style={[styles.hint, grey && styles.metaGrey]}>{t('closure.voteHint')}</Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 12, borderRadius: 12, padding: 10 },
  // Amber borrows the booked-low badge's fill; disputed drops to the crowd box's
  // grey so it stops reading as a warning without disappearing.
  boxAmber: { backgroundColor: '#fdf1d6' },
  boxGrey: { backgroundColor: '#f4f6f8' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  icon: { marginTop: 1 },
  title: { fontSize: 14, fontWeight: '800', color: '#6b4300', lineHeight: 19 },
  titleGrey: { color: '#46586a' },
  meta: { fontSize: 12, color: '#7a6a55', marginTop: 2, lineHeight: 16 },
  metaGrey: { color: '#6b7a8a' },
  note: { fontSize: 12.5, color: '#5f5140', marginTop: 6, lineHeight: 17, fontStyle: 'italic' },
  noteGrey: { color: '#5b6b7b' },
  reportNote: { fontSize: 11, color: '#a89a86', fontWeight: '700', marginTop: 3 },
  prompt: { fontSize: 12, fontWeight: '700', color: '#6b4300', marginTop: 10, marginBottom: 6 },
  btnRow: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1.5,
    backgroundColor: '#fff',
  },
  btnAmber: { borderColor: '#efd9a6' },
  btnGrey: { borderColor: '#d4dbe2' },
  btnBusy: { opacity: 0.6 },
  btnText: { fontSize: 13, fontWeight: '700', color: '#46586a' },
  btnTextOn: { color: '#fff' },
  hint: { fontSize: 11, color: '#7a6a55', marginTop: 7, fontStyle: 'italic' },
  signIn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1.5,
    backgroundColor: '#fff',
  },
  signInText: { flex: 1, fontSize: 13, color: '#5f5140' },
  signInCta: { fontSize: 13, fontWeight: '800', color: '#2f74d6' },
  mineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingLeft: 26,
  },
  mineText: { fontSize: 12, color: '#7a6a55', fontStyle: 'italic' },
  remove: { fontSize: 13, fontWeight: '800', color: '#2f74d6' },
});
