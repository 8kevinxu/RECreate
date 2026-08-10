#!/usr/bin/env node
/*
 * Build data/cities/nyc/directory.js — the qualitative facility facts NYC's GIS
 * data doesn't carry. Run with:  npm run build:nyc-directory
 *
 * Source: NYC Parks' own `bigapps` directories. These are listed on NYC Open
 * Data as link-type datasets, so the Socrata /resource/<id>.json API answers
 * "no row or column access to non-tabular tables" — you have to fetch the
 * nycgovparks.org URL directly, which is why they're easy to miss:
 *   DPR_Tennis_001          78 tennis facilities (surface, indoor/outdoor,
 *                           phone, court count, a prose Info blurb)
 *   DPR_Basketball_001     577 · DPR_Handball_001 547  (counts only)
 *   DPR_RecreationCenter_001  54 rec centers with per-weekday Building_Hours
 *
 * Prop_ID in these feeds IS the Socrata `gispropnum` our outdoor pins carry as
 * `key`, so the join is exact — 90-97% of rows land on a pin, the rest being
 * indoor-only sites we have no outdoor pin for.
 *
 * WHAT THIS SHIPS, and what it deliberately doesn't:
 *
 * Counts are NOT shipped. Socrata (one row per physical court, GIS-derived)
 * and this directory (hand-maintained) disagree on ~20% of parks — tennis 51/64
 * agree, handball 366/452, basketball 86/122 — and neither is obviously right.
 * Publishing a second number would just make the card contradict itself, so
 * Socrata stays canonical and the disagreements are LOGGED for review instead.
 *
 * What is shipped is what Socrata genuinely lacks, all tennis:
 *   surf   the real playing surface (Hard / Clay / Fast Dry / Har-Tru), where
 *          Socrata only says "Asphalt". Tennis players care a lot about this.
 *   phone  the facility's number (62 of 78 have one)
 *   info   NYC Parks' own prose about the site — bubble seasons, lessons, which
 *          courts a permit covers (33 of 78)
 *
 * Only Indoor_Outdoor='Outdoor' rows merge onto a pin. Several parks (Crotona,
 * Randall's Island) have an indoor bubble AND outdoor courts under one Prop_ID;
 * attaching the bubble's clay surface to the outdoor park pin would be wrong.
 *
 * Resilience mirrors the other builds: live -> last-good cache -> abort keeping
 * the existing data file.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { loadCache, saveCache } = require('./lib/courts-common');

const BASE = 'https://www.nycgovparks.org/bigapps';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

const OUT_DIR = path.join(__dirname, '..', 'data', 'cities', 'nyc');
const OUT_FILE = path.join(OUT_DIR, 'directory.js');
const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-directory-cache.json');
const COURTS_FILE = path.join(OUT_DIR, 'outdoor-courts.js');
const INDOOR_FILE = path.join(OUT_DIR, 'indoor-courts.js');

// Abort (keep last-good data) below this many enriched courts.
const MIN_ENTRIES_OK = 30;

async function getJson(file) {
  const res = await fetchT(`${BASE}/${file}.json`, { headers: HEADERS }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
  return res.json();
}

// The feeds carry HTML entities and inline markup in their prose fields.
const ENTITIES = { amp: '&', ndash: '–', mdash: '—', nbsp: ' ', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ') // links to the facility's own site — the text still reads
    .replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

// Park key -> our court id, off the generated outdoor pins (same anchor the
// reservation build uses).
function loadPins() {
  const src = fs.readFileSync(COURTS_FILE, 'utf8');
  const byKey = new Map();
  for (const m of src.matchAll(/id: "([^"]+)",\s*\n\s*key: "([^"]+)",\s*\n\s*name: "((?:[^"\\]|\\.)*)"/g)) {
    byKey.set(m[2], { id: m[1], name: m[3] });
  }
  return byKey;
}

// Per-sport court counts already published in the generated pins, for the
// cross-check below.
function loadFacts() {
  const src = fs.readFileSync(COURTS_FILE, 'utf8');
  const byKey = new Map();
  for (const m of src.matchAll(/key: "([^"]+)",[\s\S]{0,600}?facts: (\{.*?\}),\n/g)) {
    try {
      byKey.set(m[1], JSON.parse(m[2]));
    } catch {
      /* a record whose facts span oddly — skip, this is only a cross-check */
    }
  }
  return byKey;
}

// Socrata vs. this directory, summed per park. Logged, never shipped: two
// numbers on one card would just contradict each other.
function crossCheckCounts(rows, field, sport, facts, byKey) {
  const summed = new Map();
  for (const r of rows) {
    const n = parseInt(r[field], 10);
    if (Number.isFinite(n)) summed.set(r.Prop_ID, (summed.get(r.Prop_ID) || 0) + n);
  }
  let agree = 0;
  const off = [];
  for (const [key, n] of summed) {
    const f = facts.get(key)?.[sport];
    if (!f) continue;
    if (n === f.n) agree++;
    else off.push(`${byKey.get(key)?.name || key}: directory ${n} vs GIS ${f.n}`);
  }
  const total = agree + off.length;
  console.log(
    `  ${sport}: court counts agree on ${agree}/${total} parks` +
      (off.length ? ` — ${off.length} differ (GIS stays canonical)` : '')
  );
  for (const line of off.slice(0, 5)) console.log(`      ${line}`);
  if (off.length > 5) console.log(`      … and ${off.length - 5} more`);
  return { agree, differ: off.length };
}

// Rec-center building hours, cross-checked against our scraped indoor centers.
// NOT merged: the HTML scrape carries per-program open-gym blocks this feed has
// no notion of, and a building-hours span would quietly overwrite them.
function crossCheckRecCenters(rows) {
  let withHours = 0;
  for (const r of rows) {
    const h = r.Building_Hours || {};
    if (Object.values(h).some((d) => d && d.startTime)) withHours++;
  }
  let scraped = 0;
  try {
    scraped = (fs.readFileSync(INDOOR_FILE, 'utf8').match(/\n {2}\{\n/g) || []).length;
  } catch {
    /* indoor file absent — fine, this line is informational */
  }
  console.log(
    `  rec centers: ${rows.length} in the directory, ${withHours} with building hours; ` +
      `we scrape ${scraped} with open-gym programs (not merged — see the header)`
  );
}

function buildTennis(rows, byKey) {
  const out = {};
  let skippedIndoor = 0;
  let unmatched = 0;
  for (const r of rows) {
    // Indoor bubbles share a Prop_ID with the outdoor courts at the same park;
    // their surface and phone describe a different facility.
    if (String(r.Indoor_Outdoor || '').toLowerCase() !== 'outdoor') {
      skippedIndoor++;
      continue;
    }
    const pin = byKey.get(r.Prop_ID);
    if (!pin) {
      unmatched++;
      continue;
    }
    const e = (out[pin.id] ||= { tennis: {} }).tennis;
    const surf = clean(r.Tennis_Type);
    if (surf) e.surf = [...new Set([...(e.surf || []), surf])];
    const phone = clean(r.Phone);
    if (phone && !e.phone) e.phone = phone;
    const info = clean(r.Info);
    // A park with two outdoor rows (Riverside's clay and hard courts) gets both
    // blurbs; keep the longer one rather than concatenating two overlapping
    // descriptions of the same park.
    if (info && info.length > (e.info?.length || 0)) e.info = info;
  }
  for (const id of Object.keys(out)) {
    if (!Object.keys(out[id].tennis).length) delete out[id];
  }
  console.log(
    `  tennis: ${Object.keys(out).length} pins enriched ` +
      `(${skippedIndoor} indoor rows skipped, ${unmatched} with no outdoor pin)`
  );
  return out;
}

async function main() {
  console.log('Building NYC court directory from NYC Parks bigapps feeds…');
  const byKey = loadPins();
  if (!byKey.size) throw new Error(`no park keys in ${COURTS_FILE} — run "npm run build:nyc" first`);
  console.log(`  ${byKey.size} park pins with a join key`);

  let directory;
  let source;
  try {
    const [tennis, basketball, handball, recCenters] = await Promise.all([
      getJson('DPR_Tennis_001'),
      getJson('DPR_Basketball_001'),
      getJson('DPR_Handball_001'),
      getJson('DPR_RecreationCenter_001'),
    ]);

    directory = buildTennis(tennis, byKey);

    const facts = loadFacts();
    crossCheckCounts(tennis, 'Courts', 'tennis', facts, byKey);
    crossCheckCounts(basketball, 'Num_of_Courts', 'basketball', facts, byKey);
    crossCheckCounts(handball, 'Num_of_Courts', 'handball', facts, byKey);
    crossCheckRecCenters(recCenters);

    if (Object.keys(directory).length < MIN_ENTRIES_OK) {
      throw new Error(
        `only ${Object.keys(directory).length} enriched pins (min ${MIN_ENTRIES_OK}) — feed shape may have changed`
      );
    }
    source = 'live';
    saveCache(CACHE_FILE, { directory, fetchedAt: new Date().toISOString() });
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !cache.directory) {
      throw new Error(`fetch failed (${e.message}) and no cache — ${OUT_FILE} left unchanged`);
    }
    directory = cache.directory;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, render(directory, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${Object.keys(directory).length} courts to data/cities/nyc/directory.js (${source})`);
}

function render(directory, generatedAt, source) {
  const body = Object.keys(directory)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory[id])},`)
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-nyc-directory.js — do not edit by hand.
// Regenerate with: npm run build:nyc-directory
// Generated: ${generatedAt} (${source})
//
// Qualitative facility facts from NYC Parks' own directories, for the things
// the GIS dataset doesn't carry. Court id -> { sport: { surf, phone, info } }:
//   surf   real playing surface(s) — "Hard", "Clay", "Fast Dry", "Har-Tru".
//          Socrata only says "Asphalt" for the same courts.
//   phone  the facility's public number
//   info   NYC Parks' own prose: bubble seasons, lessons, which courts a
//          permit covers
//
// Court COUNTS are deliberately absent: this directory and the GIS dataset
// disagree on ~20% of parks and neither is clearly right, so the GIS count
// stays canonical and the build only logs the differences.
//
// Merged onto each pin's \`facts[sport]\` by data/cities/index.js — NOT onto
// \`directory\`, which is SF-shaped and whose presence hides the NYC facts row.

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const NYC_DIRECTORY = {
${body}
};

export default NYC_DIRECTORY;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
