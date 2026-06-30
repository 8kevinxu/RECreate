// Blocked users (see supabase/schema/10_moderation.sql). Blocking a user hides
// their content everywhere — the social loaders (signals, chat, feed, friends)
// filter on `getBlockedIds()`. The set is cached in-memory and invalidated on
// block/unblock so a fresh load reflects the change. Degrades to "no blocks" when
// Supabase isn't configured (signed-out / local-only mode).
import { supabase } from './supabase';
import { tg } from './i18n';

let _cache = null; // Set<blocked_id> | null (until first load)

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

export function invalidateBlocks() {
  _cache = null;
}

// The set of user ids the current user has blocked (cached). Empty when signed out.
export async function getBlockedIds({ force = false } = {}) {
  if (!supabase) return new Set();
  if (_cache && !force) return _cache;
  const me = await currentUserId();
  if (!me) {
    _cache = new Set();
    return _cache;
  }
  const { data } = await supabase
    .from('blocked_users')
    .select('blocked_id')
    .eq('blocker_id', me);
  _cache = new Set((data || []).map((r) => r.blocked_id));
  return _cache;
}

export async function blockUser(id) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInFirst')) };
  if (!id || id === me) return { error: new Error(tg('err.cantBlockSelf')) };
  const { error } = await supabase
    .from('blocked_users')
    .upsert({ blocker_id: me, blocked_id: id }, { onConflict: 'blocker_id,blocked_id' });
  if (!error) invalidateBlocks();
  return { error };
}

export async function unblockUser(id) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInFirst')) };
  const { error } = await supabase
    .from('blocked_users')
    .delete()
    .eq('blocker_id', me)
    .eq('blocked_id', id);
  if (!error) invalidateBlocks();
  return { error };
}

// Blocked users with display names, newest-first (for Settings → Blocked users).
export async function listBlockedUsers() {
  if (!supabase) return [];
  const me = await currentUserId();
  if (!me) return [];
  const { data } = await supabase
    .from('blocked_users')
    .select('blocked_id, created_at, profiles!blocked_id(display_name)')
    .eq('blocker_id', me)
    .order('created_at', { ascending: false });
  return (data || []).map((r) => ({
    id: r.blocked_id,
    name: r.profiles?.display_name || 'Someone',
    ts: r.created_at,
  }));
}
