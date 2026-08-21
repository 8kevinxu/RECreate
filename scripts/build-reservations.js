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
const { fetchT } = require('./fetch-timeout');

const API = 'https://api.rec.us';
const CACHE_FILE = path.join(__dirname, 'reservations-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'reservations.js');
const JSON_FILE = path.join(__dirname, '..', 'data', 'reservations.json');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': BROWSER_UA, Origin: 'https://www.rec.us', Accept: 'application/json' };
// The /schedule endpoint sits behind a WAF that 403s the two-header request the rest
// of the API accepts — it wants a full browser header set (sec-ch-ua / sec-fetch-*).
const PAGE_HEADERS = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.rec.us/',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
};

// SF Rec & Park's rec.us organization — the identity the venue list is selected
// by. Confirmed via /v1/organizations/<id>, which returns slug
// "san-francisco-rec-park". Every list row carries organizationId, so this costs
// no extra request.
//
// This REPLACED a bounding box plus a name regex for test facilities, and the
// swap is the point: rec.us runs a demo org whose locations are geocoded inside
// SF and NAMED AFTER REAL PARKS ("Lincoln Park", "Balboa Parkette", one of whose
// courts is called "SortaLooksLikeSlots POC"). A name regex cannot see those, and
// a bounding box actively lets them in — "Lincoln Park" sits 470 ft from Rossi
// Playground, close enough for the proximity matcher to hand it Rossi's pin. It
// did exactly that: Rossi shipped a POC fixture's availability, that org's
// booking guidelines, and a reserve link to the wrong venue. An exact org match
// cannot be fooled by a name or a coordinate.
const SFRP_ORG = '17380e28-7e02-4b52-82c5-fab18557fd7a';

// SF bounding box — no longer how venues are chosen, only a tripwire. Every SFRP
// location is inside it today, so one outside means the org's footprint changed
// and someone should look, rather than it being silently dropped.
const SF_BBOX = { minLat: 37.70, maxLat: 37.83, minLng: -122.52, maxLng: -122.35 };
const inSF = (l) => l.lat > SF_BBOX.minLat && l.lat < SF_BBOX.maxLat &&
  l.lng > SF_BBOX.minLng && l.lng < SF_BBOX.maxLng;

// How far ahead to measure occupancy, and how close a rec.us location must be to
// one of our courts (parks are big, so the centroid can be a few hundred ft off).
const WINDOW_DAYS = 7;
const MATCH_MAX_FEET = 1320;

// Abort (keep last-good data) if fewer than this many court+sport readings land.
// SFRP publishes ~37 (27 tennis + 10 pickleball). The old floor of 10 was set to
// catch a total scrape failure and so never fired while a paging bug quietly ate
// 12 of them over two weeks — a gate you can lose a third of your data through is
// not a gate. Still loose enough for a genuine closure or two.
const MIN_COURTS_OK = 28;

// …and abort on a sharp drop from the last good run even when the absolute floor
// holds. Erosion is the failure mode this source actually has: venues disappear a
// few at a time, each step small enough to look like noise.
const MAX_DROP_PCT = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetchT(url, { headers: HEADERS });
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
const pad2 = (n) => String(n).padStart(2, '0');
const sfDate = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ }));
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const keyOf = (d) => `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
// The current 30-min slot key "YYYY-MM-DD HH:MM" in SF time; slots before it are past.
function nowSlotKey() {
  const n = sfDate();
  return `${ymd(n)} ${pad2(n.getHours())}:${n.getMinutes() < 30 ? '00' : '30'}`;
}

// --- rec.us's own per-court day schedule -----------------------------------
// `availableSlots` says only "you can't book this", which conflates two very different
// things. The /schedule endpoint (what the site's Calendar tab renders) separates them:
//
//   RESERVATION + referenceId  → a real booking ON THIS COURT      ("Reserved")
//   RESERVATION, no referenceId → an OVERLAPPING court is booked    ("Unavailable")
//   RESERVABLE                  → free and bookable                 ("Reservable")
//   OPEN (label "Not Reservable")→ outside booking hours, or a walk-up-only court
//                                  — i.e. drop-in play, not a closure
//
// Courts share physical space: Buena Vista's tennis Court 1 IS pickleball Courts A–D
// (see each court's `overlaps`), so one tennis booking marks all four pickleball courts
// Unavailable with nobody having reserved them. Without this endpoint that reads as
// "4 of 4 courts reserved". One request covers the whole window via endDate.
const SPAN_STATE = { RESERVABLE: 'bookable', OPEN: 'dropin' };
const stateOf = (info) =>
  info.referenceType === 'RESERVATION'
    ? info.referenceId
      ? 'reserved' // booked on this court
      : 'blocked' // an overlapping court is booked
    : SPAN_STATE[info.referenceType] || 'dropin';

// 'YYYY-MM-DD' -> courtNumber -> [{ from 'HH:MM', to 'HH:MM', state }].
async function fetchSchedule(locId, win) {
  const url = `${API}/v1/locations/${locId}/schedule?startDate=${win[0].date}&endDate=${win[win.length - 1].date}`;
  const res = await fetchT(url, { headers: PAGE_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for schedule`);
  const d = await res.json();
  const out = {};
  for (const [key, courts] of Object.entries(d.dates || {})) {
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    const byCourt = (out[date] = {});
    for (const c of courts || []) {
      byCourt[c.courtNumber] = Object.entries(c.schedule || {}).map(([span, info]) => {
        const [from, to] = span.split(',').map((s) => s.trim().slice(0, 5));
        return { from, to, state: stateOf(info) };
      });
    }
  }
  return out;
}

// The state of one court at one "HH:MM", or null when the schedule doesn't cover it.
const stateAt = (spans, hhmm) => (spans || []).find((s) => s.from <= hhmm && hhmm < s.to)?.state || null;

// The other sport sharing this court's physical space, if any — the one whose booking
// turns this court "Unavailable". `overlaps` names the courts only, so resolve each
// back to a sibling court record to read its sport.
function overlapSportOf(court, location, sportMap, ownSport) {
  for (const o of court.overlaps || []) {
    const sib = (location.courts || []).find((c) => c.courtNumber === o.courtNumber);
    for (const s of courtSports(sib || {}, sportMap)) if (s !== ownSport) return s;
  }
  return null;
}

// rec.us per-location booking guidelines (markdown). Keep only real content (some
// locations have a placeholder like "TBD"); collapse excess blank lines.
function cleanGuide(s) {
  if (!s) return null;
  const t = String(s).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t.length < 30 || /^tbd\.?$/i.test(t) ? null : t;
}

// How far ahead a court takes bookings, in hours. rec.us releases slots only within
// this window, so a date beyond it shows zero availability NOT because it's booked
// but because it isn't open for reservation yet — those slots must be excluded.
function courtWindowHours(court, locDefaultDays) {
  const w = court.reservationWindows?.[0]?.maxHours;
  if (Number.isFinite(w)) return w;
  if (Number.isFinite(court.defaultReservationWindowDays)) return court.defaultReservationWindowDays * 24;
  if (Number.isFinite(locDefaultDays)) return locDefaultDays * 24;
  return WINDOW_DAYS * 24;
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

// Per-court bookable 30-min starts the court is OPEN for over the window, as
// { key 'YYYY-MM-DD HH:MM', free, released }. Reservations are date-specific, so we
// key by the actual date+time. Earlier-today slots are dropped (can't be booked).
// `released` = the slot is within this court's reservation window (so its absence
// from availableSlots means "booked"); when false the slot is open per the court's
// hours but not yet released for booking, so it isn't booked — just not bookable yet.
function courtSlots(court, win, nowKey, horizonKey, sched) {
  const free = new Set((court.availableSlots || []).map((s) => String(s).slice(0, 16)));
  const out = [];
  for (const { date, dow } of win) {
    for (const sl of court.slots || []) {
      if (sl.dayOfWeek !== dow) continue;
      for (const hhmm of gridStarts(sl.openFrom, sl.openTo)) {
        const key = `${date} ${hhmm}`;
        if (key < nowKey) continue; // already in the past
        // rec.us's own label for the slot when we have it; `free` is the availableSlots
        // fallback for when the schedule fetch failed (it can't see blocked-vs-booked).
        const state = sched ? stateAt(sched[date]?.[court.courtNumber], hhmm) : null;
        out.push({ key, free: free.has(key), released: key <= horizonKey, state });
      }
    }
  }
  return out;
}

// Aggregate a location's courts into { sport: { reserved, total, courts, slots, windows } }.
// slots maps "YYYY-MM-DD HH:MM" -> { open, rel, booked }, counting the location's courts
// lined for that sport that are OPEN at that time (open), of those how many are released
// for booking (rel), and how many of the released are reserved (booked). So booked% =
// booked/rel among bookable courts, and "rel of open courts are open for booking". A court
// lined for multiple sports counts toward each.
function locationBookedBySport(location, win, sportMap, nowKey, now, sched) {
  const bySport = {};
  const locDefaultDays = location.defaultReservationWindow;
  for (const court of location.courts || []) {
    const sports = courtSports(court, sportMap);
    if (!sports.length) continue;
    const hours = courtWindowHours(court, locDefaultDays);
    const horizonKey = keyOf(new Date(now.getTime() + hours * 3600 * 1000));
    const slots = courtSlots(court, win, nowKey, horizonKey, sched);
    if (!slots.length) continue;
    for (const sport of sports) {
      const acc = (bySport[sport] ||= {
        total: 0, reserved: 0, courts: 0, slots: {}, windows: new Set(), overlapSport: null,
      });
      acc.courts += 1;
      acc.windows.add(hours);
      acc.overlapSport ||= overlapSportOf(court, location, sportMap, sport);
      for (const { key, free, released, state } of slots) {
        const s = (acc.slots[key] ||= { open: 0, rel: 0, booked: 0, res: 0, blk: 0 });
        s.open += 1;
        // Reserved vs. blocked-by-an-overlapping-booking, straight from rec.us. Both
        // make the court unplayable; only the first is someone reserving THIS sport.
        if (state === 'reserved') s.res += 1;
        else if (state === 'blocked') s.blk += 1;
        else if (state == null && !free && released) s.res += 1; // no schedule: assume booked
        if (released) {
          s.rel += 1;
          acc.total += 1;
          if (!free) {
            s.booked += 1;
            acc.reserved += 1;
          }
        }
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

const PAGE_SIZE = 25;
const HARD_PAGE_CAP = 400; // only to stop a runaway loop if the API misreports

// Every SF Rec & Park venue on rec.us. The list endpoint ignores org filter
// params (?organizationId= still returns all ~3k), so we page the whole thing and
// filter client-side on organizationId.
//
// Page to the END of the list, computed from totalResults. It used to stop at a
// hardcoded 80 pages = 2000 locations, which was comfortably past the ~1.6k the
// list held when this was written. The list is alphabetical and now holds 3004,
// so the cap became a silent alphabetical cutoff that walked backwards through
// the SFRP venues as rec.us grew: everything after "Parkside Square" — Potrero
// Hill, Presidio Wall, Richmond, Rossi, Stern Grove, St. Mary's, Sunset, Upper
// Noe — stopped being scraped between Aug 5 and Aug 17 2026, taking 12 readings
// with them. Never bound this by a page number.
async function fetchSfLocations() {
  const sf = [];
  const outside = [];
  let page = 1, total = Infinity, scanned = 0;
  while ((page - 1) * PAGE_SIZE < total && page <= HARD_PAGE_CAP) {
    const d = await getJson(`${API}/v1/locations?page=${page}`);
    total = d.meta?.pg?.totalResults ?? 0;
    const rows = d.data || [];
    scanned += rows.length;
    for (const l of rows) {
      if (l.organizationId !== SFRP_ORG || l.archivedAt) continue;
      if (!l.lat || !l.lng) continue;
      const loc = { id: l.id, name: l.name, lat: Number(l.lat), lng: Number(l.lng) };
      (inSF(loc) ? sf : outside).push(loc);
    }
    if (rows.length < PAGE_SIZE) break;
    page++;
    await sleep(120); // be polite
  }
  const pages = Math.ceil(total / PAGE_SIZE);
  if (page < pages) console.log(`  ⚠ stopped at page ${page} of ${pages} (hard cap) — some venues unscanned`);
  // Tripwire, not a filter: keep them, but say so.
  for (const l of outside) {
    console.log(`  ⚠ ${l.name} is SFRP but outside the SF bounding box (${l.lat}, ${l.lng}) — keeping it`);
    sf.push(l);
  }
  console.log(`  scanned ${scanned} of ${total} rec.us locations across ${page} pages`);
  return sf;
}

async function main() {
  console.log('Fetching reservable court availability from rec.us…');
  const win = windowDays();
  const now = sfDate();
  const nowKey = nowSlotKey();
  const courts = ourCourts();

  let reservations;
  let source;
  try {
    const sportMap = await fetchSportMap();
    const sfLocations = await fetchSfLocations();
    console.log(`  → ${sfLocations.length} SF Rec & Park venues`);
    const unmatched = [];

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
      // Best-effort: without it we fall back to the availableSlots reading, which
      // can't tell a booking from an overlap block.
      let sched = null;
      try {
        sched = await fetchSchedule(loc.id, win);
      } catch (e) {
        console.log(`  ⚠ ${loc.name} — schedule failed (${e.message}), using availableSlots only`);
      }
      await sleep(120);
      const bySport = locationBookedBySport(detail, win, sportMap, nowKey, now, sched);
      // An SFRP venue whose reading lands nowhere is a gap in OUR court data, not
      // a rec.us problem — McLaren has 6 tennis courts and no pin within
      // MATCH_MAX_FEET of it. Silent before; say it so the gap is fixable.
      let landed = false;
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
        landed = true;
        const prev = out[best.id]?.[sport];
        if (prev && prev._ft <= bestFt) continue;
        const pct = agg.total ? Math.round((agg.reserved / agg.total) * 100) : 0;
        // Per-slot booked% (datetime key -> pct), among the courts bookable at that
        // time. `open` and `released` are sparse counts: `open` = courts open at that
        // hour (when fewer than the location total), `released` = of those, how many
        // are open for booking now (when fewer than open). Together → "X of Y courts
        // open for booking" with Y reflecting only courts actually open at that hour.
        const slots = {};
        const open = {};
        const released = {};
        const blk = {};
        for (const [key, s] of Object.entries(agg.slots)) {
          if (s.rel === 0) continue; // nothing bookable at this time → no % to show
          slots[key] = s.res; // v2: courts of this sport actually reserved
          if (s.blk) blk[key] = s.blk; // … and courts blocked by an overlapping booking
          if (s.open < agg.courts) open[key] = s.open;
          if (s.rel < s.open) released[key] = s.rel;
        }
        // Distinct reservation-window lengths (hours) among this location's courts;
        // only when they differ, so the app can say when the later-window courts open.
        const windows = [...agg.windows].sort((a, b) => a - b);
        (out[best.id] ||= {})[sport] = {
          // v marks the slot-value contract: v2 slots are RESERVED COURT COUNTS, older
          // payloads (a stale cache) hold a booked-% — lib/reservations.js reads both.
          v: 2,
          pct, courts: agg.courts, slots,
          ...(Object.keys(blk).length ? { blk } : {}),
          ...(agg.overlapSport && Object.keys(blk).length ? { overlapSport: agg.overlapSport } : {}),
          ...(Object.keys(open).length ? { open } : {}),
          ...(Object.keys(released).length ? { released } : {}),
          ...(windows.length > 1 ? { windows } : {}),
          url: `https://www.rec.us/locations/${loc.id}`,
          _ft: Math.round(bestFt), _from: loc.name,
        };
        // The location's own booking guidelines (markdown), shared by all its sports.
        // Use the same closest-wins rule as the data so a nearby different park (e.g.
        // Lincoln Park sitting ~570ft from Rossi) can't leak its guidelines in.
        const guide = cleanGuide(detail.playGuidelines);
        if (guide && (out[best.id]._guideFt == null || bestFt < out[best.id]._guideFt)) {
          out[best.id].guidelines = guide;
          out[best.id]._guideFt = bestFt;
        }
        console.log(`  ✓ ${loc.name} ${sport} → ${pct}% booked → ${best.name}`);
      }
      if (!landed && Object.keys(bySport).length) {
        unmatched.push(loc.name);
      }
    }
    if (unmatched.length) {
      console.log(`  ⚠ no court within ${MATCH_MAX_FEET}ft for: ${unmatched.join(', ')}`);
    }

    // Drop match-bookkeeping fields; count final readings (skip the court-level
    // `guidelines` string, which sits alongside the per-sport objects).
    let readings = 0;
    for (const courtId of Object.keys(out)) {
      delete out[courtId]._guideFt; // closest-match bookkeeping for guidelines
      for (const sport of Object.keys(out[courtId])) {
        if (sport === 'guidelines') continue;
        delete out[courtId][sport]._ft;
        delete out[courtId][sport]._from;
        readings++;
      }
    }
    if (readings < MIN_COURTS_OK) {
      throw new Error(`only ${readings} readings (min ${MIN_COURTS_OK}) — rec.us shape may have changed`);
    }
    // Relative gate: the absolute floor can't see erosion that starts from a
    // healthy number. Counted against the last good run, so a few venues going
    // missing fails the build instead of quietly shipping.
    const prev = loadCache();
    const prevReadings = prev?.reservations
      ? Object.values(prev.reservations).reduce(
          (n, sports) => n + Object.keys(sports).filter((k) => k !== 'guidelines').length,
          0
        )
      : 0;
    if (prevReadings && readings < prevReadings * (1 - MAX_DROP_PCT / 100)) {
      throw new Error(
        `${readings} readings, down from ${prevReadings} last run (>${MAX_DROP_PCT}% drop) — venues are going missing`
      );
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

  // Bundled module (offline fallback baked into the app).
  fs.writeFileSync(OUT_FILE, render(reservations, generatedAt, win.length));

  // Hostable JSON the app re-fetches at launch (EXPO_PUBLIC_RESERVATIONS_URL),
  // mirroring data/courts.json. This one matters more than the courts payload:
  // slots are keyed to ABSOLUTE dates on a rolling window, so a snapshot
  // compiled into a build stops resolving WINDOW_DAYS later and the app
  // goes from "correct" to "no reading at all". Refetching is what keeps an
  // installed app showing today's occupancy between store releases.
  // Written compact: it's fetched on every launch and pretty-printing the slot
  // maps multiplies the transfer for nothing.
  fs.writeFileSync(
    JSON_FILE,
    JSON.stringify({ generatedAt, windowDays: win.length, reservations }) + '\n'
  );

  const n = Object.keys(reservations).length;
  console.log(
    `\n✅ Wrote ${n} courts to data/reservations.js + data/reservations.json (${source})`
  );
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
// reservation platform). Map of court id -> { sport: { v, pct, courts, slots, blk?, … } }:
//   v        slot-value contract version; 2 = \`slots\` holds reserved COURT COUNTS
//   pct      share of bookable slots reserved over the next ${windowDays} days (window average)
//   courts   number of reservable sub-courts at the location
//   slots    courts RESERVED at that moment, keyed "YYYY-MM-DD HH:MM" SF-local (e.g.
//            "2026-06-28 09:00") — real bookings on this sport's courts. Covers today
//            onward, so it goes stale after the window (refresh weekly via the cron).
//   blk      sparse map (same keys) of courts UNAVAILABLE because an overlapping court
//            is booked — courts share physical space (Buena Vista's tennis Court 1 is
//            pickleball Courts A–D), so one booking blocks the rest without reserving
//            them. Unplayable like a reservation, but nobody booked this sport.
//   overlapSport  the sport whose bookings block this one (present only alongside blk)
//   open     sparse map (same keys) of how many courts are OPEN at that hour, present only
//            when fewer than the location total (some courts have shorter hours / fewer days).
//   released sparse map (same keys) of how many of the open courts are open for booking now,
//            present only when fewer than open (shorter reservation windows release fewer on
//            far-out dates) -> "X of Y courts open for booking" (Y = courts open at that hour).
//   windows  distinct reservation-window lengths (hours) among the courts, present only
//            when they differ (e.g. [48, 168]); lets the app compute when the later-window
//            courts open for booking -> "N more open ~7/2".
//   url      the rec.us reservation page for this location (where users book)
// Plus a court-level guidelines string (markdown) — the location's own booking rules
// (per-court windows/durations, policies, features), shown in the card's "How booking
// works" section. Merged onto courts at runtime by lib/useCourts.js: shown as a badge on the court
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
