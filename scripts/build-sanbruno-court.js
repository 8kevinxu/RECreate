#!/usr/bin/env node
/*
 * Build data/sanbruno-court.js — the San Bruno Recreation & Aquatic Center (RAC)
 * indoor gym. Run with:  npm run build:sanbruno
 *
 * Unlike the SF centers (sfrecpark.org), San Bruno publishes its drop-in gym
 * schedule as a public Google Sheet. This script pulls that sheet's CSV export
 * each run and parses the weekly two-side gym grid into the same court schema as
 * data/courts.js, so the runtime can merge it in alongside the SF courts.
 *
 * Sources:
 *   1. Static identity (name, address, coords, facility hours, notes) — the
 *      SAN_BRUNO constant below. These rarely change.
 *   2. Drop-in basketball blocks — scraped each run from the "Gymnasium Schedule"
 *      Google Sheet linked from sanbruno.ca.gov/1128.
 *
 * Resilience mirrors the SF build: live parse -> last-good cache (sanbruno-cache
 * .json). A validation gate aborts (keeping the existing data file) if too few
 * days parse a basketball block, so a sheet-layout change can't silently publish
 * an empty schedule.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');

const CACHE_FILE = path.join(__dirname, 'sanbruno-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'sanbruno-court.js');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// "Gymnasium Schedule" tab of the city's public gym-hours sheet (linked from
// https://www.sanbruno.ca.gov/1128/Pool-Gym-Fitness-Room-Hours).
const SHEET_ID = '1r0i1RARMkL-S8L4N4RTyixcHALDnr9lcLCIIJVbp9Qc';
const SHEET_GID = '812342050';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// Abort (keep last-good data) if fewer than this many weekdays parse a block.
const MIN_DAYS_OK = 5;

const time = (h, m = 0) => h * 60 + m;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Drop-in sports pulled from the gym grid (matched against each block's label).
// Keep in sync with lib/sports.js. The build gates on basketball (below).
const SPORTS = [
  { id: 'basketball', match: /basketball/i },
  { id: 'volleyball', match: /volleyball/i },
  { id: 'pingpong', match: /table tennis|ping[\s-]?pong/i },
  { id: 'pickleball', match: /pickleball/i },
];
const emptyWeek = () => [[], [], [], [], [], [], []];

// Static identity + facility hours (from sanbruno.ca.gov; not in the gym sheet).
// schedule[] indexed 0=Sun..6=Sat: Mon–Fri 6a–9p, Sat 8a–8p, Sun 12p–5p.
const SAN_BRUNO = {
  id: 'san-bruno-rac',
  city: 'sf', // greater-SF metro (the app's SF city view includes San Bruno)
  name: 'Recreation & Aquatic Center (RAC)',
  address: '251 City Park Way',
  neighborhood: 'San Bruno',
  lat: 37.6167,
  lng: -122.4138,
  indoor: true,
  hoops: 2,
  lights: true,
  schedule: [
    [time(12), time(17)], // Sun
    [time(6), time(21)], // Mon
    [time(6), time(21)], // Tue
    [time(6), time(21)], // Wed
    [time(6), time(21)], // Thu
    [time(6), time(21)], // Fri
    [time(8), time(20)], // Sat
  ],
  source: 'sanbruno',
  notes:
    'Two-side gymnasium; drop-in basketball shares the gym with volleyball, pickleball, and rentals, so open-gym blocks shift through the day. Sunday drop-in is youth only (17 & under).',
  disclaimer:
    'Gym schedule changes weekly — verify at sanbruno.ca.gov or call (650) 616-7058.',
};

// Minimal RFC-4180-ish CSV parser: handles quoted fields with embedded commas,
// newlines, and "" escapes. Returns an array of rows (arrays of cell strings).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

const TIME_RANGE = /(\d{1,2}):(\d{2})\s*([AP])M\s*[-–]\s*(\d{1,2}):(\d{2})\s*([AP])M/i;
function toMin(h, m, ap) {
  h = Number(h) % 12;
  if (ap.toUpperCase() === 'P') h += 12;
  return h * 60 + Number(m);
}

// Walk one column top-to-bottom, pairing each activity-name cell with the
// time-range cell that follows it. Returns [{ name, start, end }].
function blocksInColumn(rows, col, startRow) {
  const blocks = [];
  let lastName = '';
  for (let r = startRow; r < rows.length; r++) {
    const cell = clean(rows[r][col]);
    if (!cell) continue;
    const m = cell.match(TIME_RANGE);
    if (m) {
      blocks.push({ name: lastName, start: toMin(m[1], m[2], m[3]), end: toMin(m[4], m[5], m[6]) });
    } else if (!cell.startsWith('*')) {
      lastName = cell; // activity label (Basketball / Volleyball / Rental / …)
    }
  }
  return blocks;
}

// Merge overlapping/touching blocks within a day into [startMin, endMin] pairs.
function mergeBlocks(list) {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of sorted) {
    const prev = out[out.length - 1];
    if (prev && b.start <= prev[1]) prev[1] = Math.max(prev[1], b.end);
    else out.push([b.start, b.end]);
  }
  return out;
}

function parseSchedule(csv) {
  const rows = parseCSV(csv);

  // Locate the weekday header row, then each day's column.
  let headerRow = -1;
  for (let r = 0; r < rows.length && headerRow < 0; r++) {
    if (rows[r].some((c) => /monday/i.test(c))) headerRow = r;
  }
  if (headerRow < 0) throw new Error('weekday header row not found');

  const dropins = Object.fromEntries(SPORTS.map((s) => [s.id, emptyWeek()]));
  let bballDays = 0;

  for (let d = 0; d < 7; d++) {
    const col = rows[headerRow].findIndex((c) => new RegExp(DAY_NAMES[d], 'i').test(c));
    if (col < 0) continue;
    // A day spans two gym halves: Side 1 at `col`, Side 2 three columns right.
    const found = [
      ...blocksInColumn(rows, col, headerRow + 1),
      ...blocksInColumn(rows, col + 3, headerRow + 1),
    ];
    for (const s of SPORTS) {
      // Setup/teardown rows ("Volleyball Setup") aren't play time — drop them.
      const blocks = found.filter((b) => s.match.test(b.name) && !/setup/i.test(b.name));
      dropins[s.id][d] = mergeBlocks(blocks);
    }
    if (dropins.basketball[d].length) bballDays++;
  }

  // Gate on basketball (broad coverage); volleyball is legitimately sparse.
  if (bballDays < MIN_DAYS_OK) {
    throw new Error(
      `only ${bballDays}/7 days parsed a basketball block (min ${MIN_DAYS_OK}) — sheet layout may have changed`
    );
  }
  return dropins;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function render(court, generatedAt, scheduleSource) {
  return `// AUTO-GENERATED by scripts/build-sanbruno-court.js — do not edit by hand.
// Regenerate with: npm run build:sanbruno
// Generated: ${generatedAt}
//
// San Bruno Recreation & Aquatic Center (RAC) indoor gym. Identity + facility
// hours are curated in the build script; drop-in basketball times are pulled
// from the city's public "Gymnasium Schedule" Google Sheet each run.
//
// schedule[]   = FACILITY hours, indexed 0=Sun..6=Sat; [openMin,closeMin] or null.
// dropins      = { sportId: week } drop-in OPEN-GYM blocks per sport (basketball,
//   volleyball); each week is indexed 0=Sun..6=Sat and each day is an array of
//   [startMin,closeMin] blocks (empty when none that day).
// scheduleSource = "live" (parsed this run) | "cache" (last good).

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const SANBRUNO_COURTS = [
  {
    id: ${JSON.stringify(court.id)},
    city: "sf",
    name: ${JSON.stringify(court.name)},
    address: ${JSON.stringify(court.address)},
    neighborhood: ${JSON.stringify(court.neighborhood)},
    lat: ${court.lat},
    lng: ${court.lng},
    indoor: true,
    hoops: ${court.hoops},
    lights: true,
    schedule: ${JSON.stringify(court.schedule)},
    dropins: ${JSON.stringify(court.dropins)},
    scheduleSource: ${JSON.stringify(scheduleSource)},
    source: "sanbruno",
    notes: ${JSON.stringify(court.notes)},
    disclaimer: ${JSON.stringify(court.disclaimer)},
  },
];

export default SANBRUNO_COURTS;
`;
}

async function main() {
  console.log('Fetching San Bruno gym schedule from Google Sheets…');
  let dropins;
  let scheduleSource;

  try {
    const res = await fetchT(CSV_URL, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    dropins = parseSchedule(csv);
    scheduleSource = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ dropins, scrapedAt: new Date().toISOString() }, null, 2) + '\n');
    const counts = SPORTS.map((s) => `${dropins[s.id].reduce((n, d) => n + d.length, 0)} ${s.id}`);
    console.log(`  ✓ parsed ${counts.join(', ')} blocks across the week (live)`);
  } catch (e) {
    const cache = loadCache();
    // Old caches stored a bare `basketball` week; wrap it into the dropins shape.
    const cached = cache && (cache.dropins ||
      (cache.basketball && {
        ...Object.fromEntries(SPORTS.map((s) => [s.id, emptyWeek()])),
        basketball: cache.basketball,
      }));
    if (!cached) {
      throw new Error(`parse failed (${e.message}) and no cache available — data/sanbruno-court.js left unchanged`);
    }
    dropins = cached;
    scheduleSource = 'cache';
    console.log(`  ↺ parse failed (${e.message}); using last-good cache from ${cache.scrapedAt || 'unknown'}`);
  }

  const court = { ...SAN_BRUNO, dropins };
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, render(court, generatedAt, scheduleSource));
  console.log(`\n✅ Wrote data/sanbruno-court.js (${scheduleSource})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
