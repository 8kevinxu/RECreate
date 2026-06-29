// Chat data layer over public.chat_messages (see supabase/schema/08_chat.sql).
// Three thread kinds share the table: 'run' / 'signal' group chats (membership
// derived from participants) and 'direct' 1:1 friend chats (keyed by the two
// user ids). Read state is tracked locally (AsyncStorage), like the feed badge.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { formatRunTime } from './runs';

const READS_KEY = 'hoopmap:chatReads';
const DELETED_KEY = 'hoopmap:chatDeleted';
let channelSeq = 0;

async function currentUserId() {
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Stable thread id for a 1:1 chat: the two user ids sorted + joined.
export function directKeyFor(a, b) {
  return [a, b].sort().join(':');
}

// A thread descriptor for a 1:1 chat with a friend ({ id, name }), resolving the
// current user. Returns null when signed out.
export async function directThreadWith(friend) {
  const me = await currentUserId();
  if (!me || !friend?.id) return null;
  const directKey = directKeyFor(me, friend.id);
  return {
    key: `direct:${directKey}`,
    kind: 'direct',
    directKey,
    otherId: friend.id,
    title: friend.name || 'Friend',
    subtitle: 'Direct message',
  };
}

// Per-thread "last read" timestamps, kept locally so unread dots work without a
// server-side read table.
async function getReads() {
  try {
    const v = await AsyncStorage.getItem(READS_KEY);
    return v ? JSON.parse(v) : {};
  } catch (e) {
    return {};
  }
}

export async function markThreadRead(threadKey) {
  try {
    const reads = await getReads();
    reads[threadKey] = Date.now();
    await AsyncStorage.setItem(READS_KEY, JSON.stringify(reads));
  } catch (e) {
    // non-fatal
  }
}

// "Deleted" threads are hidden from the main Chats list (kept locally — these
// chats are derived from membership, so we don't remove the run/signal itself).
// They stay hidden until restored from the Deleted view.
async function getDeletedKeys() {
  try {
    const v = await AsyncStorage.getItem(DELETED_KEY);
    return new Set(v ? JSON.parse(v) : []);
  } catch (e) {
    return new Set();
  }
}

export async function setThreadDeleted(threadKey, deleted) {
  try {
    const set = await getDeletedKeys();
    if (deleted) set.add(threadKey);
    else set.delete(threadKey);
    await AsyncStorage.setItem(DELETED_KEY, JSON.stringify([...set]));
  } catch (e) {
    // non-fatal
  }
}

// Every thread the current user belongs to, newest-activity first, each with a
// last-message preview and unread count. Run/signal chats come from the user's
// participation (so they appear the moment you join, before any messages);
// direct chats come from existing messages.
export async function loadThreads(courtsById = {}) {
  if (!supabase) return [];
  const me = await currentUserId();
  if (!me) return [];
  const nowIso = new Date().toISOString();

  // Run + signal chats I'm a participant of.
  const [{ data: rp }, { data: sp }] = await Promise.all([
    supabase.from('hoop_run_participants').select('run_id').eq('user_id', me),
    supabase.from('hoop_signal_participants').select('signal_id').eq('user_id', me),
  ]);
  const runIds = (rp || []).map((r) => r.run_id);
  const sigIds = (sp || []).map((r) => r.signal_id);

  const [runsRes, sigsRes, msgsRes] = await Promise.all([
    runIds.length
      ? supabase.from('hoop_runs').select('id, court_id, starts_at, sport, status').in('id', runIds)
      : Promise.resolve({ data: [] }),
    sigIds.length
      ? supabase
          .from('hoop_signals')
          .select('id, user_id, starts_at, planned_at, note, expires_at, user_profile:profiles!user_id(display_name)')
          .in('id', sigIds)
          .gt('expires_at', nowIso)
      : Promise.resolve({ data: [] }),
    // RLS already limits this to my threads, so a plain recent fetch is enough.
    supabase
      .from('chat_messages')
      .select('id, run_id, signal_id, direct_key, user_id, body, created_at, profiles!user_id(display_name)')
      .order('created_at', { ascending: false })
      .limit(300),
  ]);

  const runs = runsRes.data || [];
  const signals = sigsRes.data || [];
  const messages = msgsRes.data || [];
  const reads = await getReads();

  const threads = new Map();
  const keyOf = (m) =>
    m.run_id ? `run:${m.run_id}` : m.signal_id ? `signal:${m.signal_id}` : `direct:${m.direct_key}`;

  for (const r of runs) {
    if (r.status === 'cancelled') continue;
    threads.set(`run:${r.id}`, {
      key: `run:${r.id}`,
      kind: 'run',
      runId: r.id,
      sport: r.sport,
      title: courtsById[r.court_id] || 'Pickup run',
      subtitle: formatRunTime(r.starts_at),
    });
  }
  for (const s of signals) {
    const host = s.user_id === me ? 'You' : s.user_profile?.display_name || 'Someone';
    threads.set(`signal:${s.id}`, {
      key: `signal:${s.id}`,
      kind: 'signal',
      signalId: s.id,
      title: `${host === 'You' ? 'Your' : `${host}’s`} hoop`,
      subtitle: s.planned_at ? 'Session' : s.starts_at ? 'Scheduled' : 'Down now',
    });
  }

  // Direct threads need the *other* person's name; collect ids to resolve.
  const directOtherIds = new Set();
  for (const m of messages) {
    if (!m.direct_key) continue;
    const [a, b] = m.direct_key.split(':');
    directOtherIds.add(a === me ? b : a);
  }
  let names = {};
  if (directOtherIds.size) {
    const { data } = await supabase
      .from('profiles')
      .select('id, display_name')
      .in('id', [...directOtherIds]);
    for (const p of data || []) names[p.id] = p.display_name;
  }

  // Fold messages in: create direct threads, set last-message + unread on each.
  for (const m of messages) {
    const key = keyOf(m);
    let t = threads.get(key);
    if (!t) {
      if (!m.direct_key) continue; // a run/signal I've since left
      const [a, b] = m.direct_key.split(':');
      const otherId = a === me ? b : a;
      t = {
        key,
        kind: 'direct',
        directKey: m.direct_key,
        otherId,
        title: names[otherId] || 'Friend',
        subtitle: 'Direct message',
      };
      threads.set(key, t);
    }
    if (!t.lastAt) {
      t.lastAt = m.created_at;
      t.lastSender = m.user_id === me ? 'You' : m.profiles?.display_name || 'Someone';
      t.lastMessage = m.body;
    }
    const readAt = reads[key] || 0;
    if (m.user_id !== me && new Date(m.created_at).getTime() > readAt) {
      t.unread = (t.unread || 0) + 1;
    }
  }

  const list = [...threads.values()];
  const deletedKeys = await getDeletedKeys();
  for (const t of list) t.deleted = deletedKeys.has(t.key);
  // Threads with messages first (newest), then empty ones (freshly joined).
  list.sort((a, b) => {
    const at = a.lastAt ? new Date(a.lastAt).getTime() : 0;
    const bt = b.lastAt ? new Date(b.lastAt).getTime() : 0;
    return bt - at;
  });
  return list;
}

// Filter for chat_messages by a thread descriptor.
function threadFilter(q, thread) {
  if (thread.kind === 'run') return q.eq('run_id', thread.runId);
  if (thread.kind === 'signal') return q.eq('signal_id', thread.signalId);
  return q.eq('direct_key', thread.directKey);
}

// Messages in a thread, oldest first, with sender names + a `mine` flag.
export async function loadMessages(thread) {
  if (!supabase || !thread) return [];
  const me = await currentUserId();
  const q = supabase
    .from('chat_messages')
    .select('id, user_id, body, created_at, profiles!user_id(display_name)')
    .order('created_at', { ascending: true })
    .limit(200);
  const { data, error } = await threadFilter(q, thread);
  if (error || !data) return [];
  return data.map((m) => ({
    id: m.id,
    userId: m.user_id,
    body: m.body,
    createdAt: m.created_at,
    name: m.profiles?.display_name || 'Someone',
    mine: me ? m.user_id === me : false,
  }));
}

// Post a message into a thread. Returns { error } on failure.
export async function sendMessage(thread, body) {
  if (!supabase) return { error: new Error('Chat is not configured.') };
  const me = await currentUserId();
  if (!me) return { error: new Error('Sign in to chat.') };
  const text = (body || '').trim();
  if (!text) return { skipped: true };
  const row = { user_id: me, body: text };
  if (thread.kind === 'run') row.run_id = thread.runId;
  else if (thread.kind === 'signal') row.signal_id = thread.signalId;
  else row.direct_key = thread.directKey;
  const { error } = await supabase.from('chat_messages').insert(row);
  return error ? { error } : { sent: true };
}

// Live updates. The handler fires on any chat_messages insert the user can see
// (RLS-scoped); callers re-load the affected thread / list.
export function subscribeChat(onChange) {
  if (!supabase) return () => {};
  try {
    const channel = supabase
      .channel(`chat_messages_${++channelSeq}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, onChange)
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
