// "Plan a game": pick a court and a day+time, in either order. Choosing a court
// limits the time chips to that court's open-gym blocks; picking a time first
// flags which courts run open gym then (others are disabled). Reuses the map's
// time-picker chips and the shared date helpers in lib/datetime.
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
import { createRun, MAX_NOTE } from '../lib/runs';
import { startOfDay, dayChipLabel, fmtClock } from '../lib/datetime';
import { dropinWeekdays, openGymSlots } from '../lib/hours';
import { SPORTS } from '../lib/sports';
import { haversineMiles, formatDistance } from '../lib/distance';
import { useI18n, sportLabel } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { resolveNotify } from '../lib/activityShare';

const minutesOf = (d) => d.getHours() * 60 + d.getMinutes();
// Does this court run the sport's open gym at the exact picked day+time? Slots are
// 30-min aligned, same as the time chips, so this is an exact membership check.
const courtOpenAt = (court, sport, when) =>
  !when || openGymSlots(court, sport, when.getDay()).includes(minutesOf(when));

export default function RunModal({
  visible,
  courts = [],
  sport: sportProp = 'basketball',
  userLocation,
  defaultTime,
  onClose,
  onCreated,
}) {
  const { t } = useI18n();
  const { profile } = useAuth();
  // Seeded from the map's current sport, but switchable here so you can plan a
  // run for either sport regardless of what the map is showing.
  const [sport, setSport] = useState(sportProp);
  const days = useMemo(() => {
    const base = startOfDay(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);

  const [courtId, setCourtId] = useState(null);
  const [place, setPlace] = useState('all'); // 'all' | 'indoor' | 'outdoor'
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [visibility, setVisibility] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const court = useMemo(
    () => courts.find((c) => c.id === courtId) || null,
    [courts, courtId]
  );
  // Only courts that actually run the selected sport are offerable.
  const sportCourts = useMemo(
    () => courts.filter((c) => (c.dropins?.[sport] || []).some((d) => d && d.length)),
    [courts, sport]
  );
  // Offer the Indoor/Outdoor filter only when this sport has both (like the map).
  const sportHasBoth = useMemo(() => {
    let indoor = false;
    let outdoor = false;
    for (const c of sportCourts) c.indoor === false ? (outdoor = true) : (indoor = true);
    return indoor && outdoor;
  }, [sportCourts]);
  // Court list narrowed by the Indoor/Outdoor filter ('all' = either).
  const placeCourts = useMemo(
    () =>
      sportCourts.filter(
        (c) => place === 'all' || (place === 'outdoor' ? c.indoor === false : c.indoor !== false)
      ),
    [sportCourts, place]
  );
  // Day/time options are constrained to the chosen court, or to the (place-filtered)
  // sport courts when none is chosen yet (pick a time first, then a court open then).
  const candidates = useMemo(() => (court ? [court] : placeCourts), [court, placeCourts]);
  const daysWithHoops = useMemo(() => {
    const set = new Set();
    for (const c of candidates) for (const wd of dropinWeekdays(c, sport)) set.add(wd);
    return set;
  }, [candidates, sport]);
  const slotsForDay = (when) => {
    if (!when) return [];
    const wd = when.getDay();
    const set = new Set();
    for (const c of candidates) for (const m of openGymSlots(c, sport, wd)) set.add(m);
    return [...set].sort((a, b) => a - b);
  };
  const firstOpenDay = useMemo(
    () => days.find((d) => daysWithHoops.has(d.getDay())) || null,
    [days, daysWithHoops]
  );

  // (Re)initialize each time the sheet opens: seed the time from the map's picker
  // if one's active (the "time first" path), and start with no court chosen so
  // the court list is open for browsing.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setNote('');
    setVisibility('friends');
    setBusy(false);
    setSport(sportProp);
    setCourtId(null);
    setPlace('all');
    setPicked(defaultTime ? new Date(defaultTime) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Switching sport restarts the court/time choice for that sport's availability.
  const changeSport = (s) => {
    setSport(s);
    setCourtId(null);
    setPlace('all');
    setPicked(null);
  };

  // Switching the Indoor/Outdoor filter drops a chosen court that no longer fits.
  const changePlace = (p) => {
    setPlace(p);
    if (courtId && p !== 'all') {
      const c = courts.find((x) => x.id === courtId);
      if (c && (p === 'outdoor' ? c.indoor !== false : c.indoor === false)) setCourtId(null);
    }
  };

  const selDay = picked ? startOfDay(picked) : firstOpenDay;
  const selDayTs = selDay ? selDay.getTime() : null;
  const selMin = picked ? minutesOf(picked) : null;
  const daySlots = slotsForDay(selDay);
  const blocksForSelDay =
    court && selDay ? court.dropins?.[sport]?.[selDay.getDay()] || [] : [];

  const pickAt = (dayDate, min) => {
    const d = new Date(dayDate);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    setPicked(d);
  };
  // Switching day snaps the time to a slot that's valid for the new day.
  const pickDay = (d) => {
    const slots = slotsForDay(d);
    if (!slots.length) return;
    const min = selMin != null && slots.includes(selMin) ? selMin : slots[0];
    pickAt(d, min);
  };

  // Selecting a court keeps the chosen time if the court runs open gym then,
  // otherwise snaps to that court's nearest slot. Tapping it again deselects
  // (back to "all courts" so the time options widen again).
  const chooseCourt = (c) => {
    if (c.id === courtId) {
      setCourtId(null);
      return;
    }
    setCourtId(c.id);
    if (!picked || courtOpenAt(c, sport, picked)) return;
    const sameDay = openGymSlots(c, sport, picked.getDay());
    if (sameDay.length) {
      pickAt(startOfDay(picked), sameDay[0]);
      return;
    }
    const d = days.find((dd) => openGymSlots(c, sport, dd.getDay()).length);
    if (d) pickAt(d, openGymSlots(c, sport, d.getDay())[0]);
    else setPicked(null);
  };

  // Court rows: ranked by proximity to the user (closest first) when location is
  // available, else left in the data's default (alphabetical) order. Once a time
  // is picked, courts open then float above the rest (which are disabled), with
  // proximity/default order breaking ties within each group.
  // rec.us "% booked" for the picked day+time (keyed "YYYY-MM-DD HH:MM", SF-local);
  // with no time picked yet, fall back to the court's window-average booked%.
  const pad2 = (n) => String(n).padStart(2, '0');
  const slotKey = picked
    ? `${picked.getFullYear()}-${pad2(picked.getMonth() + 1)}-${pad2(picked.getDate())} ${pad2(
        picked.getHours()
      )}:${pad2(picked.getMinutes())}`
    : null;
  const bookedFor = (c) => {
    const res = c.reserved?.[sport];
    if (!res) return null;
    if (slotKey) return res.slots?.[slotKey] ?? null;
    return res.pct ?? null;
  };

  const courtRows = useMemo(() => {
    const rows = placeCourts.map((c) => ({
      c,
      open: courtOpenAt(c, sport, picked),
      booked: bookedFor(c),
      dist: userLocation
        ? haversineMiles(userLocation.lat, userLocation.lng, c.lat, c.lng)
        : null,
    }));
    return rows.sort((a, b) => {
      if (picked && a.open !== b.open) return a.open ? -1 : 1;
      if (a.dist != null && b.dist != null) return a.dist - b.dist;
      return 0; // no location → keep default (alphabetical) order
    });
  }, [placeCourts, sport, picked, userLocation]);

  const submit = async () => {
    if (!courtId) {
      setError(t('run.errCourt'));
      return;
    }
    if (!picked) {
      setError(t('run.errTime'));
      return;
    }
    const notify = await resolveNotify(profile?.share_activity);
    setBusy(true);
    setError(null);
    const { error } = await createRun({
      courtId,
      startsAt: picked.toISOString(),
      sport,
      note,
      visibility,
      notify,
    });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    onCreated?.();
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('run.title')}</Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.sportRow}>
            {SPORTS.map((s) => {
              const active = s.id === sport;
              return (
                <Pressable
                  key={s.id}
                  onPress={() => changeSport(s.id)}
                  style={[styles.sportChip, active && styles.sportChipActive]}
                >
                  <Text style={[styles.sportChipText, active && styles.sportChipTextActive]}>
                    {s.emoji} {sportLabel(t, s.id)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {sportHasBoth && (
            <View style={[styles.toggle, { marginTop: 12 }]}>
              {['all', 'indoor', 'outdoor'].map((p) => (
                <Pressable
                  key={p}
                  style={[styles.toggleItem, place === p && styles.toggleActive]}
                  onPress={() => changePlace(p)}
                >
                  <Text style={[styles.toggleText, place === p && styles.toggleTextActive]}>
                    {p === 'all' ? t('place.all') : p === 'indoor' ? t('place.indoor') : t('place.outdoor')}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}

          <View style={styles.labelRow}>
            <Text style={styles.label}>{t('run.court')}</Text>
            {picked && (
              <Text style={styles.labelHint}>
                {t('run.openGymAt', {
                  day: dayChipLabel(picked),
                  time: fmtClock(Math.floor(selMin / 60), selMin % 60),
                })}
              </Text>
            )}
          </View>
          <ScrollView style={styles.courtList} nestedScrollEnabled>
            {courtRows.map(({ c, open, dist, booked }) => {
              const active = c.id === courtId;
              const disabled = !!picked && !open;
              const sub = [c.neighborhood, dist != null ? formatDistance(dist) : null]
                .filter(Boolean)
                .join(' · ');
              return (
                <Pressable
                  key={c.id}
                  disabled={disabled}
                  onPress={() => chooseCourt(c)}
                  style={[
                    styles.courtRow,
                    active && styles.courtRowActive,
                    disabled && styles.courtRowDisabled,
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[styles.courtRowName, active && styles.courtRowNameActive]}
                      numberOfLines={1}
                    >
                      {c.name}
                    </Text>
                    {!!sub && (
                      <Text
                        style={[styles.courtRowSub, active && styles.courtRowSubActive]}
                        numberOfLines={1}
                      >
                        {sub}
                      </Text>
                    )}
                  </View>
                  <View style={styles.courtRowRight}>
                    {booked != null && (
                      <View
                        style={[
                          styles.bookedPill,
                          booked >= 70 ? styles.bookedPillHi : styles.bookedPillLo,
                        ]}
                      >
                        <Text style={styles.bookedPillText}>{t('run.pctBooked', { n: booked })}</Text>
                      </View>
                    )}
                    {active ? (
                      <Text style={styles.courtRowCheck}>✓</Text>
                    ) : disabled ? (
                      <Text style={styles.courtRowClosed}>{t('run.noHoopsThen')}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={styles.label}>{t('label.day')}</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            {days.map((d) => {
              const open = daysWithHoops.has(d.getDay());
              const active = d.getTime() === selDayTs && !!picked;
              return (
                <Pressable
                  key={d.getTime()}
                  disabled={!open}
                  onPress={() => pickDay(d)}
                  style={[
                    styles.chip,
                    active && styles.chipActive,
                    !open && styles.chipDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active && styles.chipTextActive,
                      !open && styles.chipTextDisabled,
                    ]}
                  >
                    {dayChipLabel(d)}
                    {open ? '' : ` · ${t('home.noHoops')}`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.labelRow}>
            <Text style={styles.label}>{t('label.time')}</Text>
            {!!picked && (
              <Pressable hitSlop={8} onPress={() => setPicked(null)}>
                <Text style={styles.clearTime}>{t('run.clear')}</Text>
              </Pressable>
            )}
          </View>
          {blocksForSelDay.length > 0 && (
            <Text style={styles.hint}>
              {t('run.openGymRanges', {
                ranges: blocksForSelDay
                  .map(
                    ([s, e]) =>
                      `${fmtClock(Math.floor(s / 60), s % 60)}–${fmtClock(
                        Math.floor(e / 60),
                        e % 60
                      )}`
                  )
                  .join(', '),
              })}
            </Text>
          )}
          {daySlots.length === 0 ? (
            <Text style={styles.hint}>{t('run.pickDayHint')}</Text>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {daySlots.map((m) => {
                const active = m === selMin;
                return (
                  <Pressable
                    key={m}
                    onPress={() => pickAt(selDay, m)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>
                      {fmtClock(Math.floor(m / 60), m % 60)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          )}

          <Text style={styles.label}>{t('run.whoCanSee')}</Text>
          <View style={styles.toggle}>
            <Pressable
              style={[styles.toggleItem, visibility === 'friends' && styles.toggleActive]}
              onPress={() => setVisibility('friends')}
            >
              <Text
                style={[
                  styles.toggleText,
                  visibility === 'friends' && styles.toggleTextActive,
                ]}
              >
                {t('run.visFriends')}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.toggleItem, visibility === 'public' && styles.toggleActive]}
              onPress={() => setVisibility('public')}
            >
              <Text
                style={[
                  styles.toggleText,
                  visibility === 'public' && styles.toggleTextActive,
                ]}
              >
                {t('run.visAnyone')}
              </Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.note}
            placeholder={t('run.notePh')}
            placeholderTextColor="#9aa7b4"
            value={note}
            onChangeText={setNote}
            maxLength={MAX_NOTE}
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
              <Text style={styles.submitText}>{t('run.postPlan')}</Text>
            )}
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(13,27,42,0.6)',
    justifyContent: 'flex-end',
  },
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
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },

  sportRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  sportChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#eef2f6',
    borderWidth: 1,
    borderColor: '#dce3ea',
  },
  sportChipActive: { backgroundColor: '#e8732c', borderColor: '#e8732c' },
  sportChipText: { color: '#5b6b7b', fontWeight: '700', fontSize: 13 },
  sportChipTextActive: { color: '#fff' },

  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  labelHint: { fontSize: 12, color: '#2f74d6', fontWeight: '700', marginTop: 12 },
  clearTime: { fontSize: 12, color: '#c0392b', fontWeight: '700', marginTop: 12 },
  hint: { fontSize: 12, color: '#5b6b7b', marginBottom: 8, fontStyle: 'italic' },

  courtList: {
    maxHeight: 188,
    borderWidth: 1,
    borderColor: '#e3e8ee',
    borderRadius: 12,
  },
  courtRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eef1f4',
  },
  courtRowActive: { backgroundColor: '#2f74d6' },
  courtRowDisabled: { opacity: 0.45 },
  courtRowName: { fontSize: 14, fontWeight: '700', color: '#0d1b2a' },
  courtRowNameActive: { color: '#fff' },
  courtRowSub: { fontSize: 12, color: '#7c8a98', marginTop: 1 },
  courtRowSubActive: { color: '#d6e4f5' },
  courtRowCheck: { fontSize: 16, fontWeight: '800', color: '#fff' },
  courtRowClosed: { fontSize: 11, color: '#aab4bd', fontStyle: 'italic' },
  courtRowRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 8 },
  bookedPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  bookedPillHi: { backgroundColor: '#f7e0cf' },
  bookedPillLo: { backgroundColor: '#fdf1d6' },
  bookedPillText: { fontSize: 11, fontWeight: '800', color: '#7a5a3a' },

  toggle: {
    flexDirection: 'row',
    backgroundColor: '#eef1f4',
    borderRadius: 10,
    padding: 3,
  },
  toggleItem: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  toggleActive: { backgroundColor: '#2f74d6' },
  toggleText: { color: '#5b6b7b', fontWeight: '700', fontSize: 14 },
  toggleTextActive: { color: '#fff' },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#eef1f4',
  },
  chipActive: { backgroundColor: '#2f74d6' },
  chipDisabled: { backgroundColor: '#f4f6f8', opacity: 0.6 },
  chipText: { color: '#46586a', fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  chipTextDisabled: { color: '#aab4bd' },

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
