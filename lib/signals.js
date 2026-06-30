// "Down to hoop" signals: location-less availability pings to friends.
// No starts_at = "right now"; with starts_at = "at a time, no place yet".
// Friends-only (enforced by RLS); auto-expire 2h after they start.
import { supabase } from './supabase';
import { tg } from './i18n';

const ACTIVE_MS = 2 * 60 * 60 * 1000;

async function currentUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Active signals visible to the current user (own + friends'), soonest first
// with "right now" ones on top. RLS does the friend scoping. Each signal carries
// its participants (with any suggested times) and the host-confirmed planned_at.
export async function loadSignals() {
  if (!supabase) return [];
  const me = await currentUserId();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('hoop_signals')
    .select(
      'id, user_id, starts_at, note, planned_at, planned_court_id, created_at,' +
        ' user_profile:profiles!user_id(display_name),' +
        ' hoop_signal_participants(user_id, proposed_at, proposed_court_id, profiles!user_id(display_name))'
    )
    .gt('expires_at', nowIso)
    .order('starts_at', { ascending: true, nullsFirst: true });
  if (error || !data) return [];
  return data.map((s) => {
    const participants = (s.hoop_signal_participants || []).map((p) => ({
      userId: p.user_id,
      name: p.profiles?.display_name || 'Someone',
      proposedAt: p.proposed_at,
      proposedCourtId: p.proposed_court_id,
    }));
    const me_part = me ? participants.find((p) => p.userId === me) : null;
    return {
      id: s.id,
      userId: s.user_id,
      startsAt: s.starts_at,
      isNow: !s.starts_at,
      note: s.note,
      createdAt: s.created_at,
      plannedAt: s.planned_at,
      plannedCourtId: s.planned_court_id,
      name: s.user_profile?.display_name || 'Someone',
      mine: me ? s.user_id === me : false,
      participants,
      count: participants.length,
      joined: !!me_part,
      myProposedAt: me_part?.proposedAt ?? null,
      myProposedCourtId: me_part?.proposedCourtId ?? null,
    };
  });
}

// Post a signal. startsAt is a Date (scheduled) or null ("right now").
export async function createSignal({ startsAt, note }) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInPost')) };
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
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase.from('hoop_signals').delete().eq('id', id);
  return { error };
}

// Join a session (optionally suggesting a time + court). Idempotent — also used
// to update your suggestion, since it upserts your participant row.
export async function joinSignal(signalId, proposedAt = null, proposedCourtId = null) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInJoin')) };
  const { error } = await supabase.from('hoop_signal_participants').upsert(
    {
      signal_id: signalId,
      user_id: me,
      proposed_at: proposedAt ? new Date(proposedAt).toISOString() : null,
      proposed_court_id: proposedCourtId || null,
    },
    { onConflict: 'signal_id,user_id' }
  );
  return { error };
}

export async function leaveSignal(signalId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.notSignedIn')) };
  const { error } = await supabase
    .from('hoop_signal_participants')
    .delete()
    .eq('signal_id', signalId)
    .eq('user_id', me);
  return { error };
}

// Host confirms (or clears, with null) the session time + court. Also stretches
// the expiry so the session survives until ~2h after the confirmed time.
export async function confirmSignalTime(signalId, plannedAt, plannedCourtId = null) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const patch = { planned_at: null, planned_court_id: null };
  if (plannedAt) {
    const t = new Date(plannedAt);
    patch.planned_at = t.toISOString();
    patch.planned_court_id = plannedCourtId || null;
    patch.expires_at = new Date(t.getTime() + ACTIVE_MS).toISOString();
  }
  const { error } = await supabase
    .from('hoop_signals')
    .update(patch)
    .eq('id', signalId);
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hoop_signal_participants' },
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
