// Personal "I played here" check-ins, backed by public.player_check_ins.
// Separate from lib/crowd.js (anonymous crowd-level reports): these are tied to
// a signed-in user and power the account screen's per-sport counters and
// most-visited ("favorite") park. No-ops gracefully when Supabase isn't
// configured or the user is signed out.
import { supabase } from './supabase';

// One logged visit per court+sport within this window, so the crowd-check-in
// piggyback and the explicit "I played here" button never double-count a session.
const DEDUPE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours

// Record a visit. Returns { logged } on a new insert, { skipped } when signed
// out / deduped, or { error } on failure.
export async function logVisit(userId, courtId, sport) {
  if (!supabase || !userId || !courtId || !sport) return { skipped: true };

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
  const { data: existing } = await supabase
    .from('player_check_ins')
    .select('id')
    .eq('user_id', userId)
    .eq('court_id', courtId)
    .eq('sport', sport)
    .gte('created_at', sinceIso)
    .limit(1);
  if (existing && existing.length) return { skipped: true };

  const { error } = await supabase
    .from('player_check_ins')
    .insert({ user_id: userId, court_id: courtId, sport });
  return error ? { error } : { logged: true };
}

// Aggregate a user's check-ins into { total, perSport: {sportId: n}, favoriteCourtId,
// favoriteCount }. Returns null when unavailable. Court name is resolved by the UI.
export async function loadMyStats(userId) {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from('player_check_ins')
    .select('court_id, sport')
    .eq('user_id', userId);
  if (error || !data) return null;

  const perSport = {};
  const perCourt = {};
  for (const r of data) {
    perSport[r.sport] = (perSport[r.sport] || 0) + 1;
    perCourt[r.court_id] = (perCourt[r.court_id] || 0) + 1;
  }
  let favoriteCourtId = null;
  let favoriteCount = 0;
  for (const [courtId, n] of Object.entries(perCourt)) {
    if (n > favoriteCount) {
      favoriteCount = n;
      favoriteCourtId = courtId;
    }
  }
  return { total: data.length, perSport, favoriteCourtId, favoriteCount };
}
