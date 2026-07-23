import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BUNDLED, { GENERATED_AT } from '../data/courts';
import MANUAL_COURTS from '../data/manual-courts';
import SANBRUNO_COURTS from '../data/sanbruno-court';
import OUTDOOR_COURTS from '../data/outdoor-courts';
import CITY_COURTS from '../data/cities';
import POOL_COURTS from './poolCourts';
import { RESERVATIONS } from '../data/reservations';
import { DIRECTORY } from '../data/court-directory';

// Courts outside the SF indoor-gym scrape (manual, San Bruno, outdoor racquet
// courts, other metros), folded into every source list. The app scopes what it
// shows by each record's `city` (missing = 'sf' for older cached payloads).
const EXTRA_COURTS = [...MANUAL_COURTS, ...SANBRUNO_COURTS, ...OUTDOOR_COURTS, ...POOL_COURTS, ...Object.values(CITY_COURTS).flat()];

// Attach the rec.us "% booked" snapshot (court id -> { sport: { pct, courts } })
// as `reserved`, and the SF Rec & Park directory facts (court id -> { sport:
// { total, lights, restrooms, ... } }) as `directory`, for the detail card.
// A directory entry carrying `playWeek` is an authoritative posted schedule for
// that sport (e.g. Presidio Wall tennis is 7:30-9 AM daily per its poster) — it
// replaces the court's generic daylight dropins so open-now status, markers,
// and the card's schedule all agree.
function withReservations(list) {
  if (!Array.isArray(list)) return list;
  return list.map((c) => {
    if (!c) return c;
    const r = RESERVATIONS[c.id];
    const d = DIRECTORY[c.id];
    if (!r && !d) return c;
    const m = { ...c, ...(r && { reserved: r }), ...(d && { directory: d }) };
    if (d) {
      for (const [sport, entry] of Object.entries(d)) {
        if (entry && entry.playWeek && m.dropins && m.dropins[sport]) {
          m.dropins = { ...m.dropins, [sport]: entry.playWeek };
        }
      }
    }
    return m;
  });
}

// Where the app fetches fresh court data at launch. Set this to your hosted
// courts.json — e.g. the raw URL of the file the cron commits:
//   https://raw.githubusercontent.com/<user>/RECreate/main/data/courts.json
// Configure without editing code via an env var (Expo inlines EXPO_PUBLIC_*):
//   EXPO_PUBLIC_COURTS_URL=https://.../courts.json
// Until it's set, the app just uses the bundled data — everything still works.
const REMOTE_URL = process.env.EXPO_PUBLIC_COURTS_URL || '';

const CACHE_KEY = 'recreate.courts.v1';

// Defensive: only trust data that looks like our court list.
function isValid(courts) {
  return (
    Array.isArray(courts) &&
    courts.length > 0 &&
    courts.every(
      (c) =>
        c &&
        typeof c.id === 'string' &&
        typeof c.lat === 'number' &&
        typeof c.lng === 'number' &&
        c.dropins &&
        Array.isArray(c.dropins.basketball)
    )
  );
}

// Remote payload is { generatedAt, season, courts }; bundled is a bare array.
function normalize(json) {
  return Array.isArray(json) ? json : json && json.courts;
}

// Fold the non-sfrecpark courts (manual + San Bruno) into any source list.
// Deduped by id so an extra entry can't double up a generated SF one.
function withManual(list) {
  if (!Array.isArray(list)) return withReservations(EXTRA_COURTS);
  const ids = new Set(list.map((c) => c && c.id));
  return withReservations(list.concat(EXTRA_COURTS.filter((c) => !ids.has(c.id))));
}

/**
 * Returns the freshest available court list:
 *   bundled (instant) → cached (offline/last good) → remote (revalidated).
 * Never throws and never blocks render; falls back gracefully at every step.
 *
 * In development we short-circuit to the bundled data only (no cache, no remote),
 * so local `npm run build:courts` edits are visible immediately without a push or
 * cache clear. Production keeps the full bundled → cached → remote flow.
 */
export function useCourts() {
  const [courts, setCourts] = useState(() => withManual(BUNDLED));
  const [source, setSource] = useState('bundled');
  const [generatedAt, setGeneratedAt] = useState(GENERATED_AT || null);

  useEffect(() => {
    if (__DEV__) return; // dev: trust the freshly-built local bundle

    let alive = true;

    (async () => {
      // 1) Hydrate from cache immediately (works offline, may beat the network).
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (alive && cached) {
          const payload = JSON.parse(cached);
          const parsed = normalize(payload);
          if (isValid(parsed)) {
            setCourts(withManual(parsed));
            setSource('cached');
            if (payload && payload.generatedAt) setGeneratedAt(payload.generatedAt);
          }
        }
      } catch {
        // ignore — fall back to bundled
      }

      // 2) Revalidate from the network if a remote URL is configured.
      if (!REMOTE_URL || REMOTE_URL.includes('<')) return;
      try {
        const res = await fetch(REMOTE_URL, { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        const fresh = normalize(json);
        if (alive && isValid(fresh)) {
          setCourts(withManual(fresh));
          setSource('remote');
          if (json && json.generatedAt) setGeneratedAt(json.generatedAt);
          await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(json));
        }
      } catch {
        // offline or fetch failed — keep cached/bundled data
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  return { courts, source, generatedAt };
}
