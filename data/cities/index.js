// Hand-written aggregator for the per-city generated court data (Metro needs
// static imports, so each city is one explicit line here + its entry in
// lib/cities.js + a scripts/cities/<id>.js scraper config).
//
// City files are COMPACT — each record lists its offered `sports` instead of
// carrying the app's uniform { schedule, dropins } shape (at ~700 pins per city
// the empty weeks would triple the bundled size). This module expands them at
// import: offered sports span the daily park-hours window, all other tracked
// sports get an empty week, matching data/outdoor-courts.js records exactly.

import { SPORTS, WEIGHT_ROOM } from '../../lib/sports';
import NYC, { CITY as NYC_CITY, PARK_HOURS as NYC_HOURS, SOURCE as NYC_SOURCE, DISCLAIMER as NYC_DISCLAIMER } from './nyc/outdoor-courts';
import NYC_INDOOR from './nyc/indoor-courts';
import NYC_CLASSES from './nyc/classes';
import NYC_RES, {
  ORIGIN as NYC_RES_ORIGIN,
  WINDOW as NYC_RES_WINDOW,
  GENERATED_AT as NYC_RES_AT,
} from './nyc/reservations';

const SPORT_KEYS = [...SPORTS.map((s) => s.id), WEIGHT_ROOM];

function expandCity(courts, city, parkHours, source, disclaimer) {
  const schedule = Array.from({ length: 7 }, () => [...parkHours]);
  return courts.map((c) => {
    const dropins = {};
    for (const k of SPORT_KEYS) {
      dropins[k] = c.sports.includes(k)
        ? schedule.map((h) => [[h[0], h[1]]])
        : [[], [], [], [], [], [], []];
    }
    const { sports, ...rest } = c;
    return { ...rest, city, indoor: false, schedule, dropins, source, disclaimer };
  });
}

// city id -> expanded court list, merged into the app's court list by
// lib/useCourts.js (deduped by id there; city ids are prefixed so they can
// never collide with SF's bare slugs).
export const CITY_COURTS = {
  // Indoor rec centers carry full records (real per-sport schedules); outdoor
  // pins are compact and expanded here.
  [NYC_CITY]: [...NYC_INDOOR, ...expandCity(NYC, NYC_CITY, NYC_HOURS, NYC_SOURCE, NYC_DISCLAIMER)],
};

// --- Occupancy -------------------------------------------------------------
// scripts/build-nyc-reservations.js ships occupancy RUN-LENGTH ENCODED
// ([[startIdx, endIdx, courtsTaken]] on a 30-minute grid from ORIGIN) because
// the raw slot map is 37.8k keys / 921 KB of bundled JS and permits are
// contiguous by nature — the runs are 5.2k / 143 KB. Expand here so everything
// downstream sees exactly the `reserved` shape lib/reservations.js already
// reads for SF, and no render path has to know the difference.

const pad2 = (n) => String(n).padStart(2, '0');

// Slot keys are NYC wall clock. Do the arithmetic in UTC on the literal fields
// so it can't shift across a DST boundary or vary by device timezone — the
// exact inverse of `wallMs` in scripts/build-nyc-reservations.js.
const wallMs = (k) =>
  Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), +k.slice(11, 13), +k.slice(14, 16));
const wallKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}`;
};

function expandRuns(runs, originMs) {
  const out = {};
  for (const [a, b, n] of runs || []) {
    for (let i = a; i <= b; i++) out[wallKey(originMs + i * 1800000)] = n;
  }
  return out;
}

function expandReservations(raw, origin, window, generatedAt) {
  const originMs = wallMs(origin);
  const out = {};
  for (const [courtId, bySport] of Object.entries(raw || {})) {
    const entry = {};
    for (const [sport, e] of Object.entries(bySport)) {
      const { runs, openRuns, ...rest } = e;
      entry[sport] = {
        ...rest,
        slots: expandRuns(runs, originMs),
        ...(openRuns ? { open: expandRuns(openRuns, originMs) } : {}),
        // Permit coverage is sparse: a gap inside the swept window means nobody
        // holds that time, not "unknown". Carrying the window lets
        // lib/reservations.js tell those two apart.
        ...(e.kind === 'permit' ? { window } : {}),
        generatedAt,
      };
    }
    out[courtId] = entry;
  }
  return out;
}

// city id -> court id -> { sport: reservation entry }, merged onto courts by
// lib/useCourts.js exactly like SF's data/reservations.js.
export const CITY_RESERVATIONS = {
  [NYC_CITY]: expandReservations(NYC_RES, NYC_RES_ORIGIN, NYC_RES_WINDOW, NYC_RES_AT),
};

// city id -> class/program list (same record shape as data/classes.js). SF's
// ActiveNet catalog stays in data/classes.js; cities without one are absent.
export const CITY_CLASSES = {
  [NYC_CITY]: NYC_CLASSES,
};

export default CITY_COURTS;
