// Chats list: every conversation you're in — run/signal group chats (you're
// dropped in when you join) and 1:1 friend chats — plus a row to start a new
// direct chat. Swipe a row left to delete (hide) it; deleted chats live in a
// "Deleted" view where they can be restored. Tapping a thread opens ChatThread.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { loadThreads, subscribeChat, directThreadWith, setThreadDeleted } from '../lib/chat';
import { listFriends } from '../lib/friends';
import { useI18n } from '../lib/i18n';
import ChatThread from './ChatThread';
import SwipeRow from './SwipeRow';

const KIND_EMOJI = { run: '📅', signal: '🏀', direct: '💬' };
const AVATAR_COLORS = ['#2f74d6', '#1f9d55', '#e8730c', '#6b3fa0', '#b03a73', '#1f8a86', '#c2410c'];

// `tr` is the i18n translator (passed in because this file uses `t` for threads).
function timeAgo(tr, iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return tr('chat.now');
  if (m < 60) return tr('chat.minShort', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('chat.hourShort', { n: h });
  return tr('chat.dayShort', { n: Math.round(h / 24) });
}

function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}
function colorFor(s) {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function Avatar({ name, kind, size = 50 }) {
  const isGroup = kind && kind !== 'direct';
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: isGroup ? '#eef1f5' : colorFor(name) },
      ]}
    >
      {isGroup ? (
        <Text style={{ fontSize: size * 0.46 }}>{KIND_EMOJI[kind]}</Text>
      ) : (
        <Text style={[styles.avatarText, { fontSize: size * 0.36 }]}>{initials(name)}</Text>
      )}
    </View>
  );
}

export default function ChatsScreen({ courtsById = {} }) {
  const { t: tr } = useI18n();
  const [threads, setThreads] = useState([]);
  const [friends, setFriends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(null); // open thread descriptor
  const [showDeleted, setShowDeleted] = useState(false);
  const [query, setQuery] = useState('');

  const refresh = () => loadThreads(courtsById).then(setThreads);

  useEffect(() => {
    setLoading(true);
    Promise.all([refresh(), listFriends().then(setFriends)]).finally(() => setLoading(false));
    const unsub = subscribeChat(() => refresh());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = query.trim().toLowerCase();
  const active = threads.filter((t) => !t.deleted && (!q || (t.title || '').toLowerCase().includes(q)));
  const deleted = threads.filter((t) => t.deleted);

  const onDelete = async (key) => {
    await setThreadDeleted(key, true);
    refresh();
  };
  const onRestore = async (key) => {
    await setThreadDeleted(key, false);
    refresh();
  };

  const openFriend = async (f) => {
    const t = await directThreadWith(f);
    if (t) setOpen(t);
  };

  const preview = (t) =>
    t.lastMessage ? `${t.lastSender === 'You' ? tr('chat.youPrefix') : ''}${t.lastMessage}` : t.subtitle;

  const threadContent = (t) => (
    <>
      <Avatar name={t.title} kind={t.kind} size={50} />
      <View style={{ flex: 1 }}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {t.title}
          </Text>
          {!!t.lastAt && <Text style={styles.rowTime}>{timeAgo(tr, t.lastAt)}</Text>}
        </View>
        <View style={styles.rowBottom}>
          <Text style={styles.rowPreview} numberOfLines={1}>
            {preview(t)}
          </Text>
          {t.unread > 0 && (
            <View style={styles.unread}>
              <Text style={styles.unreadText}>{t.unread}</Text>
            </View>
          )}
        </View>
      </View>
    </>
  );

  const chatModal = (
    <ChatThread
      visible={!!open}
      thread={open}
      onClose={() => {
        setOpen(null);
        refresh();
      }}
      onActivity={refresh}
    />
  );

  // Deleted view: restore-able list of hidden chats.
  if (showDeleted) {
    return (
      <View style={styles.wrap}>
        <Pressable style={styles.backRow} onPress={() => setShowDeleted(false)} hitSlop={8}>
          <Text style={styles.backText}>{tr('chat.backChats')}</Text>
        </Pressable>
        <Text style={styles.deletedTitle}>{tr('chat.deletedTitle')}</Text>
        {deleted.length === 0 ? (
          <Text style={styles.empty}>{tr('chat.noDeleted')}</Text>
        ) : (
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
            {deleted.map((t) => (
              <View key={t.key} style={styles.delRow}>
                <Pressable style={styles.delTap} onPress={() => setOpen(t)}>
                  {threadContent(t)}
                </Pressable>
                <Pressable style={styles.restoreBtn} onPress={() => onRestore(t.key)}>
                  <Text style={styles.restoreText}>{tr('chat.restore')}</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        {chatModal}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.search}>
        <Ionicons name="search" size={16} color="#8a99a8" />
        <TextInput
          style={styles.searchInput}
          placeholder={tr('chat.searchPh')}
          placeholderTextColor="#9aa7b4"
          value={query}
          onChangeText={setQuery}
          returnKeyType="search"
          clearButtonMode="while-editing"
          autoCorrect={false}
        />
      </View>

      {friends.length > 0 && (
        <View>
          <Text style={styles.sectionLabel}>{tr('chat.messageFriend')}</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.friendRow}
          >
            {friends.map((f) => (
              <Pressable key={f.id} style={styles.friendChip} onPress={() => openFriend(f)}>
                <View style={[styles.friendAvatar, { backgroundColor: colorFor(f.name) }]}>
                  <Text style={styles.friendAvatarText}>{initials(f.name)}</Text>
                </View>
                <Text style={styles.friendName} numberOfLines={1}>
                  {f.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2f74d6" />
        </View>
      ) : active.length === 0 && deleted.length === 0 ? (
        <Text style={styles.empty}>{tr('chat.empty')}</Text>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 24 }}>
          {active.map((t) => (
            <SwipeRow key={t.key} actionLabel={tr('delete')} actionColor="#e5484d" onAction={() => onDelete(t.key)}>
              <Pressable style={styles.row} onPress={() => setOpen(t)}>
                {threadContent(t)}
              </Pressable>
            </SwipeRow>
          ))}
          {deleted.length > 0 && (
            <Pressable style={styles.deletedEntry} onPress={() => setShowDeleted(true)}>
              <Text style={styles.deletedEntryText}>{tr('chat.deletedCount', { n: deleted.length })}</Text>
            </Pressable>
          )}
        </ScrollView>
      )}

      {chatModal}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
    borderWidth: 1,
    borderColor: '#e6e9ee',
    marginBottom: 12,
  },
  searchInput: { flex: 1, fontSize: 15, color: '#0d1b2a' },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#6b7a8a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  friendRow: { gap: 14, paddingBottom: 14, paddingRight: 8 },
  friendChip: { alignItems: 'center', width: 56 },
  friendAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  friendAvatarText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  friendName: { fontSize: 11, color: '#46586a', fontWeight: '600', maxWidth: 56, textAlign: 'center' },

  loading: { paddingVertical: 40, alignItems: 'center' },
  empty: {
    fontSize: 14,
    color: '#9aa7b4',
    fontStyle: 'italic',
    paddingVertical: 24,
    lineHeight: 20,
  },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800' },

  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eef1f4',
    backgroundColor: '#fff',
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 3 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: '#0d1b2a', flex: 1 },
  rowTime: { fontSize: 12, color: '#9aa7b4', marginLeft: 8 },
  rowPreview: { fontSize: 13, color: '#5b6b7b', flex: 1 },
  unread: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#e8730c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    marginLeft: 8,
  },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '800' },

  deletedEntry: { paddingVertical: 16, alignItems: 'center' },
  deletedEntryText: { fontSize: 13, color: '#8a99a8', fontWeight: '700' },

  backRow: { paddingVertical: 4 },
  backText: { fontSize: 16, color: '#2f74d6', fontWeight: '700' },
  deletedTitle: { fontSize: 18, fontWeight: '800', color: '#0d1b2a', marginTop: 4, marginBottom: 4 },
  delRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#eef1f4' },
  delTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  restoreBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#e7f5ec' },
  restoreText: { color: '#1f9d55', fontWeight: '800', fontSize: 13 },
});
