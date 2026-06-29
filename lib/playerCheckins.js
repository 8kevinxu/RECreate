// Personal "I played here" check-ins, backed by public.player_check_ins.
// Separate from lib/crowd.js (anonymous crowd-level reports): these are tied to
// a signed-in user and power the account screen's per-sport counters and
// most-visited ("favorite") park. No-ops gracefully when Supabase isn't
// configured or the user is signed out.
import { supabase } from './supabase';
import { listFriends } from './friends';

// One logged visit per court+sport within this window, so the crowd-check-in
// piggyback and the explicit "I played here" button never double-count a session.
const DEDUPE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours

// How far back the activity feed surfaces "checked into" events.
const FEED_WINDOW_MS = 12 * 60 * 60 * 1000; // 12 hours

let channelSeq = 0;

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

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

// Recent "checked into" events from the current user + their friends, newest
// first, for the activity feed. Check-ins are public-readable, but we scope to
// friends to keep the feed social. Court names are resolved by the UI from
// court_id. Returns [] when signed out / Supabase unconfigured.
export async function loadRecentCheckins() {
  if (!supabase) return [];
  const me = await currentUserId();
  const friends = await listFriends();
  const ids = [...new Set([...friends.map((f) => f.id).filter(Boolean), me].filter(Boolean))];
  if (!ids.length) return [];
  const sinceIso = new Date(Date.now() - FEED_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('player_check_ins')
    .select('id, user_id, court_id, sport, created_at, profiles!user_id(display_name)')
    .in('user_id', ids)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id,
    userId: r.user_id,
    courtId: r.court_id,
    sport: r.sport,
    createdAt: r.created_at,
    name: r.profiles?.display_name || 'Someone',
    mine: me ? r.user_id === me : false,
  }));
}

// Live check-in inserts, so the activity feed updates the moment a friend
// checks in. No-ops (returns a cleanup) when realtime is unavailable.
export function subscribeCheckins(onChange) {
  if (!supabase) return () => {};
  try {
    const channel = supabase
      .channel(`player_check_ins_${++channelSeq}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'player_check_ins' },
        onChange
      )
      .subscribe();
    return () => {
      try {
        supabase.removeChannel(channel);
      } catch (e) {
        // ignore teardown errors
      }
    };
  } catch (e) {
    return () => {};
  }
}
