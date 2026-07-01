// Real-time reservable-court availability from rec.us, fetched at runtime when a
// court detail opens — so "% booked at 3 PM" reflects right now, not the weekly
// build snapshot in data/reservations.js (which stays as the instant baseline and
// the fallback). React Native's native fetch isn't bound by browser CORS, so we
// can hit api.rec.us directly; on web the request CORS-fails and callers keep the
// snapshot (same graceful-degrade as lib/classesLive.js).
//
// Returns, for one rec.us location, { at, bySport: { tennis|pickleball: {pct,
// courts, slots, open?, released?, windows?, url} } } shaped exactly like a
// data/reservations.js per-sport entry so the app can overlay it directly, or
// null on failure. The slot math mirrors scripts/build-reservations.js — keep the
// two in sync.

const API = 'https://api.rec.us';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': BROWSER_UA, Origin: 'https://www.rec.us', Accept: 'application/json' };

const WINDOW_DAYS = 7; // how far ahead to compute occupancy (matches the build)
const GRID_MIN = 30; // reservations book on a 30-min start grid
const RESERVABLE_SPORTS = ['tennis', 'pickleball'];
const TTL_MS = 60 * 1000; // serve a cached location for this long (re-opens/tab flips)

const TZ = 'America/Los_Angeles';
const pad2 = (n) => String(n).padStart(2, '0');
// Read a Date's SF-local wall-clock fields regardless of device tz.
const sfDate = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ }));
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const keyOf = (d) => `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// Current 30-min slot key in SF time; slots before it are past (unbookable).
function nowSlotKey(now) {
  return `${ymd(now)} ${pad2(now.getHours())}:${now.getMinutes() < 30 ? '00' : '30'}`;
}

// The next WINDOW_DAYS calendar days starting today (SF), as { date, dow }.
function windowDays(now) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push({ date: ymd(d), dow: d.getDay() });
  }
  return out;
}

// Bookable "HH:MM" starts on the 30-min grid that fit a min-length booking in
// [openFrom, openTo).
function gridStarts(openFrom, openTo) {
  const toMin = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const a = toMin(openFrom), b = toMin(openTo);
  const out = [];
  for (let m = a; m + GRID_MIN <= b; m += GRID_MIN) {
    out.push(`${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);
  }
  return out;
}

// How far ahead a court takes bookings, in hours (shorter windows release fewer
// slots on far-out dates — see build-reservations.js for the rationale).
function courtWindowHours(court, locDefaultDays) {
  const w = court.reservationWindows?.[0]?.maxHours;
  if (Number.isFinite(w)) return w;
  if (Number.isFinite(court.defaultReservationWindowDays)) return court.defaultReservationWindowDays * 24;
  if (Number.isFinite(locDefaultDays)) return locDefaultDays * 24;
  return WINDOW_DAYS * 24;
}

// Our sport ids a court is lined for.
function courtSports(court, sportMap) {
  const set = new Set();
  for (const sp of court.sports || []) {
    const our = sportMap[sp.sportId];
    if (our) set.add(our);
  }
  return [...set];
}

// Per-court bookable 30-min starts the court is OPEN for over the window, as
// { key, free, released } (see build-reservations.js courtSlots).
function courtSlots(court, win, nowKey, horizonKey) {
  const free = new Set((court.availableSlots || []).map((s) => String(s).slice(0, 16)));
  const out = [];
  for (const { date, dow } of win) {
    for (const sl of court.slots || []) {
      if (sl.dayOfWeek !== dow) continue;
      for (const hhmm of gridStarts(sl.openFrom, sl.openTo)) {
        const key = `${date} ${hhmm}`;
        if (key < nowKey) continue;
        out.push({ key, free: free.has(key), released: key <= horizonKey });
      }
    }
  }
  return out;
}

// Aggregate one location's courts into per-sport { pct, courts, slots, open?,
// released?, windows? } — the same shape data/reservations.js stores per sport.
function locationBySport(location, win, sportMap, nowKey, now, url) {
  const agg = {};
  const locDefaultDays = location.defaultReservationWindow;
  for (const court of location.courts || []) {
    const sports = courtSports(court, sportMap);
    if (!sports.length) continue;
    const hours = courtWindowHours(court, locDefaultDays);
    const horizonKey = keyOf(new Date(now.getTime() + hours * 3600 * 1000));
    const slots = courtSlots(court, win, nowKey, horizonKey);
    if (!slots.length) continue;
    for (const sport of sports) {
      const a = (agg[sport] ||= { total: 0, reserved: 0, courts: 0, slots: {}, windows: new Set() });
      a.courts += 1;
      a.windows.add(hours);
      for (const { key, free, released } of slots) {
        const s = (a.slots[key] ||= { open: 0, rel: 0, booked: 0 });
        s.open += 1;
        if (released) {
          s.rel += 1;
          a.total += 1;
          if (!free) { s.booked += 1; a.reserved += 1; }
        }
      }
    }
  }

  const out = {};
  for (const [sport, a] of Object.entries(agg)) {
    const slots = {}, open = {}, released = {};
    for (const [key, s] of Object.entries(a.slots)) {
      if (s.rel === 0) continue; // nothing bookable then → no % to show
      slots[key] = Math.round((s.booked / s.rel) * 100);
      if (s.open < a.courts) open[key] = s.open;
      if (s.rel < s.open) released[key] = s.rel;
    }
    const windows = [...a.windows].sort((x, y) => x - y);
    out[sport] = {
      pct: a.total ? Math.round((a.reserved / a.total) * 100) : 0,
      courts: a.courts,
      slots,
      ...(Object.keys(open).length ? { open } : {}),
      ...(Object.keys(released).length ? { released } : {}),
      ...(windows.length > 1 ? { windows } : {}),
      url,
    };
  }
  return out;
}

let sportMapCache = null; // rec.us sportId -> our sport id
async function fetchSportMap() {
  if (sportMapCache) return sportMapCache;
  const res = await fetch(`${API}/v1/sports`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  const arr = Array.isArray(d) ? d : d.data || [];
  const map = {};
  for (const s of arr) {
    const our = String(s.name || '').toLowerCase();
    if (RESERVABLE_SPORTS.includes(our)) map[s.id] = our;
  }
  sportMapCache = map;
  return map;
}

const cache = new Map(); // locationId -> { at, bySport }

// Live availability for one rec.us location id. Returns { at, bySport } or null.
export async function fetchLiveReservations(locationId, force = false) {
  if (!locationId) return null;
  const hit = cache.get(locationId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit;
  try {
    const sportMap = await fetchSportMap();
    const res = await fetch(`${API}/v1/locations/${locationId}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const location = (await res.json()).location;
    if (!location) return null;
    const now = sfDate();
    const bySport = locationBySport(
      location,
      windowDays(now),
      sportMap,
      nowSlotKey(now),
      now,
      `https://www.rec.us/locations/${locationId}`
    );
    if (!Object.keys(bySport).length) return null;
    const entry = { at: Date.now(), bySport };
    cache.set(locationId, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

// Pull the rec.us location id out of a stored reservation `url`.
export function locationIdFromUrl(url) {
  const m = String(url || '').match(/locations\/([0-9a-f-]{8,})/i);
  return m ? m[1] : null;
}
