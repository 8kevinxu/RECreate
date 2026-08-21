import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BUNDLED, { GENERATED_AT } from '../data/courts';
import MANUAL_COURTS from '../data/manual-courts';
import SANBRUNO_COURTS from '../data/sanbruno-court';
import OUTDOOR_COURTS from '../data/outdoor-courts';
import CITY_COURTS, { CITY_RESERVATIONS } from '../data/cities';
import POOL_COURTS from './poolCourts';
import { RESERVATIONS, GENERATED_AT as RES_GENERATED_AT } from '../data/reservations';
import { DIRECTORY } from '../data/court-directory';

// Occupancy for every metro in one lookup: SF's rec.us snapshot plus each city's
// own source (NYC = Parks permits + the 8 online tennis sites). Court ids are
// namespaced per city, so a flat merge can't collide — and every entry uses the
// same `reserved` contract, so lib/reservations.js reads them all one way.
// SF's half is refreshed at runtime (see the reservation effect in useCourts), so
// this is a function of the current snapshot rather than a module constant; the
// other cities' sources are bundled-only and never change under us.
const allReservations = (sf) => Object.assign({}, sf, ...Object.values(CITY_RESERVATIONS));

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
function withReservations(list, res) {
  if (!Array.isArray(list)) return list;
  return list.map((c) => {
    if (!c) return c;
    const r = res[c.id];
    const d = DIRECTORY[c.id];
    if (!r && !d) return c;
    const m = { ...c, ...(r && { reserved: r }), ...(d && { directory: d }) };
    if (d) {
      for (const [sport, entry] of Object.entries(d)) {
        if (entry && entry.playWeek && m.dropins && m.dropins[sport]) {
          m.dropins = { ...m.dropins, [sport]: entry.playWeek };
        }
        // A community-reported week (pickleballsf, for indoor pickleball SFRP
        // lists as an amenity but never schedules) fills a sport ONLY when we
        // have no hours of our own for it. Checked against the CURRENT week, so
        // a playWeek applied just above also wins — the merge is structurally
        // incapable of overriding SFRP, which is why the source is allowed in.
        if (entry && entry.communityWeek) {
          const have = (m.dropins && m.dropins[sport]) || [];
          if (!have.some((day) => day && day.length)) {
            m.dropins = { ...m.dropins, [sport]: entry.communityWeek };
          }
        }
        // SFRP's directory is the authority on which sports a facility runs —
        // better than DataSF, which is where a court's sports otherwise come
        // from. When the directory counts courts for a sport the court has no
        // hours for, it's an outdoor first-come park (Alta Plaza, States
        // Street, Willie "Woo Woo" Wong, Goldman), so give it the park's own
        // daylight hours, exactly how every other outdoor pickleball pin works.
        // Indoor gyms are excluded: a rec center's gym time is scheduled, and
        // handing it building hours would invent open gym that isn't there.
        // Gated on walk-up courts, not just counted ones: park hours are only
        // the truth where play is first-come. Goldman has 5 pickleball courts
        // but zero walk-up — it's reservation-only, fee-charging and run by a
        // third party on its own 8AM-10PM day, so handing it the park's
        // 5AM-midnight would overstate it by five hours daily. It keeps its
        // directory facts and stays off the map until it has real hours.
        if (entry && entry.walkup > 0 && m.indoor === false && Array.isArray(m.schedule)) {
          const have = (m.dropins && m.dropins[sport]) || [];
          if (!have.some((day) => day && day.length)) {
            m.dropins = {
              ...m.dropins,
              [sport]: m.schedule.map((h) => (h ? [[h[0], h[1]]] : [])),
            };
          }
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

// Where the app fetches a fresh occupancy snapshot, and where it keeps the last
// good one. Same shape as the courts pair above:
//   EXPO_PUBLIC_RESERVATIONS_URL=https://.../data/reservations.json
// Unset means bundled-only, which is what shipped before this path existed.
const RES_REMOTE_URL = process.env.EXPO_PUBLIC_RESERVATIONS_URL || '';
const RES_CACHE_KEY = 'recreate.reservations.v1';
// Don't re-ask the network more than this often. Foregrounding is user-driven and
// bursty (every app switch fires it), while the source only republishes every 3
// hours, so anything shorter is spend without freshness to show for it.
const RES_MIN_REFETCH_MS = 60 * 60 * 1000;

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

// Defensive: only trust a payload that looks like the reservation map (court id
// -> { sport: { slots, ... } }). Shape, not volume — a quiet week is not a
// corrupt fetch, and the build already refuses to publish a gutted scrape.
// Court entries also carry a plain `guidelines` string alongside the sports,
// hence the typeof guard rather than assuming every value is an object.
function isValidReservations(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const ids = Object.keys(map);
  if (!ids.length) return false;
  if (!ids.every((id) => map[id] && typeof map[id] === 'object')) return false;
  return ids.some((id) =>
    Object.values(map[id]).some(
      (v) => v && typeof v === 'object' && v.slots && typeof v.slots === 'object'
    )
  );
}

// Is `a` a strictly newer build stamp than `b`? Used to refuse a payload older
// than the one we already have — a CDN can serve a stale copy, and downgrading a
// live snapshot to an expired one is the exact failure this path exists to stop.
function isNewer(a, b) {
  const x = Date.parse(a || '');
  if (!Number.isFinite(x)) return false;
  const y = Date.parse(b || '');
  return !Number.isFinite(y) || x > y;
}

// Remote payload is { generatedAt, season, courts }; bundled is a bare array.
function normalize(json) {
  return Array.isArray(json) ? json : json && json.courts;
}

// Fold the non-sfrecpark courts (manual + San Bruno) into any source list.
// Deduped by id so an extra entry can't double up a generated SF one.
function withManual(list, res) {
  if (!Array.isArray(list)) return withReservations(EXTRA_COURTS, res);
  const ids = new Set(list.map((c) => c && c.id));
  return withReservations(list.concat(EXTRA_COURTS.filter((c) => !ids.has(c.id))), res);
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
  const [rawCourts, setRawCourts] = useState(BUNDLED);
  const [source, setSource] = useState('bundled');
  const [generatedAt, setGeneratedAt] = useState(GENERATED_AT || null);
  // SF occupancy, refreshed on its own schedule below — the court list and the
  // snapshot come from different builds and either can arrive first.
  const [sfReservations, setSfReservations] = useState(RESERVATIONS);
  const [reservationsGeneratedAt, setReservationsGeneratedAt] = useState(RES_GENERATED_AT || null);

  // Re-merged whenever either half lands, so a refreshed snapshot reaches the
  // map markers and Nearby list, not just the detail card.
  const courts = useMemo(
    () => withManual(rawCourts, allReservations(sfReservations)),
    [rawCourts, sfReservations]
  );

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
            setRawCourts(parsed);
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
          setRawCourts(fresh);
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

  // Carried across refreshes rather than kept in the effect's closure: the
  // freshest stamp we've accepted, and when we last reached the server.
  const resBestAt = useRef(RES_GENERATED_AT || null);
  const resFetchedAt = useRef(0);

  /**
   * Refresh the SF occupancy snapshot: bundled → cached → remote, on launch and
   * again on foreground.
   *
   * This is the one dataset that has to come down over the wire. Court hours are
   * weekday-indexed and stay correct forever, but reservation slots are keyed to
   * ABSOLUTE dates on a rolling window — so the copy compiled into a build stops
   * resolving about a week after it ships, `liveBooked()` starts returning null
   * for every court, and the app quietly shows no booking indicator anywhere
   * rather than showing something stale. An OTA or store release used to be the
   * only way to move it.
   *
   * Launch alone isn't enough, because on iOS "launch" is rare: tapping the icon
   * on a suspended app resumes it without remounting, so a process that lives a
   * week would fetch exactly once and then expire with the network right there.
   * Foregrounding is the event that actually correlates with someone looking at
   * the map, which is also the surface that has no live fallback — the detail
   * card refetches rec.us on open, but markers and Nearby read this snapshot.
   */
  useEffect(() => {
    if (__DEV__) return; // dev: trust the freshly-built local bundle

    let alive = true;

    const apply = (payload) => {
      if (!alive || !payload || !isValidReservations(payload.reservations)) return;
      if (!isNewer(payload.generatedAt, resBestAt.current)) return;
      resBestAt.current = payload.generatedAt;
      setSfReservations(payload.reservations);
      setReservationsGeneratedAt(payload.generatedAt);
    };

    const revalidate = async () => {
      if (!RES_REMOTE_URL || RES_REMOTE_URL.includes('<')) return;
      try {
        const res = await fetch(RES_REMOTE_URL, { cache: 'no-store' });
        // The server answered (even a 404) — start the cooldown. A thrown fetch
        // never reached it, so that case deliberately leaves the clock alone and
        // the next foreground retries as soon as connectivity is back.
        resFetchedAt.current = Date.now();
        if (!res.ok) return;
        const json = await res.json();
        if (!alive || !json || !isValidReservations(json.reservations)) return;
        // Cache whatever validated, even if it isn't newer than what we have —
        // next launch starts from it instead of from the aging bundle.
        await AsyncStorage.setItem(RES_CACHE_KEY, JSON.stringify(json));
        apply(json);
      } catch {
        // offline or fetch failed — keep cached/bundled data
      }
    };

    (async () => {
      // Last good snapshot — instant, and the reason this works offline.
      try {
        const cached = await AsyncStorage.getItem(RES_CACHE_KEY);
        if (cached) apply(JSON.parse(cached));
      } catch {
        // ignore — fall back to the bundled snapshot
      }
      await revalidate();
    })();

    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Date.now() - resFetchedAt.current < RES_MIN_REFETCH_MS) return;
      revalidate();
    });

    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);

  return { courts, source, generatedAt, reservationsGeneratedAt };
}
