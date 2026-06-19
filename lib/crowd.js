// Crowd check-ins ("how busy is the gym right now").
//
// Two interchangeable drivers behind one interface (loadCrowd / checkIn /
// subscribe). Constants + pure helpers below are backend-agnostic.
//   • Supabase  — shared across all users + real-time (when env vars are set).
//   • Local     — on-device via AsyncStorage (fallback when Supabase is unset).
// The driver is chosen automatically by whether `lib/supabase.js` has creds.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const STORE_KEY = 'hoopmap.crowd.v2'; // local history array per court
const COOLDOWN_KEY = 'hoopmap.cooldown.v1';

export const FRESH_WINDOW_MS = 2 * 60 * 60 * 1000; // a check-in is "live" 2h
const RETENTION_MS = 24 * 60 * 60 * 1000; // drop check-ins older than a day
const MAX_ENTRIES = 50; // cap local history per court

// Per-device rate limit (a soft anti-spam guard — see note at checkIn()).
export const COURT_COOLDOWN_MS = 60 * 1000; // ≤1 check-in per court per minute
export const GLOBAL_GAP_MS = 4 * 1000; // ≥4s between any two check-ins

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
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? 's' : ''} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

// ---- rate limiting (persisted per device) ---------------------------------

async function readCooldown() {
  try {
    const raw = await AsyncStorage.getItem(COOLDOWN_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// { ok } or { ok:false, retryMs } — how long until this court can be re-reported.
async function checkCooldown(courtId, now = Date.now()) {
  const cd = await readCooldown();
  if (cd._global && now - cd._global < GLOBAL_GAP_MS) {
    return { ok: false, retryMs: GLOBAL_GAP_MS - (now - cd._global) };
  }
  if (cd[courtId] && now - cd[courtId] < COURT_COOLDOWN_MS) {
    return { ok: false, retryMs: COURT_COOLDOWN_MS - (now - cd[courtId]) };
  }
  return { ok: true };
}

async function recordCooldown(courtId, now = Date.now()) {
  const cd = await readCooldown();
  cd[courtId] = now;
  cd._global = now;
  try {
    await AsyncStorage.setItem(COOLDOWN_KEY, JSON.stringify(cd));
  } catch {
    // best-effort
  }
}

// ---- local driver (AsyncStorage) ------------------------------------------

async function localLoad() {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
    const old = await AsyncStorage.getItem('hoopmap.crowd.v1'); // migrate v1
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

function supaSubscribe(onRecord) {
  const channel = supabase
    .channel('public:check_ins')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'check_ins' },
      (payload) => {
        if (payload && payload.new) onRecord(rowToRecord(payload.new));
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

// Returns the new check-in record { id, courtId, level, ts } on success,
// { rateLimited: true, retryMs } if the device's cooldown is active, or null
// on backend failure.
//
// NOTE: this rate limit is a per-device soft guard (cleared by reinstalling /
// clearing storage). For real abuse protection, enforce it server-side too
// (e.g. a Supabase policy / edge function keyed on IP or a device token).
export async function checkIn(courtId, level) {
  if (!LEVELS.includes(level)) throw new Error(`bad level: ${level}`);
  const gate = await checkCooldown(courtId);
  if (!gate.ok) return { rateLimited: true, retryMs: gate.retryMs };
  const rec = isShared ? await supaCheckIn(courtId, level) : await localCheckIn(courtId, level);
  if (rec) await recordCooldown(courtId);
  return rec;
}

// Calls onRecord({ id, courtId, level, ts }) whenever anyone checks in
// (Supabase only). No-op locally. Returns an unsubscribe function.
export function subscribe(onRecord) {
  return isShared ? supaSubscribe(onRecord) : () => {};
}
