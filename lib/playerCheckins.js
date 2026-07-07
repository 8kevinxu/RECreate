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
// out / deduped, or { error } on failure. `notify` opts into pushing this
// check-in to the user's friends (gated server-side on the flag).
export async function logVisit(userId, courtId, sport, notify = false) {
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
    .insert({ user_id: userId, court_id: courtId, sport, notify });
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
  const perCourtSport = {}; // "courtId|sport" -> count
  for (const r of data) {
    perSport[r.sport] = (perSport[r.sport] || 0) + 1;
    perCourt[r.court_id] = (perCourt[r.court_id] || 0) + 1;
    const k = `${r.court_id}|${r.sport}`;
    perCourtSport[k] = (perCourtSport[k] || 0) + 1;
  }
  // Favorite park = the court(s) with the most check-ins. Ties keep every court
  // at the max count so the UI can list them all.
  let favoriteCount = 0;
  for (const n of Object.values(perCourt)) if (n > favoriteCount) favoriteCount = n;
  const favoriteCourtIds =
    favoriteCount > 0
      ? Object.entries(perCourt)
          .filter(([, n]) => n === favoriteCount)
          .map(([courtId]) => courtId)
      : [];
  const favoriteCourtId = favoriteCourtIds[0] || null;
  // The single court+sport combo the player has checked into most.
  let topCourtSport = null;
  let topCount = 0;
  for (const [k, n] of Object.entries(perCourtSport)) {
    if (n > topCount) {
      topCount = n;
      const [courtId, sport] = k.split('|');
      topCourtSport = { courtId, sport, count: n };
    }
  }
  // Sports the player has logged at their favorite court(s), most-played first,
  // deduped across ties (for the "Favorite park: X (N check-ins for basketball,
  // pickleball)" profile stat).
  const favSet = new Set(favoriteCourtIds);
  const favoriteSports = [
    ...new Set(
      Object.entries(perCourtSport)
        .filter(([k]) => favSet.has(k.slice(0, k.lastIndexOf('|'))))
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k.slice(k.lastIndexOf('|') + 1))
    ),
  ];
  return {
    total: data.length,
    perSport,
    favoriteCourtId,
    favoriteCourtIds,
    favoriteCount,
    favoriteSports,
    topCourtSport,
  };
}

// Recent "checked into" events from the current user + their friends, newest
// first, for the activity feed. RLS only exposes own + accepted friends'
// check-ins (migration 017), which is exactly this query's scope. Court names
// are resolved by the UI from court_id. Returns [] when signed out / Supabase
// unconfigured.
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
