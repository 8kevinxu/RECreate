// "Plan a game" — scheduled pickup games at a court (the rec_runs table). A
// game has a host, a court, a sport, a start time, and a set of participants
// (the host auto-joins via a DB trigger).
//
// Visibility: rows carry a `visibility` column ('public' for now). When the
// friends graph lands, friends-only runs become a filter here + an RLS policy.
// Requires Supabase + a signed-in user; no local fallback (social needs accounts).
import { supabase } from './supabase';
import { viewLabel } from './datetime';
import { tg } from './i18n';

export const MAX_NOTE = 200;

// Show runs starting from 2h ago (still likely in progress) onward.
const LOOKBACK_MS = 2 * 60 * 60 * 1000;

async function currentUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

const RUN_COLS =
  'id, court_id, starts_at, sport, note, host, status, visibility, created_at,' +
  ' host_profile:profiles!host(display_name),' +
  ' rec_run_participants(user_id)';

function mapRun(r, myId) {
  const participants = r.rec_run_participants || [];
  return {
    id: r.id,
    courtId: r.court_id,
    startsAt: r.starts_at,
    sport: r.sport || 'basketball',
    note: r.note,
    createdAt: r.created_at,
    hostId: r.host,
    hostName: r.host_profile?.display_name || 'Someone',
    visibility: r.visibility,
    count: participants.length,
    joined: myId ? participants.some((p) => p.user_id === myId) : false,
    mine: myId ? r.host === myId : false,
  };
}

// Open runs at a court, soonest first, annotated for the current user.
// RLS returns public runs, your own, and friends-only runs hosted by friends.
export async function loadRuns(courtId, myId) {
  if (!supabase) return [];
  const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data, error } = await supabase
    .from('rec_runs')
    .select(RUN_COLS)
    .eq('court_id', courtId)
    .eq('status', 'open')
    .gte('starts_at', sinceIso)
    .order('starts_at', { ascending: true });
  if (error || !data) return [];
  return data.map((r) => mapRun(r, myId));
}

// Upcoming open runs across all courts that the user can see (RLS-scoped) — the
// "Friends' runs" feed. Fetches the current user to flag joined/own runs.
export async function loadUpcomingRuns() {
  if (!supabase) return [];
  const myId = await currentUserId();
  const sinceIso = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data, error } = await supabase
    .from('rec_runs')
    .select(RUN_COLS)
    .eq('status', 'open')
    .gte('starts_at', sinceIso)
    .order('starts_at', { ascending: true })
    .limit(30);
  if (error || !data) return [];
  return data.map((r) => mapRun(r, myId));
}

// Create a run. The host is added as a participant by a DB trigger.
// visibility: 'friends' (default — only friends see it) or 'public'.
export async function createRun({ courtId, startsAt, sport = 'basketball', note, visibility = 'friends', notify = false }) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const uid = await currentUserId();
  if (!uid) return { error: new Error(tg('err.signInPlanRun')) };
  const { data, error } = await supabase
    .from('rec_runs')
    .insert({
      court_id: courtId,
      starts_at: startsAt,
      sport,
      note: note?.trim() || null,
      host: uid,
      visibility,
      notify,
    })
    .select('id')
    .single();
  return { data, error };
}

export async function joinRun(runId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const uid = await currentUserId();
  if (!uid) return { error: new Error(tg('err.signInJoinRun')) };
  const { error } = await supabase
    .from('rec_run_participants')
    .insert({ run_id: runId, user_id: uid });
  return { error };
}

export async function leaveRun(runId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const uid = await currentUserId();
  if (!uid) return { error: new Error(tg('err.notSignedIn')) };
  const { error } = await supabase
    .from('rec_run_participants')
    .delete()
    .eq('run_id', runId)
    .eq('user_id', uid);
  return { error };
}

// Host cancels their run (RLS restricts updates to the host).
export async function cancelRun(runId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase
    .from('rec_runs')
    .update({ status: 'cancelled' })
    .eq('id', runId);
  return { error };
}

// Subscribe to any run change; caller refetches via loadUpcomingRuns (RLS-
// filtered). Each subscription uses a unique channel topic — both the Activity
// badge and the Activity sheet subscribe, and Supabase realtime errors on two
// channels sharing a topic.
let channelSeq = 0;
export function subscribeRuns(onChange) {
  if (!supabase) return () => {};
  try {
    const channel = supabase
      .channel(`rec_runs_${++channelSeq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rec_runs' },
        onChange
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rec_run_participants' },
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
    // Realtime unavailable — the feed still loads on open; just no live updates.
    return () => {};
  }
}

// ISO → "Tue 6/22 6 PM".
export function formatRunTime(iso) {
  return viewLabel(new Date(iso));
}
