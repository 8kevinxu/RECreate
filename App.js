import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import CourtMap from './components/CourtMap';
import { useCourts } from './lib/useCourts';
import {
  getOpenStatus,
  getBasketballStatus,
  getBasketballWeek,
} from './lib/hours';
import {
  loadCrowd,
  checkIn as recordCheckIn,
  removeCheckIn,
  subscribe as subscribeCrowd,
  mergeCheckIn,
  loadMyVotes,
  saveMyVotes,
  currentLevel,
  countWithin,
  latest,
  timeAgo,
  FRESH_WINDOW_MS,
  LEVELS,
  LEVEL_META,
} from './lib/crowd';
import { loadReviews, addReview, MAX_BODY, MAX_NAME } from './lib/reviews';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ISO timestamp → "today" / "yesterday" / "Jun 18, 2026".
function formatUpdated(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const today = new Date();
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export default function App() {
  const mapRef = useRef(null);
  const [openOnly, setOpenOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(true);
  const [now, setNow] = useState(new Date());
  const [crowd, setCrowd] = useState({}); // { courtId: [{ id, level, ts }] }
  const [myVotes, setMyVotes] = useState({}); // { courtId: { id, level, ts } }

  // Load check-ins + my votes on mount; (when shared) live-update by merging
  // new check-ins incrementally and refetching on deletes.
  useEffect(() => {
    loadCrowd().then(setCrowd);
    loadMyVotes().then(setMyVotes);
    const unsubscribe = subscribeCrowd(
      (rec) => setCrowd((prev) => mergeCheckIn(prev, rec)),
      () => loadCrowd().then(setCrowd)
    );
    return unsubscribe;
  }, []);

  const persistMyVote = (courtId, vote) => {
    setMyVotes((prev) => {
      const next = { ...prev };
      if (vote) next[courtId] = vote;
      else delete next[courtId];
      saveMyVotes(next);
      return next;
    });
  };

  // Tap a level: check in, switch your vote, or (tapping your current pick) undo.
  // Returns a result so the card can show feedback.
  const handleVote = async (courtId, level) => {
    const mine = myVotes[courtId];
    if (mine && mine.level === level) {
      await removeCheckIn(courtId, mine.id); // toggle off
      persistMyVote(courtId, null);
      setCrowd(await loadCrowd());
      return { removed: true };
    }
    const res = await recordCheckIn(courtId, level);
    if (res && res.id) {
      if (mine) await removeCheckIn(courtId, mine.id); // replace previous vote
      persistMyVote(courtId, { id: res.id, level, ts: Date.now() });
      setCrowd(await loadCrowd());
      return res;
    }
    return res;
  };

  // Refresh "open now" status every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Ask for location once on mount; fall back silently to the SF-wide view.
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          setUserLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
          });
        }
      } catch (e) {
        // Ignore — map still works centered on San Francisco.
      } finally {
        setLocating(false);
      }
    })();
  }, []);

  // Court data: bundled → cached → freshly fetched (see useCourts).
  const { courts: courtData, generatedAt } = useCourts();

  // Annotated with facility status + basketball open-gym status.
  const courts = useMemo(() => {
    return courtData.map((c) => ({
      ...c,
      status: getOpenStatus(c, now),
      bball: getBasketballStatus(c, now),
    }));
  }, [courtData, now]);

  // "Open now" = drop-in basketball is happening right now.
  const visibleCourts = useMemo(() => {
    return courts.filter((c) => !openOnly || c.bball.open);
  }, [courts, openOnly]);

  // Map markers fade when there's no open-gym basketball right now, and animate
  // by the latest *fresh* crowd check-in.
  const nowMs = now.getTime();
  const mapCourts = useMemo(
    () =>
      visibleCourts.map((c) => ({
        id: c.id,
        lat: c.lat,
        lng: c.lng,
        indoor: c.indoor,
        open: c.bball.open,
        crowd: currentLevel(crowd[c.id], nowMs),
      })),
    [visibleCourts, crowd, nowMs]
  );

  const selected = useMemo(
    () => courts.find((c) => c.id === selectedId) || null,
    [courts, selectedId]
  );

  const handleSelect = (id) => {
    setSelectedId(id);
    const court = courts.find((c) => c.id === id);
    if (court) mapRef.current?.focusCourt(court);
  };

  const recenter = () => {
    if (userLocation) mapRef.current?.recenter(userLocation);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <Text style={styles.title}>🏀 HoopMap SF</Text>
        <Text style={styles.subtitle}>
          {openOnly
            ? `${visibleCourts.length} with open gym right now`
            : `${visibleCourts.length} indoor courts · SF Rec & Parks`}
        </Text>
        {!!generatedAt && (
          <Text style={styles.updated}>Updated {formatUpdated(generatedAt)}</Text>
        )}
      </View>

      <View style={styles.filterBar}>
        <Pressable
          onPress={() => setOpenOnly((v) => !v)}
          style={[styles.openToggle, openOnly && styles.openToggleActive]}
        >
          <Text
            style={[
              styles.openToggleText,
              openOnly && styles.openToggleTextActive,
            ]}
          >
            {openOnly ? '✓ Open now' : 'Open now'}
          </Text>
        </Pressable>
      </View>

      <View style={styles.mapWrap}>
        <CourtMap
          ref={mapRef}
          courts={mapCourts}
          userLocation={userLocation}
          onSelectCourt={handleSelect}
        />

        {locating && (
          <View style={styles.locating}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.locatingText}>Finding you…</Text>
          </View>
        )}

        {userLocation && (
          <Pressable style={styles.recenterBtn} onPress={recenter}>
            <Text style={styles.recenterIcon}>◎</Text>
          </Pressable>
        )}
      </View>

      {selected && (
        <CourtDetail
          court={selected}
          history={crowd[selected.id] || []}
          myVote={myVotes[selected.id]}
          now={nowMs}
          onVote={handleVote}
          onClose={() => setSelectedId(null)}
        />
      )}
    </SafeAreaView>
  );
}

function CourtDetail({ court, history, myVote, now, onVote, onClose }) {
  const { status, bball } = court;
  const week = getBasketballWeek(court);
  const level = currentLevel(history, now); // community's latest
  const last = latest(history);
  const lastHour = countWithin(history, 60 * 60 * 1000, now);
  const recent = history.slice(0, 4);

  // Your own (still-fresh) vote drives which button is highlighted/toggleable.
  const myLevel = myVote && now - myVote.ts <= FRESH_WINDOW_MS ? myVote.level : null;

  const [note, setNote] = useState(null);
  const [expanded, setExpanded] = useState(false); // peek by default
  useEffect(() => {
    setNote(null);
    setExpanded(false); // each court opens compact
  }, [court.id]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);

  const doVote = async (lv) => {
    const res = await onVote(court.id, lv);
    if (res && res.removed) {
      setNote('Check-in removed.');
    } else if (res && res.id) {
      setNote('✓ Thanks — check-in recorded!');
    } else {
      setNote('Couldn’t update check-in. Try again.');
    }
  };

  // Reviews (loaded lazily for the open court).
  const [reviews, setReviews] = useState(null); // null = loading
  const [reviewName, setReviewName] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [posting, setPosting] = useState(false);
  useEffect(() => {
    let alive = true;
    setReviews(null);
    setReviewBody('');
    loadReviews(court.id).then((r) => {
      if (alive) setReviews(r);
    });
    return () => {
      alive = false;
    };
  }, [court.id]);

  const submitReview = async () => {
    const body = reviewBody.trim();
    if (!body || posting) return;
    setPosting(true);
    const rec = await addReview(court.id, { author: reviewName, body });
    setPosting(false);
    if (rec) {
      setReviews((prev) => [rec, ...(prev || [])]);
      setReviewBody('');
    } else {
      setNote('Couldn’t post review. Try again.');
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{court.name}</Text>
          {!!(court.neighborhood || court.address) && (
            <Text style={styles.cardSub}>
              {[court.neighborhood, court.address].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
        <Pressable hitSlop={10} onPress={onClose}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.badgeRow}>
        <View
          style={[styles.badge, bball.open ? styles.badgeOpen : styles.badgeClosed]}
        >
          <Text style={styles.badgeText}>🏀 {bball.label}</Text>
        </View>
        <View
          style={[styles.badge, status.open ? styles.badgeFacOpen : styles.badgeFacClosed]}
        >
          <Text style={styles.badgeText}>Facility {status.open ? 'open' : 'closed'}</Text>
        </View>
      </View>

      <View style={styles.crowdBox}>
        <View style={styles.crowdStatusRow}>
          <Text style={styles.sectionLabel}>How crowded right now?</Text>
          {level ? (
            <Text style={[styles.crowdStatus, { color: LEVEL_META[level].color }]}>
              {LEVEL_META[level].dot} {LEVEL_META[level].label} · {timeAgo(last.ts, now)}
            </Text>
          ) : (
            <Text style={styles.crowdStatusMuted}>
              {last ? `last report ${timeAgo(last.ts, now)}` : 'No recent check-ins'}
            </Text>
          )}
        </View>
        <View style={styles.crowdButtons}>
          {LEVELS.map((lv) => {
            const meta = LEVEL_META[lv];
            const active = myLevel === lv;
            return (
              <Pressable
                key={lv}
                onPress={() => doVote(lv)}
                style={[
                  styles.crowdBtn,
                  active && { backgroundColor: meta.color, borderColor: meta.color },
                ]}
              >
                <Text style={[styles.crowdBtnText, active && styles.crowdBtnTextActive]}>
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {note ? (
          <Text style={styles.checkinNote}>{note}</Text>
        ) : myLevel ? (
          <Text style={styles.checkinHint}>Tap your choice again to remove it.</Text>
        ) : null}

        {expanded && recent.length > 0 && (
          <View style={styles.history}>
            <Text style={styles.historyHead}>
              👥 {lastHour} check-in{lastHour === 1 ? '' : 's'} in the last hour
            </Text>
            {recent.map((e, i) => (
              <View key={e.ts + '-' + i} style={styles.historyRow}>
                <Text style={[styles.historyLevel, { color: LEVEL_META[e.level].color }]}>
                  {LEVEL_META[e.level].dot} {LEVEL_META[e.level].label}
                </Text>
                <Text style={styles.historyAgo}>{timeAgo(e.ts, now)}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <Pressable style={styles.expandToggle} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.expandToggleText}>
          {expanded ? '⌃  Hide details' : '⌄  Schedule & reviews'}
        </Text>
      </Pressable>

      {expanded && (
      <ScrollView style={styles.cardScroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>Open-gym basketball</Text>
        {week.map((d) => (
          <View
            key={d.day}
            style={[styles.weekRow, d.isToday && styles.weekRowToday]}
          >
            <Text style={[styles.weekDay, d.isToday && styles.weekTodayText]}>
              {d.day}
              {d.isToday ? ' •' : ''}
            </Text>
            <Text
              style={[
                styles.weekTimes,
                !d.hasBball && styles.weekClosed,
                d.isToday && styles.weekTodayText,
              ]}
            >
              {d.label}
            </Text>
          </View>
        ))}
        {week.some((d) => d.hasWheelchair) && (
          <Text style={styles.wheelchairNote}>* wheelchair basketball</Text>
        )}

        {!!court.notes && <Text style={styles.notes}>{court.notes}</Text>}
        <Text style={styles.disclaimer}>
          Open-gym times (summer) vary seasonally — verify on sfrecpark.org.
        </Text>

        <Text style={[styles.sectionLabel, styles.reviewsLabel]}>Reviews</Text>
        {reviews === null ? (
          <Text style={styles.reviewsMuted}>Loading…</Text>
        ) : reviews.length === 0 ? (
          <Text style={styles.reviewsMuted}>No reviews yet — be the first.</Text>
        ) : (
          reviews.map((r) => (
            <View key={r.id} style={styles.review}>
              <View style={styles.reviewHead}>
                <Text style={styles.reviewAuthor}>{r.author || 'Anonymous'}</Text>
                <Text style={styles.reviewAgo}>{timeAgo(r.ts, now)}</Text>
              </View>
              <Text style={styles.reviewBody}>{r.body}</Text>
            </View>
          ))
        )}
      </ScrollView>
      )}

      {expanded && (
      <View style={styles.reviewForm}>
        <TextInput
          style={styles.reviewNameInput}
          placeholder="Name (optional)"
          placeholderTextColor="#9aa7b4"
          value={reviewName}
          onChangeText={setReviewName}
          maxLength={MAX_NAME}
        />
        <View style={styles.reviewInputRow}>
          <TextInput
            style={styles.reviewBodyInput}
            placeholder="Add a review…"
            placeholderTextColor="#9aa7b4"
            value={reviewBody}
            onChangeText={setReviewBody}
            maxLength={MAX_BODY}
            multiline
          />
          <Pressable
            onPress={submitReview}
            disabled={!reviewBody.trim() || posting}
            style={[
              styles.reviewPost,
              (!reviewBody.trim() || posting) && styles.reviewPostDisabled,
            ]}
          >
            <Text style={styles.reviewPostText}>{posting ? '…' : 'Post'}</Text>
          </Pressable>
        </View>
      </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0d1b2a' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  title: { color: '#fff', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#9db4cc', fontSize: 13, marginTop: 2 },
  updated: { color: '#6f8298', fontSize: 11, marginTop: 2 },

  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: '#1b2b3d',
    borderRadius: 10,
    padding: 3,
    flex: 1,
  },
  segmentItem: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
  },
  segmentItemActive: { backgroundColor: '#2f74d6' },
  segmentText: { color: '#9db4cc', fontWeight: '600', fontSize: 13 },
  segmentTextActive: { color: '#fff' },

  openToggle: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#1b2b3d',
  },
  openToggleActive: { backgroundColor: '#1f9d55' },
  openToggleText: { color: '#9db4cc', fontWeight: '700', fontSize: 13 },
  openToggleTextActive: { color: '#fff' },

  mapWrap: { flex: 1, margin: 12, borderRadius: 16, overflow: 'hidden' },

  locating: {
    position: 'absolute',
    top: 12,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(13,27,42,0.85)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  locatingText: { color: '#fff', fontSize: 13 },

  recenterBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  recenterIcon: { fontSize: 22, color: '#2f74d6' },

  card: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 16,
    maxHeight: Dimensions.get('window').height * 0.82,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  cardScroll: { flexShrink: 1 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start' },
  cardTitle: { fontSize: 18, fontWeight: '800', color: '#0d1b2a' },
  cardSub: { fontSize: 13, color: '#5b6b7b', marginTop: 2 },
  close: { fontSize: 18, color: '#90a0b0', paddingLeft: 8 },

  badgeRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 10 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  badgeOpen: { backgroundColor: '#d4f3df' },
  badgeClosed: { backgroundColor: '#f3d9d9' },
  badgeFacOpen: { backgroundColor: '#e3eefb' },
  badgeFacClosed: { backgroundColor: '#eceff2' },
  badgeText: { fontSize: 12, fontWeight: '700', color: '#2a3a4a' },

  crowdBox: {
    backgroundColor: '#f4f6f8',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  crowdStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  crowdStatus: { fontSize: 12, fontWeight: '700' },
  crowdStatusMuted: { fontSize: 12, color: '#9aa7b4', fontStyle: 'italic' },
  crowdButtons: { flexDirection: 'row', gap: 8 },
  crowdBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#d4dbe2',
    alignItems: 'center',
  },
  crowdBtnText: { fontSize: 13, fontWeight: '700', color: '#5b6b7b' },
  crowdBtnTextActive: { color: '#ffffff' },
  checkinNote: { fontSize: 12, color: '#46586a', marginTop: 8, fontWeight: '600' },
  checkinHint: { fontSize: 11, color: '#9aa7b4', marginTop: 8, fontStyle: 'italic' },

  expandToggle: { paddingVertical: 10, alignItems: 'center' },
  expandToggleText: { fontSize: 13, fontWeight: '700', color: '#2f74d6' },

  history: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#e3e8ec', paddingTop: 8 },
  historyHead: { fontSize: 12, fontWeight: '700', color: '#46586a', marginBottom: 5 },
  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  historyLevel: { fontSize: 12, fontWeight: '600' },
  historyAgo: { fontSize: 12, color: '#9aa7b4' },

  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0d1b2a',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  weekRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  weekRowToday: { backgroundColor: '#fff3e6' },
  weekDay: { fontSize: 13, color: '#2a3a4a', fontWeight: '600', width: 44 },
  weekTimes: { fontSize: 13, color: '#2a3a4a', flex: 1, textAlign: 'right' },
  weekClosed: { color: '#aab4bd' },
  weekTodayText: { color: '#e8730c', fontWeight: '700' },
  wheelchairNote: { fontSize: 11, color: '#6f8298', marginTop: 6, fontStyle: 'italic' },

  notes: { fontSize: 13, color: '#5b6b7b', marginTop: 8, lineHeight: 18 },
  disclaimer: {
    fontSize: 11,
    color: '#9aa7b4',
    marginTop: 10,
    fontStyle: 'italic',
  },

  reviewsLabel: { marginTop: 14 },
  reviewsMuted: { fontSize: 13, color: '#9aa7b4', marginTop: 4, fontStyle: 'italic' },
  review: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#eef1f4',
  },
  reviewHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  reviewAuthor: { fontSize: 13, fontWeight: '700', color: '#2a3a4a' },
  reviewAgo: { fontSize: 11, color: '#9aa7b4' },
  reviewBody: { fontSize: 13, color: '#46586a', lineHeight: 18 },

  reviewForm: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#e3e8ec', paddingTop: 10 },
  reviewNameInput: {
    fontSize: 13,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 6,
  },
  reviewInputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  reviewBodyInput: {
    flex: 1,
    fontSize: 13,
    color: '#0d1b2a',
    backgroundColor: '#f4f6f8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxHeight: 80,
  },
  reviewPost: {
    backgroundColor: '#2f74d6',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  reviewPostDisabled: { backgroundColor: '#bcc8d4' },
  reviewPostText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
