// A single conversation: message bubbles + composer. Works for run/signal group
// chats and 1:1 direct chats (the `thread` descriptor carries the kind). Live via
// subscribeChat; marks the thread read on open and on each new message.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadMessages, sendMessage, subscribeChat, markThreadRead } from '../lib/chat';
import { reportContent } from '../lib/reports';
import { blockUser } from '../lib/blocks';
import { fmtClock } from '../lib/datetime';
import { useI18n } from '../lib/i18n';

const KIND_EMOJI = { run: '📅', signal: '🤙', direct: '💬' };
const AVATAR_COLORS = ['#2f74d6', '#1f9d55', '#e8730c', '#6b3fa0', '#b03a73', '#1f8a86', '#c2410c'];
const LOCALE = { en: 'en-US', zh: 'zh-CN', es: 'es-ES' };

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
const sameDay = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};
const fmtTime = (iso) => {
  const d = new Date(iso);
  return fmtClock(d.getHours(), d.getMinutes());
};

function Avatar({ name, kind, size = 30 }) {
  const isGroup = kind && kind !== 'direct';
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: isGroup ? '#eef1f5' : colorFor(name) },
      ]}
    >
      {isGroup ? (
        <Text style={{ fontSize: size * 0.5 }}>{KIND_EMOJI[kind]}</Text>
      ) : (
        <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initials(name)}</Text>
      )}
    </View>
  );
}

export default function ChatThread({ visible, thread, onClose, onActivity }) {
  const insets = useSafeAreaInsets();
  const { t, lang } = useI18n();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);

  const refresh = () =>
    loadMessages(thread).then((m) => {
      setMessages(m);
      markThreadRead(thread.key);
    });

  useEffect(() => {
    if (!visible || !thread) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
    const unsub = subscribeChat(() => refresh());
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, thread?.key]);

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    const res = await sendMessage(thread, text);
    if (res?.error) setDraft(text); // restore on failure
    await refresh();
    onActivity && onActivity();
    setSending(false);
  };

  // Long-press someone else's message → report it or block the sender (required
  // for App Store UGC moderation). Blocking hides their messages on refresh.
  const moderate = (m) => {
    if (m.mine) return;
    Alert.alert(m.name, undefined, [
      { text: t('mod.reportMessage'), onPress: () => doReport(m) },
      { text: t('mod.blockUser', { name: m.name }), style: 'destructive', onPress: () => confirmBlock(m) },
      { text: t('cancel'), style: 'cancel' },
    ]);
  };
  const doReport = async (m) => {
    const { error } = await reportContent({ kind: 'message', refId: m.id, reportedUser: m.userId });
    Alert.alert(error ? t('mod.fail') : t('mod.reported'));
  };
  const confirmBlock = (m) => {
    Alert.alert(t('mod.blockTitle', { name: m.name }), t('mod.blockBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('mod.block'),
        style: 'destructive',
        onPress: async () => {
          const { error } = await blockUser(m.userId);
          if (error) return Alert.alert(t('mod.fail'));
          await refresh();
          onActivity && onActivity();
          if (thread.kind === 'direct') onClose();
        },
      },
    ]);
  };

  const dividerLabel = (iso) => {
    const now = new Date();
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (sameDay(iso, now)) return t('date.today');
    if (sameDay(iso, y)) return t('chat.yesterday');
    return new Date(iso).toLocaleDateString(LOCALE[lang] || 'en-US', { month: 'long', day: 'numeric' });
  };

  if (!thread) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top + 6 }]}>
        <View style={styles.header}>
          <Pressable hitSlop={10} onPress={onClose} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={26} color="#2f74d6" />
          </Pressable>
          <Avatar name={thread.title} kind={thread.kind} size={38} />
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {thread.title}
            </Text>
            {!!thread.subtitle && (
              <Text style={styles.subtitle} numberOfLines={1}>
                {thread.subtitle}
              </Text>
            )}
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top + 6}
        >
          {loading ? (
            <View style={styles.loading}>
              <ActivityIndicator color="#2f74d6" />
            </View>
          ) : (
            <ScrollView
              ref={scrollRef}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
              keyboardShouldPersistTaps="handled"
            >
              {messages.length === 0 && (
                <Text style={styles.empty}>
                  {t(thread.kind !== 'direct' ? 'chat.noMessagesGroup' : 'chat.noMessagesDirect')}
                </Text>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const next = messages[i + 1];
                const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
                const showName =
                  !m.mine && thread.kind !== 'direct' && (newDay || !prev || prev.userId !== m.userId);
                const lastOfGroup =
                  !next || next.mine !== m.mine || next.userId !== m.userId || !sameDay(next.createdAt, m.createdAt);
                return (
                  <React.Fragment key={m.id}>
                    {newDay && (
                      <View style={styles.divider}>
                        <Text style={styles.dividerText}>{dividerLabel(m.createdAt)}</Text>
                      </View>
                    )}
                    <View style={[styles.row, m.mine ? styles.rowMine : styles.rowTheirs]}>
                      {!m.mine && (
                        <View style={styles.avatarSlot}>
                          {lastOfGroup && <Avatar name={m.name} kind={thread.kind} size={28} />}
                        </View>
                      )}
                      <View style={[styles.col, m.mine ? styles.colMine : styles.colTheirs]}>
                        <Pressable
                          onLongPress={!m.mine ? () => moderate(m) : undefined}
                          delayLongPress={350}
                          style={[
                            styles.bubble,
                            m.mine ? styles.bubbleMine : styles.bubbleTheirs,
                            m.mine
                              ? lastOfGroup && styles.bubbleMineTail
                              : lastOfGroup && styles.bubbleTheirsTail,
                          ]}
                        >
                          {showName && <Text style={styles.sender}>{m.name}</Text>}
                          <Text style={m.mine ? styles.bodyMine : styles.bodyTheirs}>{m.body}</Text>
                        </Pressable>
                        {lastOfGroup && (
                          <Text style={[styles.time, m.mine ? styles.timeMine : styles.timeTheirs]}>
                            {fmtTime(m.createdAt)}
                          </Text>
                        )}
                      </View>
                    </View>
                  </React.Fragment>
                );
              })}
            </ScrollView>
          )}

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <View style={styles.inputPill}>
              <TextInput
                style={styles.input}
                placeholder={t('chat.messagePh')}
                placeholderTextColor="#9aa7b4"
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={1000}
              />
            </View>
            <Pressable
              style={[styles.sendBtn, (!draft.trim() || sending) && styles.sendBtnOff]}
              onPress={onSend}
              disabled={!draft.trim() || sending}
            >
              {sending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="send" size={18} color="#fff" style={{ marginLeft: 2 }} />
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e6e9ee',
    backgroundColor: '#fff',
  },
  backBtn: { padding: 2 },
  titleWrap: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  subtitle: { fontSize: 12, color: '#6b7a8a', marginTop: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontWeight: '800' },

  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 16 },
  empty: { textAlign: 'center', color: '#9aa7b4', fontStyle: 'italic', marginTop: 24, fontSize: 14 },

  divider: { alignItems: 'center', marginVertical: 12 },
  dividerText: {
    fontSize: 12,
    color: '#7a8896',
    fontWeight: '700',
    backgroundColor: '#e9edf1',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    overflow: 'hidden',
  },

  row: { flexDirection: 'row', alignItems: 'flex-end', marginVertical: 2 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  avatarSlot: { width: 28, marginRight: 8, alignItems: 'center' },
  col: { maxWidth: '76%' },
  colMine: { alignItems: 'flex-end' },
  colTheirs: { alignItems: 'flex-start' },

  bubble: { borderRadius: 18, paddingVertical: 9, paddingHorizontal: 13 },
  bubbleMine: { backgroundColor: '#2f74d6' },
  bubbleMineTail: { borderBottomRightRadius: 5 },
  bubbleTheirs: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e9ee' },
  bubbleTheirsTail: { borderBottomLeftRadius: 5 },
  sender: { fontSize: 11, fontWeight: '800', color: '#2f74d6', marginBottom: 2 },
  bodyMine: { color: '#fff', fontSize: 15, lineHeight: 20 },
  bodyTheirs: { color: '#1f2a37', fontSize: 15, lineHeight: 20 },
  time: { fontSize: 11, color: '#9aa7b4', marginTop: 3 },
  timeMine: { marginRight: 4 },
  timeTheirs: { marginLeft: 4 },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e6e9ee',
    backgroundColor: '#fff',
  },
  inputPill: {
    flex: 1,
    backgroundColor: '#eef1f5',
    borderRadius: 22,
    paddingHorizontal: 16,
    justifyContent: 'center',
    minHeight: 44,
  },
  input: { maxHeight: 110, paddingVertical: 10, fontSize: 15, color: '#0d1b2a' },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#2f74d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnOff: { backgroundColor: '#b8c6d4' },
});
