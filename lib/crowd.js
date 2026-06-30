// Crowd check-ins ("how busy is the gym right now").
//
// Two interchangeable drivers behind one interface (loadCrowd / checkIn /
// subscribe). Constants + pure helpers below are backend-agnostic.
//   • Supabase  — shared across all users + real-time (when env vars are set).
//   • Local     — on-device via AsyncStorage (fallback when Supabase is unset).
// The driver is chosen automatically by whether `lib/supabase.js` has creds.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { tg } from './i18n';

const STORE_KEY = 'recreate.crowd.v2'; // local history array per court
const MY_KEY = 'recreate.myvotes.v1'; // this device's own vote per court (for toggle/undo)

export const FRESH_WINDOW_MS = 2 * 60 * 60 * 1000; // a check-in is "live" 2h
const RETENTION_MS = 24 * 60 * 60 * 1000; // drop check-ins older than a day
const MAX_ENTRIES = 50; // cap local history per court

// No cooldown: each device holds a single vote per court (switching replaces it,
// tapping it again removes it), so repeated taps can't inflate the count — which
// also means misclicks are trivially fixable.

export const LEVELS = ['empty', 'moderate', 'packed'];

export const LEVEL_META = {
  empty: { label: 'Empty', color: '#1f9d55', dot: '🟢' },
  moderate: { label: 'Moderate', color: '#e8a317', dot: '🟡' },
  packed: { label: 'Packed', color: '#e23b3b', dot: '🔴' },
};

// true when check-ins are shared across users (Supabase configured).
export const isShared = !!supabase;

// ---- pure helpers (driver-agnostic) ---------------------------------------

function prune(list, now = Date.now()) {
  return list
    .filter((e) => e && now - e.ts <= RETENTION_MS)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ENTRIES);
}

export function latest(history) {
  return Array.isArray(history) && history.length ? history[0] : null;
}

export function currentLevel(history, now = Date.now()) {
  const last = latest(history);
  if (!last) return null;
  return now - last.ts <= FRESH_WINDOW_MS ? last.level : null;
}

export function countWithin(history, windowMs, now = Date.now()) {
  if (!Array.isArray(history)) return 0;
  return history.filter((e) => now - e.ts <= windowMs).length;
}

// Apply a single check-in record into the crowd map (immutably), deduped by id.
// This is what powers incremental real-time updates — no full refetch needed.
export function mergeCheckIn(map, rec) {
  if (!rec || !rec.courtId) return map;
  const list = Array.isArray(map[rec.courtId]) ? map[rec.courtId] : [];
  if (rec.id != null && list.some((e) => e.id === rec.id)) return map; // already have it
  return {
    ...map,
    [rec.courtId]: prune([{ id: rec.id, level: rec.level, ts: rec.ts }, ...list]),
  };
}

export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return tg('time.justNow');
  const m = Math.floor(s / 60);
  if (m < 60) return tg('time.minAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return tg('time.hrAgo', { n: h });
  const d = Math.floor(h / 24);
  return tg('time.dayAgo', { n: d });
}

// ---- local driver (AsyncStorage) ------------------------------------------

async function localLoad() {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    const old = await AsyncStorage.getItem('recreate.crowd.v1'); // migrate v1
    if (old) {
      const map = JSON.parse(old) || {};
      const migrated = {};
      for (const [id, rec] of Object.entries(map)) {
        if (rec && rec.level && rec.ts) migrated[id] = [rec];
      }
      return migrated;
    }
    return {};
  } catch {
    return {};
  }
}

async function localRemove(courtId, id) {
  const all = await localLoad();
  if (Array.isArray(all[courtId])) {
    all[courtId] = all[courtId].filter((e) => e.id !== id);
    try {
      await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // best-effort
    }
  }
}

async function localCheckIn(courtId, level) {
  const rec = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    courtId,
    level,
    ts: Date.now(),
  };
  const all = await localLoad();
  const list = Array.isArray(all[courtId]) ? all[courtId] : [];
  all[courtId] = prune([{ id: rec.id, level: rec.level, ts: rec.ts }, ...list]);
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // best-effort
  }
  return rec;
}

// ---- supabase driver (shared + real-time) ---------------------------------

function rowToRecord(r) {
  return { id: r.id, courtId: r.court_id, level: r.level, ts: Date.parse(r.created_at) };
}

async function supaLoad() {
  try {
    const since = new Date(Date.now() - RETENTION_MS).toISOString();
    const { data, error } = await supabase
      .from('check_ins')
      .select('id, court_id, level, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error || !data) return {};
    const map = {};
    for (const r of data) {
      if (!map[r.court_id]) map[r.court_id] = [];
      map[r.court_id].push({ id: r.id, level: r.level, ts: Date.parse(r.created_at) });
    }
    return map;
  } catch {
    return {};
  }
}

async function supaCheckIn(courtId, level) {
  try {
    const { data, error } = await supabase
      .from('check_ins')
      .insert({ court_id: courtId, level })
      .select('id, court_id, level, created_at')
      .single();
    if (error || !data) return null;
    return rowToRecord(data);
  } catch {
    return null;
  }
}

async function supaRemove(courtId, id) {
  try {
    await supabase.from('check_ins').delete().eq('id', id);
  } catch {
    // ignore — caller refetches
  }
}

function supaSubscribe(onInsert, onDelete) {
  const channel = supabase
    .channel('public:check_ins')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'check_ins' },
      (payload) => {
        if (payload && payload.new) onInsert(rowToRecord(payload.new));
      }
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'check_ins' },
      () => {
        // Delete payloads carry only the primary key; deletes are rare, so just
        // ask the caller to refetch rather than track per-court removal.
        if (onDelete) onDelete();
      }
    )
    .subscribe();
  return () => {
    supabase.removeChannel(channel);
  };
}

// ---- public interface (auto-selects driver) -------------------------------

export async function loadCrowd() {
  return isShared ? supaLoad() : localLoad();
}

// Returns the new check-in record { id, courtId, level, ts }, or null on
// backend failure. No cooldown — the caller keeps one vote per court per device
// (switching replaces it), so taps can't inflate the count.
export async function checkIn(courtId, level) {
  if (!LEVELS.includes(level)) throw new Error(`bad level: ${level}`);
  return isShared ? supaCheckIn(courtId, level) : localCheckIn(courtId, level);
}

// Remove a single check-in by id (used to undo your own vote). No cooldown.
export async function removeCheckIn(courtId, id) {
  return isShared ? supaRemove(courtId, id) : localRemove(courtId, id);
}

// This device's own vote per court: { [courtId]: { id, level, ts } }. Lets the
// UI highlight your selection and toggle it off.
export async function loadMyVotes() {
  try {
    const raw = await AsyncStorage.getItem(MY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveMyVotes(map) {
  try {
    await AsyncStorage.setItem(MY_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

// onInsert({ id, courtId, level, ts }) for new check-ins; onDelete() when any
// check-in is removed (Supabase only). No-op locally. Returns unsubscribe.
export function subscribe(onInsert, onDelete) {
  return isShared ? supaSubscribe(onInsert, onDelete) : () => {};
}
