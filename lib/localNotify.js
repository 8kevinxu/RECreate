// Interest-based local notifications (no server). When the app opens/foregrounds,
// we schedule on-device reminders ~30 min before today's interest-matched things —
// open-gym games for your favorite sports and rec classes with openings in your
// favorite categories — so you get a nudge even if the app is closed. Each item is
// scheduled at most once per day (deduped in AsyncStorage). Server push (for events
// while the app has never been opened) is a later addition; this is the MVP.
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildRecommendations } from './recommend';
import { CLASS_CATEGORIES } from '../data/classes';
import { sportMeta } from './sports';
import { fmtClock } from './datetime';
import { tg } from './i18n';

const STORE = 'recreate.localNotify';
const LEAD_MS = 30 * 60 * 1000; // remind ~30 min before it starts
const MAX_PER_DAY = 6; // don't spam
const CAT_EMOJI = Object.fromEntries(CLASS_CATEGORIES.map((c) => [c.id, c.emoji]));
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const dayStamp = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

// "Tue · 1:00 PM - 4:00 PM" → { dow, startMin }, or null if unparseable.
function parseClassWhen(when) {
  const m = (when || '').match(/^(\w{3})\s*·\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  const dow = DOW[m[1]];
  if (dow == null) return null;
  let h = parseInt(m[2], 10);
  const min = parseInt(m[3], 10);
  const ap = m[4].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return { dow, startMin: h * 60 + min };
}

export async function syncInterestNotifications({
  courts = [],
  sports = [],
  categories = [],
  age = null,
  lang = 'en',
  now = new Date(),
  classes, // the active city's class list (undefined = SF default)
} = {}) {
  if (Platform.OS === 'web' || !Device.isDevice) return 0;
  if (!sports.length && !categories.length) return 0; // only notify on real interests

  let perm = await Notifications.getPermissionsAsync();
  if (perm.status !== 'granted') perm = await Notifications.requestPermissionsAsync();
  if (perm.status !== 'granted') return 0;

  const stamp = dayStamp(now);
  let store = { stamp, keys: [] };
  try {
    const raw = await AsyncStorage.getItem(STORE);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && parsed.stamp === stamp) store = parsed;
    else await Notifications.cancelAllScheduledNotificationsAsync(); // new day → clear stale
  } catch {}

  const done = new Set(store.keys);
  const recs = buildRecommendations({ courts, sports, categories, age, now, max: 40, ...(classes && { classes }) });
  const nowMs = now.getTime();

  for (const r of recs) {
    if (done.size >= MAX_PER_DAY) break;
    if (done.has(r.key)) continue;

    let startMin;
    let title;
    let data;
    if (r.kind === 'sport') {
      if (r.ongoing) continue; // already happening — nothing to remind about
      startMin = r.startMin;
      title = `${sportMeta(r.sport).emoji} ${tg('sport.' + r.sport)} · ${r.courtName}`;
      data = { courtId: r.courtId, sport: r.sport };
    } else {
      const w = parseClassWhen(r.when);
      if (!w || w.dow !== now.getDay()) continue; // classes: today only
      startMin = w.startMin;
      title = `${CAT_EMOJI[r.category] || '✨'} ${r['name_' + lang] || r.name}`;
      data = r.url ? { url: r.url } : {};
    }

    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Math.floor(startMin / 60),
      startMin % 60
    );
    if (start.getTime() <= nowMs) continue;
    const fireAt = new Date(Math.max(nowMs + 60000, start.getTime() - LEAD_MS));
    const time = fmtClock(Math.floor(startMin / 60), startMin % 60);
    const body =
      r.kind === 'sport'
        ? tg('ln.atTime', { time })
        : tg('ln.classOpen', { place: r.location, time });

    try {
      await Notifications.scheduleNotificationAsync({
        content: { title, body, data },
        trigger: { type: Notifications.SchedulableTriggerInputTypes?.DATE ?? 'date', date: fireAt },
      });
      done.add(r.key);
    } catch {}
  }

  try {
    await AsyncStorage.setItem(STORE, JSON.stringify({ stamp, keys: [...done] }));
  } catch {}
  return done.size;
}
