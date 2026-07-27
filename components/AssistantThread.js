// The assistant chat: a thread of bubbles plus a composer, embedded as the third
// segment of the Social tab. Renders only when EXPO_PUBLIC_ASSISTANT_URL is set
// (see lib/assistant.js) — SocialScreen hides the segment otherwise.
//
// The conversation lives here, in component state, and is posted in full on every
// turn: the service is stateless. Nothing persists across an app restart, which
// is deliberate — these are throwaway lookups, not correspondence.
//
// **Latency is the design constraint.** A local model takes 20–45 seconds to
// answer a question that needs a tool call, so the waiting state has to look
// deliberate rather than hung: a labelled bubble with a live elapsed counter,
// and a note after 15s that a local model is slow. Without that, every first-time
// user concludes it's broken and force-quits at second ten.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import { useI18n } from '../lib/i18n';
import { ask, AssistantError } from '../lib/assistant';

// Starters shown on the empty thread. They exist to teach the tool surface: each
// one lands on a different retrieval path (courts by time, pools, classes), so a
// first-time user discovers what this can answer instead of guessing.
const STARTER_KEYS = ['assistant.suggestA', 'assistant.suggestB', 'assistant.suggestC'];

// After this long, add a line explaining the wait. Chosen just past a hosted
// model's worst case, so it only appears when a local model really is grinding.
const SLOW_AFTER_SECONDS = 15;

export default function AssistantThread({ city = 'sf', userLocation = null }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [turns, setTurns] = useState([]); // [{ role, content }]
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null); // { message, retryable }
  const scroller = useRef(null);
  const lastAsked = useRef(''); // for Retry, which must not re-send a partial draft

  // Live counter while waiting, so the pending bubble is visibly progressing.
  useEffect(() => {
    if (!pending) return undefined;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated: true }));
  }, []);

  const send = useCallback(
    async (text) => {
      const question = text.trim();
      if (!question || pending) return;
      lastAsked.current = question;
      setDraft('');
      setError(null);

      // Optimistic: the question appears immediately, and the history sent to the
      // service includes it (the service answers the LAST user message).
      const history = [...turns, { role: 'user', content: question }];
      setTurns(history);
      setPending(true);
      scrollDown();

      try {
        const { reply } = await ask(history, { city, location: userLocation });
        setTurns((prev) => [...prev, { role: 'assistant', content: reply }]);
      } catch (err) {
        const kind = err instanceof AssistantError ? err.message : 'failed';
        setError({
          message: t(`assistant.err.${kind}`) || t('assistant.err.failed'),
          // The service's own 503 text says how to fix it ("Try: ollama serve"),
          // which is exactly what a developer needs and harmless to a user.
          detail: err?.detail || '',
          retryable: err?.retryable !== false,
        });
      } finally {
        setPending(false);
        scrollDown();
      }
    },
    [turns, pending, city, userLocation, t, scrollDown],
  );

  const retry = useCallback(() => {
    // Drop the failed exchange's question and ask it again, so a retry doesn't
    // stack duplicate user bubbles.
    setTurns((prev) => {
      const trimmed = [...prev];
      if (trimmed[trimmed.length - 1]?.role === 'user') trimmed.pop();
      return trimmed;
    });
    setError(null);
    setTimeout(() => send(lastAsked.current), 0);
  }, [send]);

  const reset = useCallback(() => {
    setTurns([]);
    setError(null);
    setDraft('');
  }, []);

  const empty = turns.length === 0 && !pending && !error;

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <ScrollView
        ref={scroller}
        style={styles.thread}
        contentContainerStyle={styles.threadInner}
        onContentSizeChange={scrollDown}
        keyboardDismissMode="interactive"
      >
        {empty ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="sparkles" size={22} color="#2f74d6" />
            </View>
            <Text style={styles.emptyTitle}>{t('assistant.emptyTitle')}</Text>
            <Text style={styles.emptyBody}>{t('assistant.emptyBody')}</Text>
            {STARTER_KEYS.map((key) => (
              <Pressable key={key} style={styles.starter} onPress={() => send(t(key))}>
                <Text style={styles.starterText}>{t(key)}</Text>
                <Ionicons name="arrow-forward" size={14} color="#2f74d6" />
              </Pressable>
            ))}
          </View>
        ) : (
          turns.map((turn, index) => {
            const mine = turn.role === 'user';
            return (
              <View
                key={`${index}-${turn.role}`}
                style={[styles.row, mine ? styles.rowMine : styles.rowTheirs]}
              >
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={mine ? styles.bodyMine : styles.bodyTheirs}>{turn.content}</Text>
                </View>
              </View>
            );
          })
        )}

        {pending && (
          <View style={[styles.row, styles.rowTheirs]}>
            <View style={[styles.bubble, styles.bubbleTheirs, styles.pending]}>
              <ActivityIndicator size="small" color="#6b7a8a" />
              <Text style={styles.pendingText}>
                {t('assistant.thinking')}
                {elapsed > 2 ? ` ${elapsed}s` : ''}
              </Text>
            </View>
          </View>
        )}
        {pending && elapsed >= SLOW_AFTER_SECONDS && (
          <Text style={styles.slowNote}>{t('assistant.slow')}</Text>
        )}

        {!!error && (
          <View style={[styles.row, styles.rowTheirs]}>
            <View style={[styles.bubble, styles.bubbleError]}>
              <Text style={styles.errorText}>{error.message}</Text>
              {!!error.detail && <Text style={styles.errorDetail}>{error.detail}</Text>}
              {error.retryable && (
                <Pressable style={styles.retryBtn} onPress={retry}>
                  <Ionicons name="refresh" size={14} color="#2f74d6" />
                  <Text style={styles.retryText}>{t('assistant.retry')}</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}

        {turns.length > 0 && <Text style={styles.disclaimer}>{t('assistant.disclaimer')}</Text>}
      </ScrollView>

      {/* The BottomNav is an absolutely-positioned floating pill over the tab
          content, so the composer has to clear it by hand or it renders behind
          the nav and is invisible. Same +96 clearance ClassesScreen uses. */}
      <View style={[styles.composer, { paddingBottom: insets.bottom + 96 }]}>
        <View style={styles.inputPill}>
          <TextInput
            style={styles.input}
            placeholder={t('assistant.placeholder')}
            placeholderTextColor="#9aa7b4"
            value={draft}
            onChangeText={setDraft}
            multiline
            maxLength={2000}
            editable={!pending}
            onSubmitEditing={() => send(draft)}
          />
        </View>
        {turns.length > 0 && !pending && (
          <Pressable
            style={styles.clearBtn}
            onPress={reset}
            accessibilityRole="button"
            accessibilityLabel={t('assistant.clear')}
          >
            <Ionicons name="trash-outline" size={18} color="#6b7a8a" />
          </Pressable>
        )}
        <Pressable
          style={[styles.sendBtn, (!draft.trim() || pending) && styles.sendBtnOff]}
          onPress={() => send(draft)}
          disabled={!draft.trim() || pending}
          accessibilityRole="button"
          accessibilityLabel={t('assistant.send')}
        >
          {pending ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="send" size={18} color="#fff" style={{ marginLeft: 2 }} />
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#f4f6f8' },
  thread: { flex: 1 },
  threadInner: { padding: 14, paddingBottom: 8, gap: 8 },

  // Bubbles follow ChatThread so the assistant reads as part of the same app.
  row: { flexDirection: 'row', maxWidth: '100%' },
  rowMine: { justifyContent: 'flex-end' },
  rowTheirs: { justifyContent: 'flex-start' },
  bubble: { borderRadius: 18, paddingVertical: 9, paddingHorizontal: 13, maxWidth: '86%' },
  bubbleMine: { backgroundColor: '#2f74d6', borderBottomRightRadius: 5 },
  bubbleTheirs: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e6e9ee',
    borderBottomLeftRadius: 5,
  },
  bodyMine: { color: '#fff', fontSize: 15, lineHeight: 21 },
  bodyTheirs: { color: '#0d1b2a', fontSize: 15, lineHeight: 21 },

  pending: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pendingText: { color: '#6b7a8a', fontSize: 14, fontWeight: '600' },
  slowNote: {
    color: '#8a97a4',
    fontSize: 11.5,
    marginLeft: 6,
    marginTop: -2,
    fontStyle: 'italic',
  },

  bubbleError: {
    backgroundColor: '#fdecec',
    borderWidth: 1,
    borderColor: '#f5c2c2',
    borderRadius: 18,
    borderBottomLeftRadius: 5,
    paddingVertical: 10,
    paddingHorizontal: 13,
    maxWidth: '90%',
  },
  errorText: { color: '#a3282c', fontSize: 14, fontWeight: '600' },
  errorDetail: { color: '#8a5b5d', fontSize: 12, marginTop: 4 },
  retryBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  retryText: { color: '#2f74d6', fontSize: 13, fontWeight: '700' },

  disclaimer: {
    color: '#9aa7b4',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
    marginHorizontal: 20,
  },

  empty: { alignItems: 'center', paddingTop: 18, paddingHorizontal: 8, gap: 8 },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#eef4fd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: '#0d1b2a' },
  emptyBody: {
    fontSize: 13,
    color: '#6b7a8a',
    textAlign: 'center',
    marginBottom: 6,
    lineHeight: 18,
  },
  starter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e6e9ee',
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  starterText: { flex: 1, fontSize: 13.5, color: '#0d1b2a', fontWeight: '600' },

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
  clearBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#2f74d6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnOff: { backgroundColor: '#b9c6d4' },
});
