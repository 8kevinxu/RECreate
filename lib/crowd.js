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

const STORE_KEY = 'recreate.crowd.v2'; // local history array per court+sport
// This device's own vote per court+sport (for toggle/undo). Bumped to v2 with the
// key shape; votes only matter for FRESH_WINDOW_MS, so old ones aren't migrated.
const MY_KEY = 'recreate.myvotes.v2';
const REPORT_COUNT_KEY = 'recreate.crowdreports.v1'; // all-time crowd reports from this device

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

// A check-in belongs to one court AND one sport. A pin is a whole facility — Miraloma
// Playground unions hoops, tennis courts and a ball diamond — so "packed" on the
// basketball court says nothing about the diamond. Histories are therefore keyed by
// `courtId|sport`, the same composite lib/playerCheckins.js counts visits by.
export function crowdKey(courtId, sport) {
  return `${courtId}|${sport || ''}`;
}

// The history to show for one court+sport.
//
// Check-ins recorded before crowd went per-sport carry no sport and sit under the
// bare court id. They were reported *about* the pin, so they're merged into every
// sport until they age out (RETENTION_MS — one day after this ships). Once no such
// rows can remain, this fallback and mergeCheckIn's bare-key branch can both go.
export function historyFor(map, courtId, sport) {
  const own = map[crowdKey(courtId, sport)];
  const legacy = map[courtId];
  if (!legacy || !legacy.length) return own || [];
  if (!own || !own.length) return legacy;
  return [...own, ...legacy].sort((a, b) => b.ts - a.ts);
}

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
  // Sport-less rows (a client on an older build) land in the legacy pin-wide bucket.
  const key = rec.sport ? crowdKey(rec.courtId, rec.sport) : rec.courtId;
  const list = Array.isArray(map[key]) ? map[key] : [];
  if (rec.id != null && list.some((e) => e.id === rec.id)) return map; // already have it
  return {
    ...map,
    [key]: prune([{ id: rec.id, level: rec.level, ts: rec.ts }, ...list]),
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

async function localRemove(key, id) {
  const all = await localLoad();
  if (Array.isArray(all[key])) {
    all[key] = all[key].filter((e) => e.id !== id);
    try {
      await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // best-effort
    }
  }
}

async function localCheckIn(courtId, sport, level) {
  const rec = {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    courtId,
    sport,
    level,
    ts: Date.now(),
  };
  const key = crowdKey(courtId, sport);
  const all = await localLoad();
  const list = Array.isArray(all[key]) ? all[key] : [];
  all[key] = prune([{ id: rec.id, level: rec.level, ts: rec.ts }, ...list]);
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // best-effort
  }
  return rec;
}

// ---- supabase driver (shared + real-time) ---------------------------------

function rowToRecord(r) {
  return {
    id: r.id,
    courtId: r.court_id,
    sport: r.sport || null,
    level: r.level,
    ts: Date.parse(r.created_at),
  };
}

async function supaLoad() {
  try {
    const since = new Date(Date.now() - RETENTION_MS).toISOString();
    const { data, error } = await supabase
      .from('check_ins')
      .select('id, court_id, sport, level, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error || !data) return {};
    const map = {};
    for (const r of data) {
      // Pre-per-sport rows have no sport; they keep the bare court id (see historyFor).
      const key = r.sport ? crowdKey(r.court_id, r.sport) : r.court_id;
      if (!map[key]) map[key] = [];
      map[key].push({ id: r.id, level: r.level, ts: Date.parse(r.created_at) });
    }
    return map;
  } catch {
    return {};
  }
}

async function supaCheckIn(courtId, sport, level, notify = false) {
  try {
    const { data, error } = await supabase
      .from('check_ins')
      .insert({ court_id: courtId, sport, level, notify })
      .select('id, court_id, sport, level, created_at')
      .single();
    if (error || !data) return null;
    return rowToRecord(data);
  } catch {
    return null;
  }
}

async function supaRemove(id) {
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

// Returns the new check-in record { id, courtId, sport, level, ts }, or null on
// backend failure. Scoped to one sport at the court — reporting the hoops packed
// leaves the tennis courts unreported. No cooldown — the caller keeps one vote per
// court+sport per device (switching replaces it), so taps can't inflate the count.
// `notify` (Supabase only) opts into pushing this vote to the voter's friends.
export async function checkIn(courtId, sport, level, notify = false) {
  if (!LEVELS.includes(level)) throw new Error(`bad level: ${level}`);
  const rec = isShared
    ? await supaCheckIn(courtId, sport, level, notify)
    : await localCheckIn(courtId, sport, level);
  if (rec) bumpReportCount(); // count this report for the profile stat (device-local)
  return rec;
}

// All-time count of crowd-level reports made from this device. Crowd check-ins are
// anonymous server-side (no user_id), so we tally them locally rather than break that.
async function bumpReportCount() {
  try {
    const n = Number(await AsyncStorage.getItem(REPORT_COUNT_KEY)) || 0;
    await AsyncStorage.setItem(REPORT_COUNT_KEY, String(n + 1));
  } catch {
    // best-effort
  }
}

export async function loadMyReportCount() {
  try {
    return Number(await AsyncStorage.getItem(REPORT_COUNT_KEY)) || 0;
  } catch {
    return 0;
  }
}

// Remove a single check-in by id (used to undo your own vote). No cooldown.
export async function removeCheckIn(courtId, sport, id) {
  return isShared ? supaRemove(id) : localRemove(crowdKey(courtId, sport), id);
}

// This device's own vote per court+sport: { [courtId|sport]: { id, level, ts } }.
// Lets the UI highlight your selection and toggle it off.
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
