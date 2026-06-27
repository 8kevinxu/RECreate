// "Down to hoop" session detail: see who's in, suggest a court + open-gym time,
// and (as host) confirm one. Opened by tapping a signal in the Friends feed.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  joinSignal,
  leaveSignal,
  confirmSignalTime,
  cancelSignal,
} from '../lib/signals';
import { startOfDay, dayChipLabel, fmtClock, viewLabel } from '../lib/datetime';
import { dropinWeekdays, openGymSlots } from '../lib/hours';

export default function SessionModal({ visible, signal, courts = [], sport = 'basketball', onClose, onChanged }) {
  const days = useMemo(() => {
    const base = startOfDay(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);
  const courtsWithBball = useMemo(
    () => courts.filter((c) => dropinWeekdays(c, sport).size > 0),
    [courts, sport]
  );
  const nameById = useMemo(
    () => Object.fromEntries(courts.map((c) => [c.id, c.name])),
    [courts]
  );

  const [courtId, setCourtId] = useState(null);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);

  const selectedCourt = courts.find((c) => c.id === courtId) || null;
  const bballDays = useMemo(
    () => (selectedCourt ? dropinWeekdays(selectedCourt, sport) : new Set()),
    [selectedCourt, sport]
  );
  const firstOpenDay = useMemo(
    () => days.find((d) => bballDays.has(d.getDay())) || days[0],
    [days, bballDays]
  );
  const selDayTs = picked ? startOfDay(picked).getTime() : null;
  const selMin = picked ? picked.getHours() * 60 + picked.getMinutes() : null;
  const selDay = picked ? startOfDay(picked) : null;
  const daySlots = selectedCourt && selDay ? openGymSlots(selectedCourt, sport, selDay.getDay()) : [];

  // Seed court + time from the confirmed plan, your suggestion, or defaults.
  useEffect(() => {
    if (!visible || !signal) return;
    setBusy(false);
    const cid = signal.plannedCourtId || signal.myProposedCourtId || null;
    setCourtId(cid);
    const seed = signal.plannedAt || signal.myProposedAt;
    setPicked(seed ? new Date(seed) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, signal?.id]);

  if (!signal) return null;

  const { mine, joined, plannedAt, plannedCourtId, participants } = signal;

  // Snap to a valid open-gym slot for the given court/day.
  const snap = (court, dayDate, minPref) => {
    const slots = openGymSlots(court, sport, dayDate.getDay());
    if (!slots.length) return null;
    const min = minPref != null && slots.includes(minPref) ? minPref : slots[0];
    const d = new Date(dayDate);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d;
  };
  const selectCourt = (cid) => {
    const court = courts.find((c) => c.id === cid);
    setCourtId(cid);
    const fday = days.find((d) => dropinWeekdays(court, sport).has(d.getDay())) || days[0];
    setPicked(snap(court, fday, selMin));
  };
  const pickDay = (d) => setPicked(snap(selectedCourt, d, selMin));
  const pickTime = (m) => {
    const dayDate = days.find((x) => x.getTime() === selDayTs) || firstOpenDay;
    const d = new Date(dayDate);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    setPicked(d);
  };

  const run = async (fn) => {
    setBusy(true);
    await fn();
    await onChanged?.();
    setBusy(false);
  };
  const canSuggest = !!courtId && !!picked;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{mine ? 'Your session' : `${signal.name}’s session`}</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <Text style={styles.sub}>
            {signal.isNow ? 'Down to hoop right now' : `Down to hoop · ${viewLabel(signal.startsAt)}`}
            {signal.note ? ` · ${signal.note}` : ''}
          </Text>

          <View style={[styles.banner, plannedAt ? styles.bannerOn : styles.bannerOff]}>
            <Text style={plannedAt ? styles.bannerOnText : styles.bannerOffText}>
              {plannedAt
                ? `🏀 Confirmed: ${viewLabel(plannedAt)}${
                    plannedCourtId ? ` @ ${nameById[plannedCourtId] || 'a court'}` : ''
                  }`
                : 'No time confirmed yet'}
            </Text>
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Who’s in ({participants.length})</Text>
            {participants.map((p) => (
              <View key={p.userId} style={styles.pRow}>
                <Text style={styles.pName}>
                  👤 {p.name}
                  {p.userId === signal.userId ? ' · host' : ''}
                </Text>
                {p.proposedAt ? (
                  <View style={styles.pRight}>
                    <Text style={styles.pSuggest}>
                      {viewLabel(p.proposedAt)}
                      {p.proposedCourtId ? ` @ ${nameById[p.proposedCourtId] || 'a court'}` : ''}
                    </Text>
                    {mine && (
                      <Pressable
                        style={styles.confirmBtn}
                        disabled={busy}
                        onPress={() =>
                          run(() => confirmSignalTime(signal.id, p.proposedAt, p.proposedCourtId))
                        }
                      >
                        <Text style={styles.confirmText}>Confirm</Text>
                      </Pressable>
                    )}
                  </View>
                ) : null}
              </View>
            ))}

            {joined && (
              <>
                <Text style={[styles.label, { marginTop: 16 }]}>
                  {mine ? 'Set a court & time' : 'Suggest a court & time'}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {courtsWithBball.map((c) => {
                    const active = c.id === courtId;
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => selectCourt(c.id)}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {c.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {!courtId ? (
                  <Text style={styles.hint}>Pick a court to choose an open-gym time.</Text>
                ) : (
                  <>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                      {days.map((d) => {
                        const open = bballDays.has(d.getDay());
                        const active = d.getTime() === selDayTs;
                        return (
                          <Pressable
                            key={d.getTime()}
                            disabled={!open}
                            onPress={() => pickDay(d)}
                            style={[styles.chip, active && styles.chipActive, !open && styles.chipDisabled]}
                          >
                            <Text
                              style={[
                                styles.chipText,
                                active && styles.chipTextActive,
                                !open && styles.chipTextDisabled,
                              ]}
                            >
                              {dayChipLabel(d)}
                              {open ? '' : ' · no hoops'}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                      {daySlots.map((m) => {
                        const active = m === selMin;
                        return (
                          <Pressable
                            key={m}
                            onPress={() => pickTime(m)}
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
              </>
            )}
          </ScrollView>

          <View style={styles.actions}>
            {!joined ? (
              <Pressable
                style={[styles.primary, busy && styles.disabled]}
                disabled={busy}
                onPress={() => run(() => joinSignal(signal.id))}
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>I’m in</Text>}
              </Pressable>
            ) : mine ? (
              <Pressable
                style={[styles.primary, (busy || !canSuggest) && styles.disabled]}
                disabled={busy || !canSuggest}
                onPress={() => run(() => confirmSignalTime(signal.id, picked, courtId))}
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Confirm time</Text>}
              </Pressable>
            ) : (
              <Pressable
                style={[styles.primary, (busy || !canSuggest) && styles.disabled]}
                disabled={busy || !canSuggest}
                onPress={() => run(() => joinSignal(signal.id, picked, courtId))}
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Suggest time</Text>}
              </Pressable>
            )}

            {joined &&
              (mine ? (
                <Pressable
                  style={styles.secondary}
                  disabled={busy}
                  onPress={() => run(() => cancelSignal(signal.id)).then(onClose)}
                >
                  <Text style={styles.cancelText}>Cancel session</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.secondary}
                  disabled={busy}
                  onPress={() => run(() => leaveSignal(signal.id))}
                >
                  <Text style={styles.cancelText}>Leave</Text>
                </Pressable>
              ))}
          </View>
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
    paddingBottom: 24,
    maxHeight: '88%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },
  sub: { fontSize: 13, color: '#5b6b7b', marginTop: 2 },

  banner: { borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginTop: 12 },
  bannerOn: { backgroundColor: '#d4f3df' },
  bannerOff: { backgroundColor: '#f4f6f8' },
  bannerOnText: { color: '#1f6f43', fontWeight: '800', fontSize: 14 },
  bannerOffText: { color: '#7a8a9a', fontWeight: '600', fontSize: 13 },

  body: { marginTop: 8 },
  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  hint: { fontSize: 12, color: '#5b6b7b', fontStyle: 'italic', marginBottom: 8 },
  pRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  pName: { fontSize: 14, color: '#1a2a3a', fontWeight: '600', flex: 1 },
  pRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pSuggest: { fontSize: 12, color: '#5b6b7b', maxWidth: 150, textAlign: 'right' },
  confirmBtn: { backgroundColor: '#1f9d55', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  confirmText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  chipRow: { gap: 8, paddingRight: 8, marginBottom: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: '#eef1f4' },
  chipActive: { backgroundColor: '#2f74d6' },
  chipDisabled: { backgroundColor: '#f4f6f8', opacity: 0.6 },
  chipText: { color: '#46586a', fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  chipTextDisabled: { color: '#aab4bd' },

  actions: { marginTop: 12, gap: 8 },
  primary: { backgroundColor: '#1f9d55', borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  disabled: { opacity: 0.6 },
  secondary: { alignItems: 'center', paddingVertical: 8 },
  cancelText: { color: '#c0392b', fontWeight: '700', fontSize: 13 },
});
