// Social activity feed: one running notification stream merging friends' "down
// to hoop" signals (and joinable sessions), upcoming planned runs, and recent
// "checked into a court" events. The Activity sheet renders these; the header
// badge shows how many are unread.
//
// "Unread" is tracked locally: a single "last seen the feed" timestamp in
// AsyncStorage. An item counts as unread when its created_at is newer than that
// and it isn't your own post.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadSignals } from './signals';
import { loadUpcomingRuns } from './runs';
import { loadRecentCheckins } from './playerCheckins';
import { getBlockedIds } from './blocks';

const SEEN_KEY = 'recreate:feedSeenAt';

// Unified, newest-first activity from friends' signals, upcoming runs, and recent
// check-ins. Each item is tagged with `kind` and carries the original object so
// the sheet can render and act on it. Newest-first makes it read as a running
// notification stream ("Kevin just checked into Palega").
export async function loadFeed() {
  const [signals, runs, checkins] = await Promise.all([
    loadSignals(),
    loadUpcomingRuns(),
    loadRecentCheckins(),
  ]);
  const items = [
    ...signals.map((s) => ({
      kind: 'signal',
      id: s.id,
      createdAt: s.createdAt,
      // Confirmed session time, else scheduled start, else null ("right now").
      eventTime: s.plannedAt || s.startsAt || null,
      mine: s.mine,
      signal: s,
    })),
    ...runs.map((r) => ({
      kind: 'run',
      id: r.id,
      createdAt: r.createdAt,
      eventTime: r.startsAt,
      mine: r.mine,
      run: r,
    })),
    ...checkins.map((c) => ({
      kind: 'checkin',
      id: `checkin:${c.id}`,
      createdAt: c.createdAt,
      eventTime: c.createdAt,
      mine: c.mine,
      checkin: c,
    })),
  ];
  // Drop anything from a blocked user (signals are already filtered at source;
  // this also covers their runs and check-ins).
  const blocked = await getBlockedIds();
  const authorOf = (x) =>
    x.kind === 'signal' ? x.signal?.userId : x.kind === 'run' ? x.run?.hostId : x.checkin?.userId;
  const visible = items.filter((x) => !blocked.has(authorOf(x)));
  // Newest activity first.
  const created = (x) => (x.createdAt ? new Date(x.createdAt).getTime() : 0);
  visible.sort((a, b) => created(b) - created(a));
  return visible;
}

export async function getFeedSeenAt() {
  try {
    const v = await AsyncStorage.getItem(SEEN_KEY);
    return v ? Number(v) : 0;
  } catch (e) {
    return 0;
  }
}

export async function markFeedSeen() {
  try {
    await AsyncStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch (e) {
    // Non-fatal: the badge just won't clear until next time.
  }
}

// How many feed items are newer than `seenAt` and aren't the user's own — you
// don't need to be alerted about things you posted.
export function unreadCount(items, seenAt) {
  return items.filter((it) => {
    if (it.mine) return false;
    const c = it.createdAt ? new Date(it.createdAt).getTime() : 0;
    return c > seenAt;
  }).length;
}
