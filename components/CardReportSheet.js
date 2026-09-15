// "Something wrong?" — the court and pool cards' one report form. Three topics,
// and the choice decides who sees it, so each option says so before it's picked:
//   · closed / under maintenance → a public player report (lib/closures.js),
//     shown to everyone on the card as a soft banner;
//   · hours wrong / other info wrong → a private 'data' content report with the
//     reporter's note, which the 028 trigger emails to the support inbox.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import { dayChipLabel, startOfDay } from '../lib/datetime';
import { fileClosure, ymd, NOTE_MAX, MAX_DAYS_AHEAD } from '../lib/closures';
import { reportContent } from '../lib/reports';
import { notify } from '../lib/dialog';
import { SportTag } from './SportGlyph';

// content_reports.reason is capped at 500; the topic tag rides in front of the
// note so the email and the dashboard say which question was answered.
const DETAIL_MAX = 480;
const TOPIC_TAG = { hours: '[Hours]', other: '[Other info]' };

const TOPICS = [
  { id: 'closure', icon: 'warning-outline', color: '#d08a0a', bg: '#fdf1d6' },
  { id: 'hours', icon: 'time-outline', color: '#2f74d6', bg: '#e7f0fc' },
  { id: 'other', icon: 'information-circle-outline', color: '#6b7a8a', bg: '#eef2f6' },
];
const TOPIC_KEYS = {
  closure: ['report.optClosure', 'report.optClosureSub'],
  hours: ['report.optHours', 'report.optHoursSub'],
  other: ['report.optOther', 'report.optOtherSub'],
};

function TopicRow({ topic, t, collapsed, onPress }) {
  const [title, sub] = TOPIC_KEYS[topic.id];
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={[styles.topic, collapsed && styles.topicPicked]}
    >
      <View style={[styles.topicIcon, { backgroundColor: topic.bg }]}>
        <Ionicons name={topic.icon} size={18} color={topic.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.topicTitle}>{t(title)}</Text>
        <Text style={styles.topicSub}>{t(sub)}</Text>
      </View>
      {collapsed ? (
        <Text style={styles.change}>{t('report.change')}</Text>
      ) : (
        <Ionicons name="chevron-forward" size={18} color="#b4bfca" />
      )}
    </Pressable>
  );
}

const KIND_KEYS = {
  maintenance: 'closure.kindMaintenance',
  closed: 'closure.kindClosed',
  partial: 'closure.kindPartial',
};

// "This week" = through the coming Sunday.
function endOfWeek(today) {
  const d = new Date(today);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}

function Chip({ active, onPress, children, style }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={[styles.chip, active && styles.chipActive, style]}
    >
      {typeof children === 'string' ? (
        <Text style={[styles.chipText, active && styles.chipTextActive]}>{children}</Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

export default function CardReportSheet({ visible, court, sport, sportName, onClose, onFiled }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [topic, setTopic] = useState(null); // null | 'closure' | 'hours' | 'other'
  const [detail, setDetail] = useState('');
  const [scope, setScope] = useState('sport'); // 'sport' | 'facility'
  const [kind, setKind] = useState(null);
  const [untilMode, setUntilMode] = useState('unknown'); // today | week | date | unknown
  const [date, setDate] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Fresh form every time it opens.
  useEffect(() => {
    if (!visible) return;
    setTopic(null);
    setDetail('');
    setScope('sport');
    setKind(null);
    setUntilMode('unknown');
    setDate(null);
    setNote('');
    setError('');
  }, [visible]);

  const today = startOfDay(new Date());
  const days = useMemo(() => {
    const out = [];
    for (let i = 0; i <= MAX_DAYS_AHEAD; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      out.push(d);
    }
    return out;
  }, [visible]); // rebuilt per open, so an overnight-open app doesn't start from yesterday

  const until =
    untilMode === 'today'
      ? ymd(today)
      : untilMode === 'week'
      ? ymd(endOfWeek(today))
      : untilMode === 'date' && date
      ? ymd(date)
      : null;
  const isClosure = topic === 'closure';
  const ready =
    !busy &&
    (isClosure ? !!kind && !(untilMode === 'date' && !date) : topic === 'hours' || topic === 'other');

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    if (isClosure) {
      const { error: err } = await fileClosure({
        courtId: court.id,
        sport: scope === 'facility' ? null : sport,
        kind,
        until,
        note,
      });
      setBusy(false);
      if (err) return setError(t('closure.fail'));
      return onFiled && onFiled('closure');
    }
    // Same ref_id shape the old one-tap flag used, so supabase/queries/reports.sql
    // still groups a court's (or pool's) reports together.
    const { error: err } = await reportContent({
      kind: 'data',
      refId: court.pool ? `pool:${court.id}` : `court:${court.id}:${sport}`,
      reason: [TOPIC_TAG[topic], detail.trim()].filter(Boolean).join(' '),
    });
    setBusy(false);
    if (err) return setError(err.message || t('report.sendFail'));
    notify(t('report.thanks'));
    onFiled && onFiled(topic);
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Backdrop is a sibling BEHIND the sheet, never a wrapper — a Pressable
            ancestor swallows the ScrollView's pan gesture on device (see
            ClassDetail). */}
        <View style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('a11y.close')}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.handle} />
            <View style={styles.header}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{t('report.sheetTitle')}</Text>
                <Text style={styles.sub}>{[court?.name, sportName].filter(Boolean).join(' · ')}</Text>
              </View>
              <Pressable
                hitSlop={10}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t('a11y.close')}
              >
                <Ionicons name="close" size={22} color="#90a0b0" />
              </Pressable>
            </View>

            <ScrollView
              style={styles.scroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              <Text style={[styles.label, styles.labelFirst]}>{t('report.whatsWrong')}</Text>
              {topic ? (
                <TopicRow
                  topic={TOPICS.find((x) => x.id === topic)}
                  t={t}
                  collapsed
                  onPress={() => setTopic(null)}
                />
              ) : (
                <View style={styles.topics}>
                  {TOPICS.map((x) => (
                    <TopicRow key={x.id} topic={x} t={t} onPress={() => setTopic(x.id)} />
                  ))}
                </View>
              )}

              {isClosure && (
                <>
                  <Text style={styles.label}>{t('closure.whatClosed')}</Text>
                  <View style={styles.chipWrap}>
                    <Chip active={scope === 'sport'} onPress={() => setScope('sport')}>
                      <SportTag
                        id={sport}
                        size={13}
                        textStyle={[styles.chipText, scope === 'sport' && styles.chipTextActive]}
                      >
                        {sportName}
                      </SportTag>
                    </Chip>
                    <Chip active={scope === 'facility'} onPress={() => setScope('facility')}>
                      {t('closure.wholeFacility')}
                    </Chip>
                  </View>

                  <Text style={styles.label}>{t('closure.whatsGoingOn')}</Text>
                  <View style={styles.chipWrap}>
                    {Object.entries(KIND_KEYS).map(([k, key]) => (
                      <Chip key={k} active={kind === k} onPress={() => setKind(k)}>
                        {t(key)}
                      </Chip>
                    ))}
                  </View>

                  <Text style={styles.label}>{t('closure.untilWhen')}</Text>
                  <View style={styles.chipWrap}>
                    <Chip active={untilMode === 'today'} onPress={() => setUntilMode('today')}>
                      {t('closure.today')}
                    </Chip>
                    <Chip active={untilMode === 'week'} onPress={() => setUntilMode('week')}>
                      {t('closure.thisWeek')}
                    </Chip>
                    <Chip active={untilMode === 'date'} onPress={() => setUntilMode('date')}>
                      {untilMode === 'date' && date ? dayChipLabel(date) : t('closure.pickDate')}
                    </Chip>
                    <Chip active={untilMode === 'unknown'} onPress={() => setUntilMode('unknown')}>
                      {t('closure.notSure')}
                    </Chip>
                  </View>
                  {untilMode === 'date' && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.dayRow}
                      style={styles.dayScroll}
                      keyboardShouldPersistTaps="handled"
                    >
                      {days.map((d) => (
                        <Chip
                          key={d.getTime()}
                          active={!!date && d.getTime() === date.getTime()}
                          onPress={() => setDate(d)}
                        >
                          {dayChipLabel(d)}
                        </Chip>
                      ))}
                    </ScrollView>
                  )}

                  <Text style={styles.label}>{t('closure.noteLabel')}</Text>
                  <TextInput
                    style={styles.note}
                    placeholder={t('closure.notePh')}
                    placeholderTextColor="#9aa7b4"
                    value={note}
                    onChangeText={setNote}
                    maxLength={NOTE_MAX}
                    multiline
                  />
                  <Text style={styles.count}>
                    {note.length} / {NOTE_MAX}
                  </Text>
                  <View style={styles.footRow}>
                    <Ionicons name="eye-outline" size={14} color="#7a6a55" style={styles.footIcon} />
                    <Text style={styles.footnote}>{t('closure.footnote')}</Text>
                  </View>
                </>
              )}

              {(topic === 'hours' || topic === 'other') && (
                <>
                  <Text style={styles.label}>
                    {t(topic === 'hours' ? 'report.hoursLabel' : 'report.otherLabel')}
                  </Text>
                  <TextInput
                    style={styles.note}
                    placeholder={t(
                      topic === 'hours'
                        ? 'report.hoursPh'
                        : court?.pool
                        ? 'report.otherPhPool'
                        : 'report.otherPh'
                    )}
                    placeholderTextColor="#9aa7b4"
                    value={detail}
                    onChangeText={setDetail}
                    maxLength={DETAIL_MAX}
                    multiline
                  />
                  <Text style={styles.count}>
                    {detail.length} / {DETAIL_MAX}
                  </Text>
                  <View style={styles.footRow}>
                    <Ionicons name="lock-closed-outline" size={14} color="#5b6b7b" style={styles.footIcon} />
                    <Text style={[styles.footnote, styles.footnotePrivate]}>{t('report.privateNote')}</Text>
                  </View>
                </>
              )}
            </ScrollView>

            {!!error && <Text style={styles.error}>{error}</Text>}
            <Pressable
              style={[styles.submit, !ready && styles.submitDisabled]}
              disabled={!ready}
              onPress={submit}
              accessibilityRole="button"
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>
                  {t(!topic ? 'report.continue' : isClosure ? 'closure.post' : 'report.send')}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 10,
    // Static numeric cap in StyleSheet.create — the only form native Yoga honours
    // for letting the ScrollView below shrink and scroll (see ClassDetail).
    maxHeight: Dimensions.get('window').height * 0.9,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d3dbe3',
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 4 },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  sub: { fontSize: 13, color: '#5b6b7b', marginTop: 2 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  topics: { gap: 8 },
  topic: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e3e8ec',
    backgroundColor: '#fff',
  },
  topicPicked: { borderColor: '#2f74d6', backgroundColor: '#f3f8fe' },
  topicIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  topicTitle: { fontSize: 14, fontWeight: '700', color: '#0d1b2a' },
  topicSub: { fontSize: 12, color: '#6b7a8a', marginTop: 1 },
  change: { fontSize: 13, fontWeight: '800', color: '#2f74d6' },
  labelFirst: { marginTop: 12 },
  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 6,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#eef1f4',
  },
  chipActive: { backgroundColor: '#2f74d6' },
  chipText: { color: '#46586a', fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  dayScroll: { marginTop: 8 },
  dayRow: { gap: 8, paddingRight: 8 },
  note: {
    fontSize: 14,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    maxHeight: 90,
  },
  count: { fontSize: 11, color: '#9aa7b4', textAlign: 'right', marginTop: 4 },
  footRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 8, marginBottom: 12 },
  footIcon: { marginTop: 1 },
  footnote: { flex: 1, fontSize: 12, color: '#7a6a55', lineHeight: 16 },
  footnotePrivate: { color: '#5b6b7b' },
  error: { fontSize: 12, color: '#c0392b', fontWeight: '600', marginBottom: 8 },
  submit: {
    backgroundColor: '#2f74d6',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitDisabled: { backgroundColor: '#bcc8d4' },
  submitText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
