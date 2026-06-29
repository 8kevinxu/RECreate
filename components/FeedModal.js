// Activity sheet: the social front door. One stream of friends' "down to hoop"
// signals (tap to open the session) and upcoming planned games (join / leave /
// cancel), with quick "I'm down" + "Plan" composers up top. Opened from the
// header; the header badge counts unread items (see lib/feed.js).
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadFeed } from '../lib/feed';
import { subscribeSignals } from '../lib/signals';
import { subscribeCheckins } from '../lib/playerCheckins';
import { joinRun, leaveRun, cancelRun, formatRunTime, subscribeRuns } from '../lib/runs';
import { sportMeta } from '../lib/sports';
import { viewLabel } from '../lib/datetime';
import SignalModal from './SignalModal';
import SessionModal from './SessionModal';
import RunModal from './RunModal';
import ChatThread from './ChatThread';

// Compact relative time for check-in rows: "just now", "5m ago", "2h ago".
function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function FeedModal({
  visible,
  onClose,
  asPage = false, // render inline as the Social tab page instead of a slide-up sheet
  embedded = false, // inside SocialScreen under its own tab bar — drop the top padding + title
  courtsById = {},
  courts = [],
  sport = 'basketball',
  userLocation = null,
}) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runBusy, setRunBusy] = useState(null);
  const [signalOpen, setSignalOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [selectedSignal, setSelectedSignal] = useState(null); // signal id for the session sheet
  const [chatThread, setChatThread] = useState(null); // open group-chat thread

  const openRunChat = (run) =>
    setChatThread({
      key: `run:${run.id}`,
      kind: 'run',
      runId: run.id,
      title: courtsById[run.courtId] || 'Pickup run',
      subtitle: formatRunTime(run.startsAt),
    });

  const openSignalChat = (s) =>
    setChatThread({
      key: `signal:${s.id}`,
      kind: 'signal',
      signalId: s.id,
      title: s.mine ? 'Your hoop' : `${s.name}’s hoop`,
      subtitle: s.plannedAt ? 'Session' : s.isNow ? 'Down now' : 'Scheduled',
    });

  const refresh = () => loadFeed().then(setItems);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    refresh().finally(() => setLoading(false));
    // Live-update while the sheet is open (signals, runs, and check-ins).
    const unsubS = subscribeSignals(refresh);
    const unsubR = subscribeRuns(refresh);
    const unsubC = subscribeCheckins(refresh);
    return () => {
      unsubS();
      unsubR();
      unsubC();
    };
  }, [visible]);

  // The signal whose session sheet is open; close it if it disappears.
  const selectedSignalObj =
    items.find((it) => it.kind === 'signal' && it.signal.id === selectedSignal)?.signal || null;
  useEffect(() => {
    if (selectedSignal && !selectedSignalObj) setSelectedSignal(null);
  }, [selectedSignal, selectedSignalObj]);

  const onToggleRun = async (run) => {
    setRunBusy(run.id);
    if (run.mine) await cancelRun(run.id);
    else if (run.joined) await leaveRun(run.id);
    else await joinRun(run.id);
    await refresh();
    setRunBusy(null);
  };

  const renderSignal = (s) => {
    const when = s.plannedAt
      ? `${viewLabel(s.plannedAt)}${
          s.plannedCourtId ? ` @ ${courtsById[s.plannedCourtId] || 'court'}` : ''
        }`
      : s.isNow
      ? 'now'
      : viewLabel(s.startsAt);
    // A confirmed session (court + time locked in) gets a ✅ to stand out.
    const lead = s.plannedAt ? '✅' : '🏀';
    return (
      <Pressable
        key={`signal:${s.id}`}
        style={styles.row}
        onPress={() => setSelectedSignal(s.id)}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName}>
            {lead} {s.mine ? 'You' : s.name} · <Text style={styles.when}>{when}</Text>
          </Text>
          <Text style={styles.note}>
            {s.count} in{s.note ? ` · ${s.note}` : ''}
            {s.plannedAt ? '' : ' · tap to plan'}
          </Text>
        </View>
        {(s.mine || s.joined) && (
          <Pressable style={styles.chatBtn} hitSlop={6} onPress={() => openSignalChat(s)}>
            <Text style={styles.chatBtnText}>💬</Text>
          </Pressable>
        )}
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    );
  };

  const renderRun = (run) => (
    <View key={`run:${run.id}`} style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>
          📅 {sportMeta(run.sport).emoji} {courtsById[run.courtId] || 'A court'}
        </Text>
        <Text style={styles.note}>
          {formatRunTime(run.startsAt)} · {run.mine ? 'You' : run.hostName} · {run.count} going
          {run.note ? ` · ${run.note}` : ''}
        </Text>
      </View>
      {(run.mine || run.joined) && (
        <Pressable style={styles.chatBtn} hitSlop={6} onPress={() => openRunChat(run)}>
          <Text style={styles.chatBtnText}>💬</Text>
        </Pressable>
      )}
      <Pressable
        style={[styles.smallBtn, run.mine || run.joined ? styles.declineBtn : styles.acceptBtn]}
        disabled={runBusy === run.id}
        onPress={() => onToggleRun(run)}
      >
        <Text style={run.mine || run.joined ? styles.declineText : styles.acceptText}>
          {runBusy === run.id ? '…' : run.mine ? 'Cancel' : run.joined ? 'Leave' : 'I’m in'}
        </Text>
      </Pressable>
    </View>
  );

  const renderCheckin = (c) => (
    <View key={`checkin:${c.id}`} style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>
          {sportMeta(c.sport).emoji} {c.mine ? 'You' : c.name} checked into{' '}
          {courtsById[c.courtId] || 'a court'}
        </Text>
        <Text style={styles.note}>{timeAgo(c.createdAt)}</Text>
      </View>
    </View>
  );

  const content = (
    <>
      {!embedded && (
        <View style={styles.header}>
          <Text style={styles.title}>Activity</Text>
          {!asPage && (
            <Pressable hitSlop={10} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.composeRow}>
        <Pressable style={styles.composeBtn} onPress={() => setSignalOpen(true)}>
          <Text style={styles.composeText}>🏀 I’m down</Text>
        </Pressable>
        <Pressable style={[styles.composeBtn, styles.composeAlt]} onPress={() => setRunOpen(true)}>
          <Text style={styles.composeText}>＋ Plan</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2f74d6" />
        </View>
      ) : items.length === 0 ? (
        <Text style={styles.muted}>
          Nothing going on yet — tap “I’m down” or “Plan” to get your friends moving.
        </Text>
      ) : (
        <ScrollView style={asPage && styles.pageList} keyboardShouldPersistTaps="handled">
          {items.map((it) =>
            it.kind === 'signal'
              ? renderSignal(it.signal)
              : it.kind === 'run'
              ? renderRun(it.run)
              : renderCheckin(it.checkin)
          )}
        </ScrollView>
      )}

      <SignalModal visible={signalOpen} onClose={() => setSignalOpen(false)} onPosted={refresh} />
      <RunModal
        visible={runOpen}
        courts={courts}
        sport={sport}
        userLocation={userLocation}
        onClose={() => setRunOpen(false)}
        onCreated={refresh}
      />
      <SessionModal
        visible={!!selectedSignalObj}
        signal={selectedSignalObj}
        courts={courts}
        sport={sport}
        onClose={() => setSelectedSignal(null)}
        onChanged={refresh}
      />
      <ChatThread
        visible={!!chatThread}
        thread={chatThread}
        onClose={() => setChatThread(null)}
      />
    </>
  );

  if (asPage)
    return (
      <View
        style={[
          styles.page,
          { paddingTop: embedded ? 2 : insets.top + 14, paddingBottom: insets.bottom + 84 },
        ]}
      >
        {content}
      </View>
    );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          {content}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 18, paddingTop: 14 },
  pageList: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(13,27,42,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 28,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  close: { fontSize: 18, color: '#90a0b0' },
  loading: { paddingVertical: 30, alignItems: 'center' },

  composeRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  composeBtn: {
    flex: 1,
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
  },
  composeAlt: { backgroundColor: '#2f74d6' },
  composeText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  rowName: { fontSize: 15, color: '#1a2a3a', fontWeight: '600', flex: 1 },
  when: { color: '#1f9d55', fontWeight: '700' },
  note: { fontSize: 13, color: '#5b6b7b', marginTop: 1 },
  chevron: { fontSize: 22, color: '#c0ccd8', fontWeight: '700', paddingLeft: 8 },
  chatBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  chatBtnText: { fontSize: 18 },

  smallBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  acceptBtn: { backgroundColor: '#1f9d55' },
  acceptText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  declineBtn: { backgroundColor: '#eef1f4' },
  declineText: { color: '#5b6b7b', fontWeight: '700', fontSize: 13 },
  muted: { fontSize: 14, color: '#9aa7b4', fontStyle: 'italic', paddingVertical: 16, textAlign: 'center' },
});
