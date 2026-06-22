// "Down to hoop" signals: location-less availability pings to friends.
// No starts_at = "right now"; with starts_at = "at a time, no place yet".
// Friends-only (enforced by RLS); auto-expire 2h after they start.
import { supabase } from './supabase';

const ACTIVE_MS = 2 * 60 * 60 * 1000;

async function currentUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Active signals visible to the current user (own + friends'), soonest first
// with "right now" ones on top. RLS does the friend scoping.
export async function loadSignals() {
  if (!supabase) return [];
  const me = await currentUserId();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('hoop_signals')
    .select('id, user_id, starts_at, note, user_profile:profiles!user_id(display_name)')
    .gt('expires_at', nowIso)
    .order('starts_at', { ascending: true, nullsFirst: true });
  if (error || !data) return [];
  return data.map((s) => ({
    id: s.id,
    userId: s.user_id,
    startsAt: s.starts_at,
    isNow: !s.starts_at,
    note: s.note,
    name: s.user_profile?.display_name || 'Someone',
    mine: me ? s.user_id === me : false,
  }));
}

// Post a signal. startsAt is a Date (scheduled) or null ("right now").
export async function createSignal({ startsAt, note }) {
  if (!supabase) return { error: new Error('Accounts are not configured.') };
  const me = await currentUserId();
  if (!me) return { error: new Error('Sign in to post.') };
  const start = startsAt ? new Date(startsAt) : null;
  const base = start ? start.getTime() : Date.now();
  const { error } = await supabase.from('hoop_signals').insert({
    user_id: me,
    starts_at: start ? start.toISOString() : null,
    note: note?.trim() || null,
    expires_at: new Date(base + ACTIVE_MS).toISOString(),
  });
  return { error };
}

export async function cancelSignal(id) {
  if (!supabase) return { error: new Error('Accounts are not configured.') };
  const { error } = await supabase.from('hoop_signals').delete().eq('id', id);
  return { error };
}

// Subscribe to any signal change; caller refetches via loadSignals (RLS-filtered).
// Each subscription uses a unique channel topic — the badge and the Friends sheet
// both subscribe, and Supabase realtime errors on two channels sharing a topic.
let channelSeq = 0;
export function subscribeSignals(onChange) {
  if (!supabase) return () => {};
  try {
    const channel = supabase
      .channel(`hoop_signals_${++channelSeq}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hoop_signals' },
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
