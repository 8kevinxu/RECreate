#!/usr/bin/env node
/*
 * Build data/reservations.js — how booked-out each reservable outdoor court is,
 * from rec.us (the platform SF Rec & Park uses for tennis / pickleball / some
 * basketball court reservations). Run with:  npm run build:reservations
 *
 * rec.us is an undocumented Next.js app backed by api.rec.us. The per-location
 * endpoint is public and returns, per court, its open-hours schedule (`slots`)
 * and the list of still-FREE booking times (`availableSlots`) over the booking
 * window. We turn that into a "% booked" per court + sport:
 *
 *     booked% = 1 - (free slots / total bookable slots), over the next N days.
 *
 * The /v1/locations list ignores org filters (returns ALL ~1.6k rec.us locations
 * globally), so we page it, keep the ones inside an SF bounding box, drop test
 * facilities, then match each to one of our courts by proximity + sport and write
 * data/reservations.js (a courtId -> { sport: { pct, courts } } map merged at
 * runtime by lib/useCourts.js).
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (reservations-cache.json); a fetch failure keeps the existing data file.
 */

const fs = require('fs');
const path = require('path');

const API = 'https://api.rec.us';
const CACHE_FILE = path.join(__dirname, 'reservations-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'reservations.js');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': BROWSER_UA, Origin: 'https://www.rec.us', Accept: 'application/json' };

// SF bounding box (rec.us serves many cities; the list endpoint is global).
const SF_BBOX = { minLat: 37.70, maxLat: 37.83, minLng: -122.52, maxLng: -122.35 };
const inSF = (l) => l.lat > SF_BBOX.minLat && l.lat < SF_BBOX.maxLat &&
  l.lng > SF_BBOX.minLng && l.lng < SF_BBOX.maxLng;

// Skip rec.us internal / test facilities.
const IS_TEST = /\btest\b|ops team|conference|ankur home|pv test|fixed timeslot/i;

// How far ahead to measure occupancy, and how close a rec.us location must be to
// one of our courts (parks are big, so the centroid can be a few hundred ft off).
const WINDOW_DAYS = 7;
const MATCH_MAX_FEET = 1320;

// Abort (keep last-good data) if fewer than this many courts get a reading.
const MIN_COURTS_OK = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Reservations are booked on a 30-minute start-time grid (allowedReservationDurations
// start at 30 min; availableSlots land on :00/:30).
const GRID_MIN = 30;

// The reservable sports we surface. rec.us is used in SF for tennis + pickleball
// court bookings (its basketball reservations are sparse and the locations'
// coordinates are unreliable), so we scope to those two.
const RESERVABLE_SPORTS = ['tennis', 'pickleball'];

// rec.us sportId -> our sport id, built from /v1/sports (only the ones we track).
async function fetchSportMap() {
  const d = await getJson(`${API}/v1/sports`);
  const arr = Array.isArray(d) ? d : d.data || [];
  const map = {};
  for (const s of arr) {
    const our = String(s.name || '').toLowerCase();
    if (RESERVABLE_SPORTS.includes(our)) map[s.id] = our;
  }
  return map;
}

// Our sport ids a court is lined for (courtNumber is generic like "Court 3", so
// the sport lives in court.sports[].sportId).
function courtSports(court, sportMap) {
  const set = new Set();
  for (const sp of court.sports || []) {
    const our = sportMap[sp.sportId];
    if (our) set.add(our);
  }
  return [...set];
}

const feet = (aLat, aLng, bLat, bLng) => {
  const R = 20925524.9; // earth radius in feet
  const t = (x) => (x * Math.PI) / 180;
  const dLa = t(bLat - aLat), dLo = t(bLng - aLng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(aLat)) * Math.cos(t(bLat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// Bookable start times "HH:MM" on the 30-min grid that fit a min-length booking
// inside [openFrom, openTo).
function gridStarts(openFrom, openTo) {
  const toMin = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(3, 5), 10);
  const a = toMin(openFrom), b = toMin(openTo);
  const out = [];
  for (let m = a; m + GRID_MIN <= b; m += GRID_MIN) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
}

// rec.us datetimes are SF-local wall-clock. Read a Date's SF-local fields by
// reinterpreting it in America/Los_Angeles (works regardless of the build host tz).
const TZ = 'America/Los_Angeles';
const sfDate = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ }));
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The current 30-min slot key "YYYY-MM-DD HH:MM" in SF time; slots before it are past.
function nowSlotKey() {
  const n = sfDate();
  const hh = String(n.getHours()).padStart(2, '0');
  return `${ymd(n)} ${hh}:${n.getMinutes() < 30 ? '00' : '30'}`;
}

// The next WINDOW_DAYS calendar days starting today (SF), as { date 'YYYY-MM-DD', dow }.
function windowDays() {
  const out = [];
  const base = sfDate();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push({ date: ymd(d), dow: d.getDay() });
  }
  return out;
}

// Per-court bookable 30-min starts over the window, as { key 'YYYY-MM-DD HH:MM', free }.
// Reservations are date-specific (not weekly), so we key by the actual date+time.
// Past slots (earlier today) are dropped — they can't be booked and would read as
// falsely "booked" since rec.us only lists future-free times in availableSlots.
function courtSlots(court, win, nowKey) {
  const free = new Set((court.availableSlots || []).map((s) => String(s).slice(0, 16)));
  const out = [];
  for (const { date, dow } of win) {
    for (const sl of court.slots || []) {
      if (sl.dayOfWeek !== dow) continue;
      for (const hhmm of gridStarts(sl.openFrom, sl.openTo)) {
        const key = `${date} ${hhmm}`;
        if (key < nowKey) continue; // already in the past
        out.push({ key, free: free.has(key) });
      }
    }
  }
  return out;
}

// Aggregate a location's courts into { sport: { total, reserved, courts, slots } }
// where slots maps "YYYY-MM-DD HH:MM" -> { total, booked } across the location's
// courts lined for that sport (so % booked at a given time = booked/total). A court
// lined for multiple sports counts toward each.
function locationBookedBySport(location, win, sportMap, nowKey) {
  const bySport = {};
  for (const court of location.courts || []) {
    const sports = courtSports(court, sportMap);
    if (!sports.length) continue;
    const slots = courtSlots(court, win, nowKey);
    if (!slots.length) continue;
    for (const sport of sports) {
      const acc = (bySport[sport] ||= { total: 0, reserved: 0, courts: 0, slots: {} });
      acc.courts += 1;
      for (const { key, free } of slots) {
        acc.total += 1;
        if (!free) acc.reserved += 1;
        const s = (acc.slots[key] ||= { total: 0, booked: 0 });
        s.total += 1;
        if (!free) s.booked += 1;
      }
    }
  }
  return bySport;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Our courts to attach readings to (those that offer a reservable sport).
function ourCourts() {
  const outdoor = require('../data/outdoor-courts.js').default;
  const offers = (c, s) => (c.dropins?.[s] || []).some((d) => d && d.length);
  return outdoor.map((c) => ({
    id: c.id,
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    sports: RESERVABLE_SPORTS.filter((s) => offers(c, s)),
  }));
}

async function fetchSfLocations() {
  const sf = [];
  let page = 1, total = Infinity;
  while ((page - 1) * 25 < total && page <= 80) {
    const d = await getJson(`${API}/v1/locations?page=${page}`);
    total = d.meta?.pg?.totalResults ?? 0;
    for (const l of d.data || []) {
      if (l.lat && l.lng && inSF(l) && !IS_TEST.test(l.name || '')) {
        sf.push({ id: l.id, name: l.name, lat: l.lat, lng: l.lng });
      }
    }
    if ((d.data || []).length < 25) break;
    page++;
    await sleep(120); // be polite
  }
  return sf;
}

async function main() {
  console.log('Fetching reservable court availability from rec.us…');
  const win = windowDays();
  const nowKey = nowSlotKey();
  const courts = ourCourts();

  let reservations;
  let source;
  try {
    const sportMap = await fetchSportMap();
    const sfLocations = await fetchSfLocations();
    console.log(`  scanned rec.us locations → ${sfLocations.length} inside SF`);

    // courtId -> { sport: { pct, courts } }
    const out = {};
    for (const loc of sfLocations) {
      let detail;
      try {
        detail = (await getJson(`${API}/v1/locations/${loc.id}`)).location;
      } catch (e) {
        console.log(`  ⚠ ${loc.name} — detail failed (${e.message})`);
        continue;
      }
      await sleep(120);
      const bySport = locationBookedBySport(detail, win, sportMap, nowKey);
      for (const [sport, agg] of Object.entries(bySport)) {
        // Attach to the nearest of our courts that offers this sport. If another
        // rec.us location already claimed that court+sport, keep the closer one
        // (parks like Lincoln Park can sit a few hundred ft from another court).
        let best = null, bestFt = Infinity;
        for (const c of courts) {
          if (!c.sports.includes(sport)) continue;
          const ft = feet(loc.lat, loc.lng, c.lat, c.lng);
          if (ft < bestFt) { bestFt = ft; best = c; }
        }
        if (!best || bestFt > MATCH_MAX_FEET) continue;
        const prev = out[best.id]?.[sport];
        if (prev && prev._ft <= bestFt) continue;
        const pct = Math.round((agg.reserved / agg.total) * 100);
        // Per-slot booked% (dow-minute -> pct), for the planner's time-specific badge.
        const slots = {};
        for (const [key, s] of Object.entries(agg.slots)) {
          slots[key] = Math.round((s.booked / s.total) * 100);
        }
        (out[best.id] ||= {})[sport] = {
          pct, courts: agg.courts, slots,
          url: `https://www.rec.us/locations/${loc.id}`,
          _ft: Math.round(bestFt), _from: loc.name,
        };
        console.log(`  ✓ ${loc.name} ${sport} → ${pct}% booked → ${best.name}`);
      }
    }

    // Drop match-bookkeeping fields; count final readings.
    let readings = 0;
    for (const courtId of Object.keys(out)) {
      for (const sport of Object.keys(out[courtId])) {
        delete out[courtId][sport]._ft;
        delete out[courtId][sport]._from;
        readings++;
      }
    }
    if (readings < MIN_COURTS_OK) {
      throw new Error(`only ${readings} readings (min ${MIN_COURTS_OK}) — rec.us shape may have changed`);
    }
    reservations = out;
    source = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ reservations, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.reservations) {
      throw new Error(`fetch failed (${e.message}) and no cache — data/reservations.js left unchanged`);
    }
    reservations = cache.reservations;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  const generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, render(reservations, generatedAt, win.length));
  const n = Object.keys(reservations).length;
  console.log(`\n✅ Wrote ${n} courts to data/reservations.js (${source})`);
}

function render(reservations, generatedAt, windowDays) {
  const ids = Object.keys(reservations).sort();
  const body = ids
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(reservations[id])},`)
    .join('\n');
  return `// AUTO-GENERATED by scripts/build-reservations.js — do not edit by hand.
// Regenerate with: npm run build:reservations
// Generated: ${generatedAt}
//
// How booked-out each reservable outdoor court is, from rec.us (SF Rec & Park's
// reservation platform). Map of our court id -> { sport: { pct, courts, slots, url } }:
//   pct    share of bookable slots reserved over the next ${windowDays} days (window average)
//   courts number of reservable sub-courts at the location
//   slots  point-in-time booked%, keyed "YYYY-MM-DD HH:MM" SF-local (e.g. "2026-06-28 09:00").
//          The app looks up the current slot for a live "% booked right now" reading; covers
//          today onward, so it goes stale after the window (refresh weekly via the cron).
//   url    the rec.us reservation page for this location (where users book)
// Merged onto courts at runtime by lib/useCourts.js: shown as a badge on the court
// detail card (overall pct) and next to each court when planning a game (slot pct).
// A snapshot — refresh by re-running the build.

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const RESERVATIONS = {
${body}
};

export default RESERVATIONS;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
