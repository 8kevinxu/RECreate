// Friends graph: share a code, add by code (creates a pending request), and
// accept/decline. Requires Supabase + a signed-in user.
import { supabase } from './supabase';
import { getBlockedIds } from './blocks';
import { tg } from './i18n';

async function currentUserId() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// The signed-in user's own shareable friend code.
export async function getMyCode() {
  if (!supabase) return null;
  const id = await currentUserId();
  if (!id) return null;
  const { data } = await supabase
    .from('profiles')
    .select('friend_code')
    .eq('id', id)
    .maybeSingle();
  return data?.friend_code ?? null;
}

// Add a friend by their code. Returns { sent } for a new request,
// { accepted } if it completed a request they'd already sent you, or { error }.
export async function addFriendByCode(code) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const me = await currentUserId();
  if (!me) return { error: new Error(tg('err.signInFirst')) };
  const clean = (code || '').trim().toUpperCase();
  if (!clean) return { error: new Error(tg('err.enterCode')) };

  const { data: target, error: lookupErr } = await supabase
    .from('profiles')
    .select('id, display_name')
    .eq('friend_code', clean)
    .maybeSingle();
  if (lookupErr) return { error: lookupErr };
  if (!target) return { error: new Error(tg('err.noOneFound')) };
  if (target.id === me) return { error: new Error(tg('err.ownCode')) };

  // Any existing friendship between us (either direction)?
  const { data: rows } = await supabase
    .from('friendships')
    .select('id, requester, addressee, status')
    .or(
      `and(requester.eq.${me},addressee.eq.${target.id}),` +
        `and(requester.eq.${target.id},addressee.eq.${me})`
    );
  const existing = rows || [];

  if (existing.some((r) => r.status === 'accepted')) {
    return { error: new Error(tg('err.alreadyFriends')) };
  }
  // They already requested you → accepting completes it.
  const incoming = existing.find((r) => r.status === 'pending' && r.addressee === me);
  if (incoming) {
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', incoming.id);
    return { error, accepted: true, name: target.display_name };
  }
  if (existing.some((r) => r.status === 'pending' && r.requester === me)) {
    return { error: new Error(tg('err.requestSent')) };
  }
  // Clear out any declined leftovers, then send a fresh request.
  for (const r of existing) {
    await supabase.from('friendships').delete().eq('id', r.id);
  }
  const { error } = await supabase
    .from('friendships')
    .insert({ requester: me, addressee: target.id });
  return { error, sent: true, name: target.display_name };
}

// Accepted friends, with the *other* person's id + name.
export async function listFriends() {
  if (!supabase) return [];
  const me = await currentUserId();
  if (!me) return [];
  const { data } = await supabase
    .from('friendships')
    .select(
      'id, requester, addressee,' +
        ' requester_profile:profiles!requester(id, display_name),' +
        ' addressee_profile:profiles!addressee(id, display_name)'
    )
    .eq('status', 'accepted')
    .or(`requester.eq.${me},addressee.eq.${me}`);
  if (!data) return [];
  const blocked = await getBlockedIds();
  return data
    .map((f) => {
      const other = f.requester === me ? f.addressee_profile : f.requester_profile;
      return {
        friendshipId: f.id,
        id: other?.id,
        name: other?.display_name || 'Someone',
      };
    })
    .filter((f) => !blocked.has(f.id));
}

// Pending requests sent *to* the current user.
export async function listIncomingRequests() {
  if (!supabase) return [];
  const me = await currentUserId();
  if (!me) return [];
  const { data } = await supabase
    .from('friendships')
    .select('id, requester, requester_profile:profiles!requester(display_name)')
    .eq('status', 'pending')
    .eq('addressee', me)
    .order('created_at', { ascending: false });
  const blocked = await getBlockedIds();
  return (data || [])
    .filter((f) => !blocked.has(f.requester))
    .map((f) => ({
      friendshipId: f.id,
      name: f.requester_profile?.display_name || 'Someone',
    }));
}

export async function acceptRequest(friendshipId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase
    .from('friendships')
    .update({ status: 'accepted', updated_at: new Date().toISOString() })
    .eq('id', friendshipId);
  return { error };
}

// Declining and unfriending both just remove the row.
export async function removeFriendship(friendshipId) {
  if (!supabase) return { error: new Error(tg('err.notConfigured')) };
  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('id', friendshipId);
  return { error };
}
