// "Down to hoop" composer: choose Now or a day/time (no location), add an
// optional note, and broadcast to friends.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { createSignal } from '../lib/signals';
import { startOfDay, dayChipLabel, fmtClock } from '../lib/datetime';
import { useI18n } from '../lib/i18n';

export default function SignalModal({ visible, onClose, onPosted }) {
  const { t } = useI18n();
  const [mode, setMode] = useState('now'); // 'now' | 'time'
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const days = useMemo(() => {
    const base = startOfDay(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);
  const times = useMemo(() => {
    const out = [];
    for (let m = 9 * 60; m <= 22 * 60; m += 30) out.push(m);
    return out;
  }, []);

  useEffect(() => {
    if (!visible) return;
    setMode('now');
    setNote('');
    setError(null);
    setBusy(false);
    const d = new Date(days[0]);
    d.setHours(18, 0, 0, 0);
    setPicked(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const selDayTs = picked ? startOfDay(picked).getTime() : null;
  const selMin = picked ? picked.getHours() * 60 + picked.getMinutes() : null;
  const pick = (dayDate, min) => {
    const d = new Date(dayDate);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    setPicked(d);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const { error } = await createSignal({
      startsAt: mode === 'now' ? null : picked,
      note,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    onPosted?.();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('signal.title')}</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.toggle}>
            <Pressable
              style={[styles.toggleItem, mode === 'now' && styles.toggleActive]}
              onPress={() => setMode('now')}
            >
              <Text style={[styles.toggleText, mode === 'now' && styles.toggleTextActive]}>
                {t('signal.rightNow')}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.toggleItem, mode === 'time' && styles.toggleActive]}
              onPress={() => setMode('time')}
            >
              <Text style={[styles.toggleText, mode === 'time' && styles.toggleTextActive]}>
                {t('signal.atTime')}
              </Text>
            </Pressable>
          </View>

          {mode === 'time' && (
            <>
              <Text style={styles.label}>{t('label.day')}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                {days.map((d) => {
                  const active = d.getTime() === selDayTs;
                  return (
                    <Pressable
                      key={d.getTime()}
                      onPress={() => pick(d, selMin ?? 18 * 60)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {dayChipLabel(d)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Text style={styles.label}>{t('label.time')}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                {times.map((m) => {
                  const active = m === selMin;
                  const dayDate = days.find((x) => x.getTime() === selDayTs) || days[0];
                  return (
                    <Pressable
                      key={m}
                      onPress={() => pick(dayDate, m)}
                      style={[styles.chip, active && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {fmtClock(Math.floor(m / 60), m % 60)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </>
          )}

          <TextInput
            style={styles.note}
            placeholder={t('signal.notePh')}
            placeholderTextColor="#9aa7b4"
            value={note}
            onChangeText={setNote}
            maxLength={200}
            multiline
          />

          {!!error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            style={[styles.submit, busy && styles.submitDisabled]}
            disabled={busy}
            onPress={submit}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>
                {mode === 'now' ? t('signal.tellFriends') : t('court.post')}
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 28,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },

  toggle: {
    flexDirection: 'row',
    backgroundColor: '#eef1f4',
    borderRadius: 10,
    padding: 3,
    marginBottom: 6,
  },
  toggleItem: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  toggleActive: { backgroundColor: '#2f74d6' },
  toggleText: { color: '#5b6b7b', fontWeight: '700', fontSize: 14 },
  toggleTextActive: { color: '#fff' },

  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#eef1f4',
  },
  chipActive: { backgroundColor: '#2f74d6' },
  chipText: { color: '#46586a', fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },

  note: {
    fontSize: 14,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 14,
    minHeight: 44,
    maxHeight: 90,
  },
  error: { color: '#c0392b', fontSize: 13, marginTop: 10, fontWeight: '600' },

  submit: {
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 14,
  },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontWeight: '800', fontSize: 15 },
});
