// A single conversation: message bubbles + composer. Works for run/signal group
// chats and 1:1 direct chats (the `thread` descriptor carries the kind). Live via
// subscribeChat; marks the thread read on open and on each new message.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadMessages, sendMessage, subscribeChat, markThreadRead } from '../lib/chat';

export default function ChatThread({ visible, thread, onClose, onActivity }) {
  const insets = useSafeAreaInsets();
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

  if (!thread) return null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <Pressable hitSlop={10} onPress={onClose}>
            <Text style={styles.back}>‹ Chats</Text>
          </Pressable>
          <View style={styles.titleWrap}>
            <Text style={styles.title} numberOfLines={1}>
              {thread.title}
            </Text>
            {!!thread.subtitle && <Text style={styles.subtitle}>{thread.subtitle}</Text>}
          </View>
          <View style={{ width: 56 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={insets.top + 8}
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
                  No messages yet — say hi{thread.kind !== 'direct' ? ' to the group' : ''}.
                </Text>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const showName = !m.mine && (!prev || prev.userId !== m.userId);
                return (
                  <View
                    key={m.id}
                    style={[styles.bubbleRow, m.mine ? styles.rowMine : styles.rowTheirs]}
                  >
                    <View style={[styles.bubble, m.mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                      {showName && <Text style={styles.sender}>{m.name}</Text>}
                      <Text style={m.mine ? styles.bodyMine : styles.bodyTheirs}>{m.body}</Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}

          <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
            <TextInput
              style={styles.input}
              placeholder="Message"
              placeholderTextColor="#9aa7b4"
              value={draft}
              onChangeText={setDraft}
              multiline
              maxLength={1000}
            />
            <Pressable
              style={[styles.sendBtn, (!draft.trim() || sending) && styles.sendBtnOff]}
              onPress={onSend}
              disabled={!draft.trim() || sending}
            >
              <Text style={styles.sendText}>{sending ? '…' : 'Send'}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#eef1f5' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e6e9ee',
    backgroundColor: '#fff',
  },
  back: { fontSize: 16, color: '#2f74d6', fontWeight: '700', width: 56 },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  subtitle: { fontSize: 12, color: '#6b7a8a', marginTop: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 16 },
  empty: { textAlign: 'center', color: '#9aa7b4', fontStyle: 'italic', marginTop: 24, fontSize: 14 },

  bubbleRow: { flexDirection: 'row', marginVertical: 3 },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '78%', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12 },
  bubbleMine: { backgroundColor: '#2f74d6', borderBottomRightRadius: 5 },
  bubbleTheirs: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e9ee', borderBottomLeftRadius: 5 },
  sender: { fontSize: 11, fontWeight: '800', color: '#2f74d6', marginBottom: 2 },
  bodyMine: { color: '#fff', fontSize: 15, lineHeight: 20 },
  bodyTheirs: { color: '#1f2a37', fontSize: 15, lineHeight: 20 },

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
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: '#eef1f5',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 15,
    color: '#0d1b2a',
  },
  sendBtn: {
    backgroundColor: '#2f74d6',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendBtnOff: { backgroundColor: '#b8c6d4' },
  sendText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
