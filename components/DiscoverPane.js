// Discover: public "down to play" signals from people outside your circle — the
// one surface with something on it before you have friends (every other social
// feature needs a friend code handed over in person first). Tap a signal to open
// the same SessionModal the Activity feed uses; joining drops you into its group
// chat. Strangers' posts, so long-press moderation (report / block) is here too,
// exactly as in FeedModal.
import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { loadPublicSignals, subscribeSignals } from '../lib/signals';
import { sendMessage } from '../lib/chat';
import { reportContent } from '../lib/reports';
import { blockUser } from '../lib/blocks';
import { viewLabel } from '../lib/datetime';
import { useAuth } from '../lib/auth';
import { sportLabel, useI18n } from '../lib/i18n';
import { confirm, notify } from '../lib/dialog';
import SportGlyph from './SportGlyph';
import SignalModal from './SignalModal';
import SessionModal from './SessionModal';
import ChatThread from './ChatThread';
import ActionSheet from './ActionSheet';
import ScrollTopFab, { useScrollTop } from './ScrollTopFab';

export default function DiscoverPane({
  courtsById = {}, // every city's court names
  courts = [], // the active city's courts
  sport = 'basketball',
  userLocation = null,
}) {
  const { t } = useI18n();
  const { enabled: authEnabled, user } = useAuth();
  const insets = useSafeAreaInsets();
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { scrollRef, onScroll, showTop, scrollToTop } = useScrollTop(40);
  const [signalOpen, setSignalOpen] = useState(false);
  const [selectedSignal, setSelectedSignal] = useState(null); // signal id for the session sheet
  const [chatThread, setChatThread] = useState(null);
  const [modTarget, setModTarget] = useState(null);
  const [modBusy, setModBusy] = useState(false);

  // Signals carry no city, but one naming a court does say where it is: drop
  // those pointing at another metro's court, so an SF feed doesn't fill with
  // Brooklyn pickup. A signal with no court could be anywhere and stays.
  const cityIds = useMemo(() => new Set(courts.map((c) => c.id)), [courts]);
  const inCity = (s) =>
    [s.plannedCourtId, s.prefCourtId]
      .filter(Boolean)
      .every((id) => cityIds.has(id) || !courtsById[id]);
  const visible = signals.filter(inCity);

  const refresh = () => loadPublicSignals().then(setSignals);
  const onRefresh = () => {
    setRefreshing(true);
    refresh().finally(() => setRefreshing(false));
  };

  useEffect(() => {
    if (!user) {
      setSignals([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh().finally(() => setLoading(false));
    return subscribeSignals(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const selectedSignalObj = visible.find((s) => s.id === selectedSignal) || null;
  useEffect(() => {
    if (selectedSignal && !selectedSignalObj) setSelectedSignal(null);
  }, [selectedSignal, selectedSignalObj]);

  const openSignalChat = (s) =>
    setChatThread({
      key: `signal:${s.id}`,
      kind: 'signal',
      signalId: s.id,
      title: t('feed.theirSignal', { name: s.name }),
      subtitle: s.plannedAt
        ? t('feed.subSession')
        : s.isNow
        ? t('feed.subDownNow')
        : t('feed.subScheduled'),
    });

  // Same hand-off as the Activity feed: announce the join in the group chat, then
  // open that chat.
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

  // Report / block — the FeedModal flow. Cancelling the block confirmation
  // returns to the menu: backing out of blocking isn't backing out of reporting.
  const onModerate = async (choice) => {
    const target = modTarget;
    if (!target) return;
    setModBusy(true);
    if (choice === 'report') {
      const { error } = await reportContent({
        kind: 'signal',
        refId: target.id,
        reportedUser: target.userId,
      });
      notify(error ? t('mod.fail') : t('mod.reported'));
      setModTarget(null);
    } else if (choice === 'block') {
      const ok = await confirm({
        title: t('mod.blockTitle', { name: target.name }),
        message: t('mod.blockBody'),
        confirmText: t('mod.block'),
        cancelText: t('cancel'),
        destructive: true,
      });
      if (ok) {
        const { error } = await blockUser(target.userId);
        if (error) notify(t('mod.fail'));
        else {
          setModTarget(null);
          refresh(); // the loader filters blocked users at source
        }
      }
    }
    setModBusy(false);
  };

  const renderSignal = (s) => {
    const when = s.plannedAt
      ? `${viewLabel(s.plannedAt)}${
          s.plannedCourtId ? ` @ ${courtsById[s.plannedCourtId] || t('feed.aCourt')}` : ''
        }`
      : s.isNow
      ? t('feed.nowWhen')
      : viewLabel(s.startsAt);
    const where = !s.plannedCourtId && s.prefCourtId ? courtsById[s.prefCourtId] : null;
    return (
      <Pressable
        key={s.id}
        style={styles.row}
        onPress={() => setSelectedSignal(s.id)}
        onLongPress={() => setModTarget(s)}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.nameRow}>
            {s.plannedAt ? <Text style={styles.leadEmoji}>✅</Text> : <SportGlyph id={s.sport} size={15} />}
            <Text style={styles.rowName}>
              {s.name} · <Text style={styles.when}>{when}</Text>
            </Text>
          </View>
          <Text style={styles.note}>
            {sportLabel(t, s.sport)}
            {where ? ` · ${where}` : ''} · {t('feed.countIn', { n: s.count })}
            {s.note ? ` · ${s.note}` : ''}
          </Text>
          {s.joined && <Text style={styles.joined}>✓ {t('discover.youreIn')}</Text>}
        </View>
        {s.joined && (
          <Pressable style={styles.chatBtn} hitSlop={6} onPress={() => openSignalChat(s)}>
            <Text style={styles.chatBtnText}>💬</Text>
          </Pressable>
        )}
        <Text style={styles.chevron}>›</Text>
      </Pressable>
    );
  };

  // Signed out, RLS returns no public signals (the anon key ships in the bundle),
  // and SocialScreen already shows the account CTA above — just say why it's empty.
  if (authEnabled && !user)
    return (
      <View style={styles.page}>
        <Text style={styles.muted}>{t('discover.signedOut')}</Text>
      </View>
    );

  return (
    <View style={[styles.page, { paddingBottom: insets.bottom + 84 }]}>
      <Pressable style={styles.composeBtn} onPress={() => setSignalOpen(true)}>
        <Text style={styles.composeText}>{t('discover.post')}</Text>
      </Pressable>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color="#2f74d6" />
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={16}
          style={styles.list}
          contentContainerStyle={visible.length === 0 && styles.emptyWrap}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#2f74d6" />
          }
        >
          {visible.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyCardTitle}>{t('discover.empty')}</Text>
              <Text style={styles.emptyCardBody}>{t('discover.emptyBody')}</Text>
            </View>
          ) : (
            <>
              <Text style={styles.intro}>{t('discover.intro')}</Text>
              {visible.map(renderSignal)}
            </>
          )}
        </ScrollView>
      )}

      {/* Posting from Discover opens on "Anyone": the button says where the post
          goes, so tapping it is the opt-in. The toggle can still switch back. */}
      <SignalModal
        visible={signalOpen}
        courts={courts}
        userLocation={userLocation}
        defaultVisibility="public"
        onClose={() => setSignalOpen(false)}
        onPosted={refresh}
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
      <ChatThread visible={!!chatThread} thread={chatThread} onClose={() => setChatThread(null)} />
      <ActionSheet
        visible={!!modTarget}
        title={modTarget?.name || t('mod.someone')}
        busy={modBusy}
        options={[
          {
            key: 'report',
            label: t('mod.reportSignal'),
            desc: t('mod.reportDesc'),
            icon: 'flag-outline',
            iconBg: '#fdf1d6',
          },
          {
            key: 'block',
            label: t('mod.blockUser', { name: modTarget?.name || t('mod.someone') }),
            desc: t('mod.blockDesc'),
            icon: 'ban-outline',
            iconBg: '#fbe6e6',
            destructive: true,
          },
        ]}
        onSelect={onModerate}
        onClose={() => setModTarget(null)}
      />
      <ScrollTopFab show={showTop} onPress={scrollToTop} bottom={insets.bottom + 92} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 18, paddingTop: 2 },
  list: { flex: 1 },
  loading: { paddingVertical: 30, alignItems: 'center' },
  composeBtn: {
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginBottom: 6,
  },
  composeText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  intro: { fontSize: 12.5, color: '#7c8a98', paddingVertical: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  leadEmoji: { fontSize: 15 },
  rowName: { fontSize: 15, color: '#1a2a3a', fontWeight: '600', flex: 1 },
  when: { color: '#1f9d55', fontWeight: '700' },
  note: { fontSize: 13, color: '#5b6b7b', marginTop: 1 },
  joined: { fontSize: 12, color: '#1f9d55', fontWeight: '700', marginTop: 2 },
  chevron: { fontSize: 22, color: '#c0ccd8', fontWeight: '700', paddingLeft: 8 },
  chatBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  chatBtnText: { fontSize: 18 },
  muted: { fontSize: 14, color: '#9aa7b4', fontStyle: 'italic', paddingVertical: 16, textAlign: 'center' },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingTop: 30 },
  emptyCard: { backgroundColor: '#f4f6f8', borderRadius: 12, padding: 14 },
  emptyCardTitle: { fontSize: 14, fontWeight: '800', color: '#0d1b2a' },
  emptyCardBody: { fontSize: 12.5, color: '#46586a', marginTop: 2 },
});
