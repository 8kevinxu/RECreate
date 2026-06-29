import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CourtMap from './components/CourtMap';
import AuthModal from './components/AuthModal';
import FriendsModal from './components/FriendsModal';
import FeedModal from './components/FeedModal';
import NearbyList from './components/NearbyList';
import TimeSlider from './components/TimeSlider';
import BottomNav from './components/BottomNav';
import ClassesScreen from './components/ClassesScreen';
import { useAuth } from './lib/auth';
import { useCourts } from './lib/useCourts';
import { fmtClock, startOfDay, viewLabel, dayChipLabel, fmtDuration } from './lib/datetime';
import { haversineMiles, formatDistance } from './lib/distance';
import { subscribeSignals } from './lib/signals';
import { subscribeRuns } from './lib/runs';
import { loadFeed, getFeedSeenAt, markFeedSeen, unreadCount } from './lib/feed';
import { listIncomingRequests } from './lib/friends';
import { registerForPush, onNotificationTap } from './lib/push';
import {
  getOpenStatus,
  getDropinStatus,
  getDropinWeek,
  getDropinRemaining,
} from './lib/hours';
import { SPORTS, DEFAULT_SPORT, sportMeta } from './lib/sports';
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
import { liveBooked, bookedAt } from './lib/reservations';
import { logVisit } from './lib/playerCheckins';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// SF Rec & Park reservation links, shown on reservable (tennis/pickleball) courts.
// Each court deep-links to its own rec.us reservation page (court.reserved[sport].url);
// this is the fallback (the org's full locations list) when that's missing. The PDF
// is SF Rec & Park's step-by-step how-to guide.
const BOOK_URL = 'https://www.rec.us/organizations/san-francisco-rec-park?tab=locations';
const BOOK_HOWTO_URL =
  'https://sfrecpark.org/DocumentCenter/View/23655/SF_Rec_How-To_4-11-24?bidId=';

// Directory facts → short card labels. courtCountLabel summarizes how many courts
// and their reservable/walk-up split; netsLabel shortens the free-text nets column.
function courtCountLabel(d) {
  const n = d.total || 0;
  const unit = `court${n === 1 ? '' : 's'}`;
  if (d.walkup === 0 && d.reservable > 0) return `${n} ${unit} · all reservable`;
  if (d.reservable === 0 && d.walkup > 0) return `${n} ${unit} · all walk-up`;
  const parts = [];
  if (d.reservable) parts.push(`${d.reservable} reservable`);
  if (d.walkup) parts.push(`${d.walkup} walk-up`);
  return parts.length ? `${n} ${unit} · ${parts.join(', ')}` : `${n} ${unit}`;
}
function netsLabel(nets) {
  if (!nets) return null;
  if (/bring your own/i.test(nets)) return 'Bring your own net';
  if (/borrow/i.test(nets)) return 'Nets to borrow';
  if (/provided/i.test(nets)) return 'Nets provided';
  return null;
}

// Minimal inline markdown → RN <Text> spans: **bold**, *emphasis*, and [text](url)
// links (recursive so a link nested inside bold still renders). Enough for the
// rec.us location guidelines; anything else passes through as plain text.
function renderInline(text, kp) {
  const nodes = [];
  const re = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${kp}-${k++}`;
    if (m[1] != null) nodes.push(<Text key={key} style={styles.guideBold}>{renderInline(m[1], key)}</Text>);
    else if (m[2] != null) nodes.push(<Text key={key} style={styles.guideBold}>{renderInline(m[2], key)}</Text>);
    else nodes.push(
      <Text key={key} style={styles.bookHelpLink} onPress={() => Linking.openURL(m[4])}>{m[3]}</Text>
    );
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Render a markdown guidelines blob line-by-line (paragraphs, "- " bullets).
function GuidelineMarkdown({ text }) {
  return String(text)
    .split('\n')
    .map((line, i) => {
      const t = line.trim();
      if (!t) return <View key={i} style={{ height: 5 }} />;
      const bullet = /^[-*]\s+/.test(t);
      const body = bullet ? t.replace(/^[-*]\s+/, '') : t;
      return (
        <Text key={i} style={[styles.guideText, bullet && styles.guideBulletText]}>
          {bullet ? '•  ' : ''}
          {renderInline(body, `l${i}`)}
        </Text>
      );
    });
}


// Secondary indoor/outdoor filter, shown only for sports that have both (e.g.
// pickleball). Matched against a court's `indoor` flag in visibleCourts.
const PLACE_OPTS = [
  { id: 'all', label: 'All' },
  { id: 'indoor', label: '🏠 Indoor' },
  { id: 'outdoor', label: '🌳 Outdoor' },
];

// Amenity filters from the tennis/pickleball directory + reservation data
// (multi-select). Each chip only appears for a sport when at least one of its
// courts qualifies, so e.g. "Nets provided" shows for pickleball but not tennis.
const AMENITIES = [
  {
    id: 'bookable',
    label: '📅 Bookable',
    test: (c, s) => !!c.reserved?.[s] || (c.directory?.[s]?.reservable || 0) > 0,
  },
  { id: 'lights', label: '🌙 Lights', test: (c, s) => c.directory?.[s]?.lights === true },
  { id: 'restrooms', label: '🚻 Restrooms', test: (c, s) => c.directory?.[s]?.restrooms === true },
  {
    id: 'nets',
    label: '🥅 Nets provided',
    test: (c, s) => /provided/i.test(c.directory?.[s]?.nets || ''),
  },
];

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
  const didCenterRef = useRef(false); // auto-center on the user only once
  const [openOnly, setOpenOnly] = useState(false);
  const [sport, setSport] = useState(DEFAULT_SPORT); // which drop-in sport to show
  const [placeFilter, setPlaceFilter] = useState('all'); // indoor/outdoor sub-filter
  const [amenities, setAmenities] = useState([]); // active amenity filter ids (multi-select)
  const [menuOpen, setMenuOpen] = useState(false); // sport + filters dropdown menu
  const [controlsVisible, setControlsVisible] = useState(false); // filter bar shown via the FAB
  const [selectedId, setSelectedId] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(true);
  const [now, setNow] = useState(new Date());
  const [crowd, setCrowd] = useState({}); // { courtId: [{ id, level, ts }] }
  const [myVotes, setMyVotes] = useState({}); // { courtId: { id, level, ts } }
  const [pickedTime, setPickedTime] = useState(null); // null = live "now"
  const [pickerOpen, setPickerOpen] = useState(false);
  const { enabled: authEnabled, user, displayName } = useAuth();
  const insets = useSafeAreaInsets(); // device notch / home-indicator insets (edge-to-edge)
  // The map fills the whole screen with the nav floating over it; this is how far up
  // map overlays (zoom, recenter, Nearby, court card) must sit to clear the nav pill.
  const navClearance = insets.bottom + 86;
  const [tab, setTab] = useState('home'); // home | social | profile (bottom nav)
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  const [unread, setUnread] = useState(0); // unread activity-feed items (badge)
  const [requestCount, setRequestCount] = useState(0); // incoming friend requests (badge)

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
      // A signed-in crowd report also logs a personal visit for the selected
      // sport (deduped server-side window) — feeds the account check-in stats.
      if (user) logVisit(user.id, courtId, sport);
      return res;
    }
    return res;
  };

  // Dedicated "I played here" check-in for the selected sport (court detail).
  const handleLogVisit = async (courtId) => logVisit(user?.id, courtId, sport);

  // Refresh "open now" status every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Activity badge: count of feed items (friends' signals + runs) newer than the
  // last time the user opened the Activity sheet. Live-updates on signal changes.
  const refreshUnread = useCallback(async () => {
    if (!authEnabled || !user) {
      setUnread(0);
      return;
    }
    const [items, seenAt] = await Promise.all([loadFeed(), getFeedSeenAt()]);
    setUnread(unreadCount(items, seenAt));
  }, [authEnabled, user?.id]);

  useEffect(() => {
    if (!authEnabled || !user) {
      setUnread(0);
      return;
    }
    refreshUnread();
    const unsubS = subscribeSignals(refreshUnread);
    const unsubR = subscribeRuns(refreshUnread);
    return () => {
      unsubS();
      unsubR();
    };
  }, [authEnabled, user?.id, refreshUnread]);

  // Friends badge: number of pending incoming requests. Re-checked whenever the
  // Friends sheet opens or closes (where accepts/declines happen).
  useEffect(() => {
    if (!authEnabled || !user) {
      setRequestCount(0);
      return;
    }
    let alive = true;
    listIncomingRequests().then((r) => {
      if (alive) setRequestCount(r.length);
    });
    return () => {
      alive = false;
    };
  }, [authEnabled, user?.id, friendsOpen]);

  // Switching tabs; entering Social marks the feed as seen and clears the badge.
  const goTab = useCallback((t) => {
    setTab(t);
    if (t === 'social') markFeedSeen().then(() => setUnread(0));
  }, []);

  // Register this device for push when signed in (no-ops on web/simulator/Expo
  // Go or without an EAS projectId). Sign-out unregisters via lib/auth.
  useEffect(() => {
    if (!authEnabled || !user) return;
    registerForPush(user.id);
  }, [authEnabled, user?.id]);

  // Tapping a push deep-links: run/run-join → open that court; friend-accept →
  // the Friends sheet; signals/sessions → the Activity feed.
  useEffect(() => {
    return onNotificationTap((data) => {
      if (data.courtId) {
        setTab('home');
        setSelectedId(data.courtId);
      } else if (data.type === 'friend') setFriendsOpen(true);
      else if (data.type) goTab('social');
    });
  }, [goTab]);

  // Ask for location (on mount, and again if the user taps "enable location").
  const requestLocation = useCallback(async () => {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      }
    } catch (e) {
      // Ignore — map still works centered on San Francisco.
    } finally {
      setLocating(false);
    }
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  // Center the map on the user the first time we get a fix.
  useEffect(() => {
    if (userLocation && !didCenterRef.current && mapRef.current) {
      mapRef.current.recenter(userLocation);
      didCenterRef.current = true;
    }
  }, [userLocation]);

  // Court data: bundled → cached → freshly fetched (see useCourts).
  const { courts: courtData, generatedAt } = useCourts();

  // "View time": all schedule / open-gym logic runs against this. It tracks the
  // live clock by default; picking a future day+time freezes it so the map shows
  // what's open *then* instead of now.
  const viewTime = pickedTime || now;
  const isPicked = !!pickedTime;

  // Options for the time picker: the next 7 days, and 30-min slots 9 AM–10 PM.
  // No SF Rec & Parks indoor gym opens before 9 AM (earliest facility open and
  // earliest open-gym block in the data are both 9 AM), so slots start there.
  const days = useMemo(() => {
    const base = startOfDay(new Date());
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, []);
  const times = useMemo(() => {
    const out = [];
    for (let m = 9 * 60; m <= 22 * 60; m += 30) out.push(m);
    return out;
  }, []);
  // Weekdays (0=Sun..6=Sat) that have open-gym time for the selected sport at any
  // court. Days with none are greyed out in the picker. Derived from data so it
  // self-adjusts to the schedule (and to the chosen sport).
  const sportDays = useMemo(() => {
    const set = new Set();
    for (const c of courtData) {
      (c.dropins?.[sport] || []).forEach((blocks, d) => {
        if (blocks && blocks.length) set.add(d);
      });
    }
    return set;
  }, [courtData, sport]);
  const firstOpenDay = useMemo(
    () => days.find((d) => sportDays.has(d.getDay())) || days[0],
    [days, sportDays]
  );
  const selDayTs = pickedTime ? startOfDay(pickedTime).getTime() : null;
  const selMin = pickedTime ? pickedTime.getHours() * 60 + pickedTime.getMinutes() : null;
  const pickTime = (dayDate, min) => {
    const d = new Date(dayDate);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    setPickedTime(d);
  };

  // The current 30-min slot (3:51 → 3:30) and today's start, for the time picker.
  const nowSlot = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
  const todayTs = startOfDay(now).getTime();
  // Time options for a day: today hides slots already past; other days show the full range.
  const timesForDayTs = (ts) => (ts === todayTs ? times.filter((m) => m >= nowSlot) : times);
  // Opening the picker pre-selects today at the current slot (or the next open day at
  // the start of the range if today is closed / past the last slot).
  const toggleTimePicker = () => {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
    if (pickedTime) return;
    const todayTimes = timesForDayTs(todayTs);
    if (sportDays.has(now.getDay()) && todayTimes.length) {
      pickTime(startOfDay(now), todayTimes[0]);
    } else {
      const d = days.find((x) => x.getTime() !== todayTs && sportDays.has(x.getDay())) || firstOpenDay;
      pickTime(d, times[0]);
    }
  };

  // Court id → name, for labeling runs in the Friends feed.
  const courtsById = useMemo(
    () => Object.fromEntries(courtData.map((c) => [c.id, c.name])),
    [courtData]
  );

  // Annotated with facility status, the selected sport's open-gym status, minutes
  // of open-gym left, and distance from the user (when location is available).
  const courts = useMemo(() => {
    return courtData.map((c) => ({
      ...c,
      status: getOpenStatus(c, viewTime),
      dropin: getDropinStatus(c, sport, viewTime),
      remaining: getDropinRemaining(c, sport, viewTime),
      // Does this court ever run the selected sport? (any block any day.) Courts
      // that never do are hidden entirely in that sport — no marker, no listing.
      offersSport: (c.dropins?.[sport] || []).some((day) => day && day.length),
      distanceMi: userLocation
        ? haversineMiles(userLocation.lat, userLocation.lng, c.lat, c.lng)
        : null,
    }));
  }, [courtData, sport, viewTime, userLocation]);

  // Does the selected sport have both indoor and outdoor courts? If so, offer the
  // secondary Indoor/Outdoor toggle (today that's pickleball).
  const sportPlaces = useMemo(() => {
    const offered = courts.filter((c) => c.offersSport);
    return {
      indoor: offered.some((c) => c.indoor !== false),
      outdoor: offered.some((c) => c.indoor === false),
    };
  }, [courts]);
  const showPlaceToggle = sportPlaces.indoor && sportPlaces.outdoor;

  // Which amenity chips to offer for this sport: only those at least one of the
  // sport's courts satisfies (so irrelevant chips, like nets for tennis, hide).
  const amenityOpts = useMemo(() => {
    const offered = courts.filter((c) => c.offersSport);
    return AMENITIES.filter((a) => offered.some((c) => a.test(c, sport)));
  }, [courts, sport]);
  // Drop any active amenity that no longer applies (e.g. after switching sport).
  const activeAmenities = amenities.filter((id) => amenityOpts.some((a) => a.id === id));
  // Count of active filters, shown as a badge on the sport/menu button.
  const activeFilterCount =
    (showPlaceToggle && placeFilter !== 'all' ? 1 : 0) + activeAmenities.length;

  // Only courts that actually offer the sport; then the Indoor/Outdoor sub-filter
  // (when shown), the amenity filters, and "Open now" narrow further.
  const visibleCourts = useMemo(() => {
    const place = showPlaceToggle ? placeFilter : 'all';
    const active = AMENITIES.filter((a) => activeAmenities.includes(a.id));
    return courts.filter(
      (c) =>
        c.offersSport &&
        (!openOnly || c.dropin.open) &&
        (place === 'all' || (place === 'outdoor' ? c.indoor === false : c.indoor !== false)) &&
        active.every((a) => a.test(c, sport))
    );
  }, [courts, sport, openOnly, placeFilter, showPlaceToggle, activeAmenities.join(',')]);

  // "indoor"/"outdoor" qualifier for the header — only when the sport's courts are
  // uniformly one or the other (e.g. tennis = all outdoor); blank when mixed.
  const placeWord = useMemo(() => {
    if (!visibleCourts.length) return '';
    if (visibleCourts.every((c) => c.indoor === false)) return 'outdoor ';
    if (visibleCourts.every((c) => c.indoor !== false)) return 'indoor ';
    return '';
  }, [visibleCourts]);

  // Map markers fade when there's no open gym right now, and animate by the latest
  // *fresh* crowd check-in.
  const nowMs = now.getTime();
  const mapCourts = useMemo(
    () =>
      visibleCourts.map((c) => {
        // Booked% used to tint the marker: at the picked date+time when one is set,
        // otherwise "right now". Null when not reservable or no slot at that time.
        const res = c.reserved?.[sport];
        let booked;
        if (isPicked) {
          booked = bookedAt(res, viewTime)?.pct ?? null;
        } else {
          const lb = liveBooked(res);
          booked = lb && lb.now ? lb.pct : null;
        }
        return {
          id: c.id,
          lat: c.lat,
          lng: c.lng,
          indoor: c.indoor,
          open: c.dropin.open,
          booked,
          // Crowd is a live signal; hide it when viewing a future time.
          crowd: isPicked ? null : currentLevel(crowd[c.id], nowMs),
        };
      }),
    [visibleCourts, sport, crowd, nowMs, isPicked, viewTime]
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
    <View style={styles.safe}>
      <StatusBar style="dark" />

      <View style={styles.pageWrap}>
        {tab === 'home' && (
          <>
      <View style={styles.body}>
        {!!generatedAt && (
          <View style={[styles.updatedPill, { top: insets.top + 10 }]}>
            <View style={styles.updatedDot} />
            <Text style={styles.updatedPillText}>Updated {formatUpdated(generatedAt)}</Text>
          </View>
        )}
        <Pressable
          style={[
            styles.fab,
            styles.filterFab,
            { top: insets.top + 8 },
            controlsVisible && styles.filterFabActive,
          ]}
          onPress={() => setControlsVisible((v) => !v)}
        >
          <Ionicons
            name="options-outline"
            size={22}
            color={controlsVisible ? '#fff' : '#2f74d6'}
          />
        </Pressable>

        {controlsVisible && (
        <View style={[styles.controls, { top: insets.top + 56 }]}>
        <View style={styles.filterRow}>
          <Pressable
            onPress={() => setMenuOpen((v) => !v)}
            style={[styles.menuBtn, (menuOpen || activeFilterCount > 0) && styles.menuBtnActive]}
          >
            <Text
              style={[
                styles.menuBtnText,
                (menuOpen || activeFilterCount > 0) && styles.menuBtnTextActive,
              ]}
            >
              {sportMeta(sport).emoji} {sportMeta(sport).label}
              {activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''} {menuOpen ? '▴' : '▾'}
            </Text>
          </Pressable>

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
              {openOnly ? '✓ ' : ''}
              {isPicked ? 'Open then' : 'Open now'}
            </Text>
          </Pressable>

          <Pressable
            onPress={toggleTimePicker}
            style={[styles.timePill, (pickerOpen || isPicked) && styles.timePillActive]}
          >
            <Text
              style={[
                styles.timePillText,
                (pickerOpen || isPicked) && styles.timePillTextActive,
              ]}
            >
              🕒 {isPicked ? viewLabel(viewTime) : 'Pick a time'}
            </Text>
          </Pressable>

          {isPicked && (
            <Pressable
              hitSlop={8}
              onPress={() => {
                setPickedTime(null); // back to live "now"
                setPickerOpen(false); // collapse the day chips + time slider
              }}
              style={styles.timeReset}
            >
              <Text style={styles.timeResetText}>✕</Text>
            </Pressable>
          )}

        </View>

        {menuOpen && (
          <View style={styles.filtersPanel}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sportRow}
            >
              {SPORTS.map((s) => {
                const active = s.id === sport;
                return (
                  <Pressable
                    key={s.id}
                    onPress={() => {
                      setSport(s.id);
                      setPlaceFilter('all'); // reset the indoor/outdoor sub-filter
                      setAmenities([]); // reset amenity filters
                    }}
                    style={[styles.sportChip, active && styles.sportChipActive]}
                  >
                    <Text style={[styles.sportChipText, active && styles.sportChipTextActive]}>
                      {s.emoji} {s.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {showPlaceToggle && (
              <View style={styles.placeRow}>
                {PLACE_OPTS.map((o) => {
                  const active = placeFilter === o.id;
                  return (
                    <Pressable
                      key={o.id}
                      onPress={() => setPlaceFilter(o.id)}
                      style={[styles.placeChip, active && styles.placeChipActive]}
                    >
                      <Text style={[styles.placeChipText, active && styles.placeChipTextActive]}>
                        {o.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {amenityOpts.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.amenityRow}
              >
                {amenityOpts.map((a) => {
                  const active = activeAmenities.includes(a.id);
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() =>
                        setAmenities((prev) =>
                          prev.includes(a.id) ? prev.filter((x) => x !== a.id) : [...prev, a.id]
                        )
                      }
                      style={[styles.amenityChip, active && styles.amenityChipActive]}
                    >
                      <Text
                        style={[styles.amenityChipText, active && styles.amenityChipTextActive]}
                      >
                        {active ? '✓ ' : ''}
                        {a.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>
        )}

        {pickerOpen && (
          <View style={styles.pickerPanel}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRow}
            >
              {days.map((d) => {
                const open = sportDays.has(d.getDay());
                const active = d.getTime() === selDayTs;
                return (
                  <Pressable
                    key={d.getTime()}
                    disabled={!open}
                    onPress={() => {
                      const dayTimes = timesForDayTs(d.getTime());
                      const target =
                        selMin != null && dayTimes.includes(selMin) ? selMin : dayTimes[0] ?? times[0];
                      pickTime(d, target);
                    }}
                    style={[
                      styles.chip,
                      active && styles.chipActive,
                      !open && styles.chipDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                        !open && styles.chipTextDisabled,
                      ]}
                    >
                      {dayChipLabel(d)}
                      {open ? '' : ' · no hoops'}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <TimeSlider
              times={timesForDayTs(selDayTs ?? todayTs)}
              value={selMin}
              onChange={(m) =>
                pickTime(days.find((x) => x.getTime() === selDayTs) || firstOpenDay, m)
              }
            />
          </View>
        )}
      </View>
        )}

      <View style={styles.mapWrap}>
        <CourtMap
          ref={mapRef}
          courts={mapCourts}
          sport={sport}
          userLocation={userLocation}
          onSelectCourt={handleSelect}
        />

        {locating && (
          <View style={[styles.locating, { top: insets.top + 56 }]}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.locatingText}>Finding you…</Text>
          </View>
        )}

        {userLocation && (
          <Pressable style={[styles.recenterBtn, { bottom: navClearance }]} onPress={recenter}>
            <Text style={styles.recenterIcon}>◎</Text>
          </Pressable>
        )}

        <Pressable
          style={[styles.nearbyBtn, { bottom: navClearance }]}
          onPress={() => setNearbyOpen(true)}
        >
          <Text style={styles.nearbyBtnText}>📍 Nearby</Text>
        </Pressable>
      </View>
      </View>

      {selected && (
        <CourtDetail
          court={selected}
          sport={sport}
          history={crowd[selected.id] || []}
          myVote={myVotes[selected.id]}
          now={nowMs}
          viewTime={viewTime}
          isPicked={isPicked}
          bottomInset={navClearance}
          onVote={handleVote}
          onLogVisit={handleLogVisit}
          canLogVisit={!!user}
          onClose={() => setSelectedId(null)}
        />
      )}

      <NearbyList
        visible={nearbyOpen}
        courts={visibleCourts}
        sport={sport}
        viewTime={viewTime}
        isPicked={isPicked}
        hasLocation={!!userLocation}
        onSelect={(id) => {
          setNearbyOpen(false);
          handleSelect(id);
        }}
        onRequestLocation={requestLocation}
        onClose={() => setNearbyOpen(false)}
      />
          </>
        )}

        {tab === 'classes' && <ClassesScreen userLocation={userLocation} />}

        {tab === 'social' && (
          <FeedModal
            asPage
            visible
            onClose={() => {}}
            courtsById={courtsById}
            courts={courtData}
            sport={sport}
            userLocation={userLocation}
          />
        )}

        {tab === 'profile' && (
          <AuthModal
            asPage
            visible
            onClose={() => {}}
            courtsById={courtsById}
            onFriends={user ? () => setFriendsOpen(true) : undefined}
          />
        )}
      </View>

      {authEnabled && user && (
        <FriendsModal visible={friendsOpen} onClose={() => setFriendsOpen(false)} />
      )}

      <View style={styles.navWrap} pointerEvents="box-none">
        <BottomNav
          tab={tab}
          onChange={goTab}
          socialBadge={unread}
          profileBadge={requestCount}
          bottomInset={insets.bottom}
        />
      </View>
    </View>
  );
}

function CourtDetail({
  court,
  sport,
  history,
  myVote,
  now,
  viewTime,
  isPicked,
  bottomInset = 16,
  onVote,
  onLogVisit,
  canLogVisit,
  onClose,
}) {
  const { status, dropin } = court;
  const meta = sportMeta(sport);
  // rec.us reservations for this sport, if this court is reservable, plus the live
  // "% booked right now" reading derived from the point-in-time slot map.
  const booked = court.reserved?.[sport];
  // Booked reading shown on the card: at the picked date+time when one is set
  // (e.g. "0% booked at 6 PM"), otherwise the live "right now" reading.
  const atLabel = isPicked ? fmtClock(viewTime.getHours(), viewTime.getMinutes()) : null;
  const live = isPicked
    ? (() => {
        const b = bookedAt(booked, viewTime);
        return b ? { ...b, picked: true } : null;
      })()
    : liveBooked(booked);
  const fullyBooked = !!live && live.pct === 100 && (live.now || live.picked);
  // "X of Y courts open for booking" when fewer courts are released for this time,
  // plus when the rest open (e.g. "2 more open ~7/2") if we can date it.
  const partialOpen =
    live && live.open != null && live.total != null && live.open < live.total;
  const moreOpen = partialOpen ? live.total - live.open : 0;
  const releaseClause =
    partialOpen && live.releasesAt
      ? ` · ${moreOpen} more open ~${live.releasesAt.getMonth() + 1}/${live.releasesAt.getDate()}`
      : '';
  const courtsClause = !live || live.total == null
    ? null
    : partialOpen
    ? `${live.open} of ${live.total} courts open for booking${releaseClause}`
    : `${live.total} court${live.total === 1 ? '' : 's'}`;
  // SF Rec & Park directory facts (court count, lights, restrooms, nets) for this sport.
  const dir = court.directory?.[sport];
  // The location's rec.us booking guidelines (markdown), shared across its sports.
  const guidelines = court.reserved?.guidelines;
  const week = getDropinWeek(court, sport, viewTime);
  const level = currentLevel(history, now); // community's latest
  const last = latest(history);
  const lastHour = countWithin(history, 60 * 60 * 1000, now);
  const recent = history.slice(0, 4);

  // Your own (still-fresh) vote drives which button is highlighted/toggleable.
  const myLevel = myVote && now - myVote.ts <= FRESH_WINDOW_MS ? myVote.level : null;

  const [note, setNote] = useState(null);
  const [expanded, setExpanded] = useState(false); // peek by default
  const [bookingHelp, setBookingHelp] = useState(false); // "how booking works" explainer
  useEffect(() => {
    setNote(null);
    setExpanded(false); // each court opens compact
    setBookingHelp(false);
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

  const doLogVisit = async () => {
    const res = await onLogVisit(court.id);
    if (res && res.logged) {
      setNote(`✓ Checked in — ${meta.label.toLowerCase()} visit logged!`);
    } else if (res && res.skipped) {
      setNote('Already checked in here recently.');
    } else {
      setNote('Couldn’t check in. Try again.');
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
    <View style={[styles.card, { bottom: bottomInset }]}>
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
          style={[styles.badge, dropin.open ? styles.badgeOpen : styles.badgeClosed]}
        >
          <Text style={styles.badgeText}>{meta.emoji} {dropin.label}</Text>
        </View>
        <View
          style={[styles.badge, status.open ? styles.badgeFacOpen : styles.badgeFacClosed]}
        >
          <Text style={styles.badgeText}>Facility {status.open ? 'open' : 'closed'}</Text>
        </View>
        <View style={[styles.badge, styles.badgePlace]}>
          <Text style={styles.badgeText}>
            {court.indoor === false ? '🌳 Outdoor' : '🏠 Indoor'}
          </Text>
        </View>
        {live != null && (
          <View
            style={[
              styles.badge,
              fullyBooked
                ? styles.badgeBookedFull
                : live.pct >= 70
                ? styles.badgeBookedHi
                : styles.badgeBookedLo,
            ]}
          >
            <Text style={[styles.badgeText, fullyBooked && styles.badgeTextFull]}>
              {fullyBooked
                ? `🔴 Fully booked${atLabel ? ' at ' + atLabel : live.now ? ' now' : ''}`
                : `📅 ${live.pct}% booked${atLabel ? ' at ' + atLabel : live.now ? ' now' : ''}`}
            </Text>
          </View>
        )}
      </View>

      {dir && (
        <View style={styles.facRow}>
          <View style={styles.facChip}>
            <Text style={styles.facText}>{meta.emoji} {courtCountLabel(dir)}</Text>
          </View>
          {dir.lights && (
            <View style={styles.facChip}>
              <Text style={styles.facText}>🌙 Lights</Text>
            </View>
          )}
          {dir.restrooms && (
            <View style={styles.facChip}>
              <Text style={styles.facText}>🚻 Restrooms</Text>
            </View>
          )}
          {netsLabel(dir.nets) && (
            <View style={styles.facChip}>
              <Text style={styles.facText}>🥅 {netsLabel(dir.nets)}</Text>
            </View>
          )}
        </View>
      )}

      {booked != null && (
        <>
          <Text style={[styles.bookedNote, fullyBooked && styles.bookedNoteFull]}>
            {fullyBooked
              ? `Fully booked ${isPicked ? viewLabel(viewTime) : 'right now'}${
                  partialOpen ? ` (all ${live.open} of ${live.total} bookable courts)${releaseClause}` : ''
                } — try ${isPicked ? 'another time' : 'later'}, or book ahead on rec.us.`
              : live && (live.now || live.picked)
              ? `${live.pct}% booked ${isPicked ? viewLabel(viewTime) : 'right now'}${
                  courtsClause ? ` · ${courtsClause}` : ''
                } on rec.us.`
              : live
              ? `Closed right now — ${live.pct}% booked at ${viewLabel(
                  new Date(live.at.replace(' ', 'T'))
                )} on rec.us.`
              : isPicked
              ? `No rec.us booking slot at ${viewLabel(viewTime)}.`
              : `Reservations on rec.us${
                  booked.courts ? ` · ${booked.courts} courts` : ''
                }.`}
          </Text>
          <Pressable
            style={styles.bookBtn}
            onPress={() => Linking.openURL(booked.url || BOOK_URL)}
          >
            <Text style={styles.bookBtnText}>📅 Reserve this court</Text>
          </Pressable>
          <Pressable hitSlop={6} onPress={() => setBookingHelp((v) => !v)}>
            <Text style={styles.bookHelpToggle}>
              {bookingHelp ? '▾' : '▸'} How booking works
            </Text>
          </Pressable>
          {bookingHelp && (
            <View style={styles.bookHelpBody}>
              {guidelines ? (
                <GuidelineMarkdown text={guidelines} />
              ) : (
                <Text style={styles.bookHelpText}>
                  Courts are reserved on rec.us in fixed timeslots. Most courts book in
                  90-minute slots up to 7 days ahead (released 8 AM); some book in 60-minute
                  slots up to 2 days ahead (released noon). That’s why on a future date not
                  every court is open for booking yet — the shorter-window courts haven’t been
                  released. Courts with lights add evening slots.
                </Text>
              )}
              <Text
                style={[styles.bookHelpLink, { marginTop: 8 }]}
                onPress={() => Linking.openURL(BOOK_HOWTO_URL)}
              >
                SF Rec &amp; Park how-to guide ›
              </Text>
            </View>
          )}
        </>
      )}

      {(court.distanceMi != null || (dropin.open && court.remaining > 0)) && (
        <Text style={styles.metaLine}>
          {[
            court.distanceMi != null ? `📍 ${formatDistance(court.distanceMi)} away` : null,
            dropin.open && court.remaining > 0 ? `⏳ ${fmtDuration(court.remaining)} left` : null,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </Text>
      )}

      {canLogVisit && !isPicked && (
        <Pressable style={styles.checkInBtn} onPress={doLogVisit}>
          <Text style={styles.checkInBtnText}>
            {meta.emoji} I played {meta.label.toLowerCase()} here — check in
          </Text>
        </Pressable>
      )}

      {isPicked ? (
        <View style={styles.futureBox}>
          <Text style={styles.futureText}>
            🕒 Showing {viewLabel(viewTime)} — live crowd check-ins are hidden.
          </Text>
        </View>
      ) : (
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
      )}

      <Pressable style={styles.expandToggle} onPress={() => setExpanded((v) => !v)}>
        <Text style={styles.expandToggleText}>
          {expanded ? '⌃  Hide details' : '⌄  Schedule & reviews'}
        </Text>
      </Pressable>

      {expanded && (
      <ScrollView style={styles.cardScroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>Open-gym {meta.label.toLowerCase()}</Text>
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
                !d.hasDropin && styles.weekClosed,
                d.isToday && styles.weekTodayText,
              ]}
            >
              {d.label}
            </Text>
          </View>
        ))}

        {!!court.notes && <Text style={styles.notes}>{court.notes}</Text>}
        <Text style={styles.disclaimer}>
          {court.disclaimer ||
            'Open-gym times (summer) vary seasonally — verify on sfrecpark.org.'}
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
  safe: { flex: 1, backgroundColor: '#eef1f5' },

  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    gap: 10,
  },
  headerText: { flex: 1 },
  headerBtns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 8,
  },
  account: {
    backgroundColor: '#1b2b3d',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    maxWidth: 150,
  },
  accountText: { color: '#1f2a37', fontWeight: '700', fontSize: 13 },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#e8730c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  title: { color: '#0d1b2a', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#1f2a37', fontSize: 15, fontWeight: '700' },
  updated: { color: '#8a99a8', fontSize: 11, marginTop: 2 },

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
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  openToggleActive: { backgroundColor: '#1f9d55', borderColor: '#1f9d55' },
  openToggleText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  openToggleTextActive: { color: '#fff' },

  // Active tab page fills the space above the bottom nav; overlays anchor to it.
  pageWrap: { flex: 1, position: 'relative' },
  // The nav floats over the bottom of the full-screen content (box-none lets taps
  // on the transparent area around the pill pass through to the map).
  navWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 50 },
  // Controls float over the top of the map so it can fill the screen.
  body: { flex: 1, position: 'relative' },
  controls: {
    position: 'absolute',
    top: 58,
    left: 0,
    right: 0,
    zIndex: 20,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: 'rgba(238,241,245,0.92)',
  },
  updatedPill: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 25,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    shadowColor: '#0d1b2a',
    shadowOpacity: 0.12,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  updatedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1f9d55' },
  updatedPillText: { fontSize: 12, fontWeight: '700', color: '#46586a' },
  fab: {
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
  filterFab: { position: 'absolute', top: 10, right: 14, zIndex: 25 },
  filterFabActive: { backgroundColor: '#2f74d6' },
  sportRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sportChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  sportChipActive: { backgroundColor: '#e8732c', borderColor: '#e8732c' },
  sportChipText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  sportChipTextActive: { color: '#fff' },
  placeRow: { flexDirection: 'row', gap: 6 },
  placeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  placeChipActive: { backgroundColor: '#e7f0fc', borderColor: '#2f74d6' },
  placeChipText: { color: '#5b6b7b', fontWeight: '700', fontSize: 12 },
  placeChipTextActive: { color: '#2f74d6' },
  amenityRow: { gap: 6, paddingRight: 12 },
  amenityChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  amenityChipActive: { backgroundColor: '#e7f0fc', borderColor: '#2f74d6' },
  amenityChipText: { color: '#5b6b7b', fontWeight: '700', fontSize: 12 },
  amenityChipTextActive: { color: '#2f74d6' },
  filterRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  menuBtn: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  menuBtnActive: { backgroundColor: '#e8732c', borderColor: '#e8732c' },
  menuBtnText: { color: '#1f2a37', fontWeight: '800', fontSize: 13 },
  menuBtnTextActive: { color: '#fff' },
  filtersPanel: { marginTop: 10, gap: 8 },

  timePill: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  timePillActive: { backgroundColor: '#2f74d6', borderColor: '#2f74d6' },
  timePillText: { color: '#46586a', fontWeight: '700', fontSize: 13 },
  timePillTextActive: { color: '#fff' },
  timeReset: { paddingHorizontal: 6, paddingVertical: 9 },
  timeResetText: { color: '#8a99a8', fontWeight: '700', fontSize: 14 },

  planRunBtn: {
    marginLeft: 'auto',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#1f9d55',
  },
  planRunBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  pickerPanel: { marginTop: 10, gap: 8 },
  chipRow: { gap: 8, paddingRight: 16 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#dde3ea',
  },
  chipActive: { backgroundColor: '#e8730c', borderColor: '#e8730c' },
  chipDisabled: { backgroundColor: '#eef1f4', borderColor: '#eef1f4', opacity: 0.7 },
  chipText: { color: '#46586a', fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  chipTextDisabled: { color: '#aab4bd', fontWeight: '500' },

  futureBox: {
    backgroundColor: '#eef3fb',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  futureText: { fontSize: 12, color: '#3b5573', fontWeight: '600', lineHeight: 17 },

  mapWrap: { flex: 1, overflow: 'hidden' },

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
    zIndex: 1000,
  },
  locatingText: { color: '#fff', fontSize: 13 },

  recenterBtn: {
    position: 'absolute',
    right: 14,
    bottom: 92, // clear of the map's bottom-right zoom control
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
    zIndex: 1000,
  },
  recenterIcon: { fontSize: 22, color: '#2f74d6' },

  nearbyBtn: {
    position: 'absolute',
    left: 14,
    bottom: 14,
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    zIndex: 1000,
  },
  nearbyBtnText: { fontSize: 14, color: '#2f74d6', fontWeight: '800' },

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

  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, marginBottom: 6 },
  metaLine: { fontSize: 13, color: '#46586a', fontWeight: '600', marginBottom: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  badgeOpen: { backgroundColor: '#d4f3df' },
  badgeClosed: { backgroundColor: '#f3d9d9' },
  badgeFacOpen: { backgroundColor: '#e3eefb' },
  badgeFacClosed: { backgroundColor: '#eceff2' },
  badgePlace: { backgroundColor: '#e7efe2' },
  badgeBookedHi: { backgroundColor: '#f7e0cf' },
  badgeBookedLo: { backgroundColor: '#fdf1d6' },
  badgeBookedFull: { backgroundColor: '#e74c3c' },
  badgeTextFull: { color: '#fff' },
  facRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  facChip: {
    backgroundColor: '#eef2f6',
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  facText: { fontSize: 12, fontWeight: '600', color: '#46586a' },
  bookedNote: { fontSize: 12, color: '#7a6a55', marginBottom: 8, lineHeight: 16 },
  bookedNoteFull: { color: '#c0392b', fontWeight: '700' },
  bookBtn: {
    backgroundColor: '#e8732c',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginBottom: 8,
  },
  bookBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  bookHowto: { fontSize: 12, color: '#2f74d6', fontWeight: '700', marginBottom: 10 },
  bookHelpToggle: { fontSize: 12, color: '#2f74d6', fontWeight: '700', marginBottom: 6 },
  bookHelpBody: { marginBottom: 10 },
  bookHelpText: { fontSize: 12, color: '#5b6b7b', lineHeight: 17 },
  bookHelpLink: { color: '#2f74d6', fontWeight: '700' },
  guideText: { fontSize: 12, color: '#5b6b7b', lineHeight: 17 },
  guideBulletText: { paddingLeft: 8 },
  guideBold: { fontWeight: '800', color: '#3a4a5a' },
  checkInBtn: {
    backgroundColor: '#1f9d55',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginBottom: 10,
  },
  checkInBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
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
