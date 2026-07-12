// Activity sheet: the social front door. One stream of friends' "down to play"
// signals (tap to open the session) and upcoming planned games (join / leave /
// cancel), with quick "I'm down" + "Plan" composers up top. Opened from the
// header; the header badge counts unread items (see lib/feed.js).
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadFeed } from '../lib/feed';
import { subscribeSignals } from '../lib/signals';
import { subscribeCheckins } from '../lib/playerCheckins';
import { joinRun, leaveRun, cancelRun, formatRunTime, subscribeRuns } from '../lib/runs';
import { sendMessage } from '../lib/chat';
import { sportMeta } from '../lib/sports';
import { viewLabel } from '../lib/datetime';
import { haversineMiles, formatDistance } from '../lib/distance';
import { reportContent } from '../lib/reports';
import { blockUser } from '../lib/blocks';
import { useAuth } from '../lib/auth';
import { useI18n, tg } from '../lib/i18n';
import SignalModal from './SignalModal';
import SessionModal from './SessionModal';
import RunModal from './RunModal';
import ChatThread from './ChatThread';
import ScrollTopFab, { useScrollTop } from './ScrollTopFab';

// Compact relative time for check-in rows. Shares the app's localized time keys.
function timeAgo(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return tg('time.justNow');
  if (m < 60) return tg('time.minAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tg('time.hrAgo', { n: h });
  return tg('time.dayAgo', { n: Math.round(h / 24) });
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
  onPickCourt, // open a court (its card, on a sport) on the map tab
  onOpenFriends, // open the Friends sheet (signed-in only; App.js owns it)
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollRef, onScroll, showTop, scrollToTop } = useScrollTop(40);
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
      title: courtsById[run.courtId] || t('feed.pickupRun'),
      subtitle: formatRunTime(run.startsAt),
    });

  const openSignalChat = (s) =>
    setChatThread({
      key: `signal:${s.id}`,
      kind: 'signal',
      signalId: s.id,
      title: s.mine ? t('feed.yourHoop') : t('feed.theirHoop', { name: s.name }),
      subtitle: s.plannedAt
        ? t('feed.subSession')
        : s.isNow
        ? t('feed.subDownNow')
        : t('feed.subScheduled'),
    });

  // After joining / suggesting from the session sheet: announce it in the signal's
  // group chat and drop the user straight into that chat.
  const onJoinedChat = async (sig, body) => {
    setSelectedSignal(null);
    if (sig && body) {
      try {
        await sendMessage({ kind: 'signal', signalId: sig.id }, body);
      } catch (e) {
        // non-fatal — still open the chat
      }
    }
    if (sig) openSignalChat(sig);
    refresh();
  };

  const refresh = () => loadFeed().then(setItems);

  // Pull-to-refresh (manual reload on top of the live subscriptions).
  const onRefresh = () => {
    setRefreshing(true);
    refresh().finally(() => setRefreshing(false));
  };

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
    else {
      const res = await joinRun(run.id);
      // Signed-out joins fail silently otherwise — say why (public runs are
      // visible without an account, but joining one needs it).
      if (res?.error) Alert.alert(res.error.message);
    }
    await refresh();
    setRunBusy(null);
  };

  // Long-press someone else's post → report it or block them (same App-Store
  // UGC moderation pattern as chat messages in ChatThread).
  const moderate = ({ name, reportKey, kind, refId, userId }) => {
    Alert.alert(name, undefined, [
      { text: t(reportKey), onPress: () => doReport({ kind, refId, userId }) },
      {
        text: t('mod.blockUser', { name }),
        style: 'destructive',
        onPress: () => confirmBlock({ name, userId }),
      },
      { text: t('cancel'), style: 'cancel' },
    ]);
  };
  const doReport = async ({ kind, refId, userId }) => {
    const { error } = await reportContent({ kind, refId, reportedUser: userId });
    Alert.alert(error ? t('mod.fail') : t('mod.reported'));
  };
  const confirmBlock = ({ name, userId }) => {
    Alert.alert(t('mod.blockTitle', { name }), t('mod.blockBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('mod.block'),
        style: 'destructive',
        onPress: async () => {
          const { error } = await blockUser(userId);
          if (error) return Alert.alert(t('mod.fail'));
          refresh(); // feed loaders filter blocked users at source
        },
      },
    ]);
  };

  // Straight-line distance to a court, for run rows ("is this open run near me?").
  const distanceTo = (courtId) => {
    if (!userLocation) return '';
    const court = courts.find((c) => c.id === courtId);
    if (!court) return '';
    return formatDistance(
      haversineMiles(userLocation.lat, userLocation.lng, court.lat, court.lng)
    );
  };

  const renderSignal = (s) => {
    const when = s.plannedAt
      ? `${viewLabel(s.plannedAt)}${
          s.plannedCourtId ? ` @ ${courtsById[s.plannedCourtId] || t('feed.aCourt')}` : ''
        }`
      : s.isNow
      ? t('feed.nowWhen')
      : viewLabel(s.startsAt);
    // A confirmed session (court + time locked in) gets a ✅ to stand out;
    // otherwise the signal's sport emoji.
    const lead = s.plannedAt ? '✅' : sportMeta(s.sport).emoji;
    return (
      <Pressable
        key={`signal:${s.id}`}
        style={styles.row}
        onPress={() => setSelectedSignal(s.id)}
        onLongPress={
          s.mine
            ? undefined
            : () =>
                moderate({
                  name: s.name,
                  reportKey: 'mod.reportSignal',
                  kind: 'signal',
                  refId: s.id,
                  userId: s.userId,
                })
        }
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName}>
            {lead} {s.mine ? t('feed.you') : s.name} · <Text style={styles.when}>{when}</Text>
          </Text>
          <Text style={styles.note}>
            {t('feed.countIn', { n: s.count })}
            {s.note ? ` · ${s.note}` : ''}
            {s.plannedAt ? '' : t('feed.tapToPlan')}
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

  const renderRun = (run) => {
    const dist = distanceTo(run.courtId);
    return (
    <View key={`run:${run.id}`} style={styles.row}>
      <Pressable
        style={{ flex: 1 }}
        onPress={onPickCourt ? () => onPickCourt(run.courtId, run.sport) : undefined}
        onLongPress={
          run.mine
            ? undefined
            : () =>
                moderate({
                  name: run.hostName,
                  reportKey: 'mod.reportRun',
                  kind: 'run',
                  refId: run.id,
                  userId: run.hostId,
                })
        }
      >
        <Text style={styles.rowName}>
          📅 {sportMeta(run.sport).emoji} {courtsById[run.courtId] || t('feed.aCourtCap')}
        </Text>
        <Text style={styles.note}>
          {/* Public runs are visible beyond the host's friends — mark them as
              open pickup anyone can join, with how far away the court is. */}
          {run.visibility === 'public' && !run.mine ? `🌐 ${t('feed.openRun')} · ` : ''}
          {formatRunTime(run.startsAt)}
          {dist ? ` · ${dist}` : ''} · {run.mine ? t('feed.you') : run.hostName} ·{' '}
          {t('feed.going', { n: run.count })}
          {run.note ? ` · ${run.note}` : ''}
        </Text>
      </Pressable>
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
          {runBusy === run.id
            ? '…'
            : run.mine
            ? t('cancel')
            : run.joined
            ? t('session.leave')
            : t('session.imIn')}
        </Text>
      </Pressable>
    </View>
    );
  };

  // Tapping a check-in opens that court on the map, on the check-in's sport.
  const renderCheckin = (c) => (
    <Pressable
      key={`checkin:${c.id}`}
      style={styles.row}
      onPress={onPickCourt ? () => onPickCourt(c.courtId, c.sport) : undefined}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.rowName}>
          {sportMeta(c.sport).emoji}{' '}
          {t('feed.checkedInto', {
            who: c.mine ? t('feed.you') : c.name,
            court: courtsById[c.courtId] || t('feed.aCourt'),
          })}
        </Text>
        <Text style={styles.note}>{timeAgo(c.createdAt)}</Text>
      </View>
      {!!onPickCourt && <Text style={styles.chevron}>›</Text>}
    </Pressable>
  );

  const content = (
    <>
      {!embedded && (
        <View style={styles.header}>
          <Text style={styles.title}>{t('social.activity')}</Text>
          {!asPage && (
            <Pressable hitSlop={10} onPress={onClose}>
              <Ionicons name="close" size={20} color="#90a0b0" />
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.composeRow}>
        <Pressable style={styles.composeBtn} onPress={() => setSignalOpen(true)}>
          <Text style={styles.composeText}>{t('feed.imDown')}</Text>
        </Pressable>
        <Pressable style={[styles.composeBtn, styles.composeAlt]} onPress={() => setRunOpen(true)}>
          <Text style={styles.composeText}>{t('feed.plan')}</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2f74d6" />
        </View>
      ) : items.length === 0 ? (
        <ScrollView
          style={asPage && styles.pageList}
          contentContainerStyle={styles.emptyWrap}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2f74d6" />
          }
        >
          <Text style={styles.muted}>{t('feed.empty')}</Text>
          {/* Cold-start nudges: an empty feed usually means no friends yet, so
              point at the two actions that fix it. Signed-out users get the
              account CTA from SocialScreen instead. */}
          {!!user && (
            <View style={styles.emptyCards}>
              {!!onOpenFriends && (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyCardTitle}>{t('feed.emptyFriendsTitle')}</Text>
                  <Text style={styles.emptyCardBody}>{t('feed.emptyFriendsBody')}</Text>
                  <Pressable style={styles.emptyCardBtn} onPress={onOpenFriends}>
                    <Text style={styles.emptyCardBtnText}>{t('feed.emptyFriendsBtn')}</Text>
                  </Pressable>
                </View>
              )}
              <View style={styles.emptyCard}>
                <Text style={styles.emptyCardTitle}>{t('feed.emptySignalTitle')}</Text>
                <Text style={styles.emptyCardBody}>{t('feed.emptySignalBody')}</Text>
                <Pressable
                  style={[styles.emptyCardBtn, styles.emptyCardBtnGreen]}
                  onPress={() => setSignalOpen(true)}
                >
                  <Text style={styles.emptyCardBtnText}>{t('feed.imDown')}</Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
      ) : (
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={16}
          style={asPage && styles.pageList}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2f74d6" />
          }
        >
          {items.map((it) =>
            it.kind === 'signal'
              ? renderSignal(it.signal)
              : it.kind === 'run'
              ? renderRun(it.run)
              : renderCheckin(it.checkin)
          )}
        </ScrollView>
      )}

      <SignalModal
        visible={signalOpen}
        courts={courts}
        userLocation={userLocation}
        onClose={() => setSignalOpen(false)}
        onPosted={refresh}
      />
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
        onJoinedChat={onJoinedChat}
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
        <ScrollTopFab show={showTop} onPress={scrollToTop} bottom={insets.bottom + 92} />
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
  emptyWrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  emptyCards: { alignSelf: 'stretch', gap: 10, marginTop: 4 },
  emptyCard: { backgroundColor: '#f4f6f8', borderRadius: 12, padding: 14 },
  emptyCardTitle: { fontSize: 14, fontWeight: '800', color: '#0d1b2a' },
  emptyCardBody: { fontSize: 12.5, color: '#46586a', marginTop: 2, marginBottom: 10 },
  emptyCardBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#2f74d6',
    borderRadius: 9,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  emptyCardBtnGreen: { backgroundColor: '#1f9d55' },
  emptyCardBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
