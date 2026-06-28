#!/usr/bin/env node
/*
 * Build data/court-directory.js — per-court facility facts (court counts, lights,
 * restrooms, nets) for tennis + pickleball, scraped from SF Rec & Park's public
 * court directories. Run with:  npm run build:directory
 *
 *   Tennis:     https://sfrecpark.org/1446/Tennis-Court-Directory
 *   Pickleball: https://sfrecpark.org/1772/Pickleball-Court-Directory
 *
 * Each directory is a single HTML table keyed by facility name. We parse the rows,
 * match each to one of our outdoor courts by name (sport-gated, with a few manual
 * aliases for names that don't line up), and write a courtId -> { sport: {...} }
 * map merged at runtime by lib/useCourts.js and shown on the court detail card.
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (directory-cache.json); a fetch failure keeps the existing data file.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const SOURCES = {
  tennis: 'https://sfrecpark.org/1446/Tennis-Court-Directory',
  pickleball: 'https://sfrecpark.org/1772/Pickleball-Court-Directory',
};
const CACHE_FILE = path.join(__dirname, 'directory-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'court-directory.js');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Abort (keep last-good data) if fewer than this many courts get directory facts.
const MIN_COURTS_OK = 30;

// Directory facility name (normalized) -> our court id, for names that don't match
// by substring (the directory shortens or renames a few parks).
const ALIASES = {
  rossi: 'angelo-j-rossi-playground-outdoor',
  'dolores park': 'mission-dolores-park-outdoor',
  larsen: 'carl-larsen-park-outdoor',
  mclaren: 'john-mclaren-park-outdoor',
  'j p murphy': 'j-p-murphy-playground-outdoor',
  'margaret s hayward': 'margaret-s-hayward-playground-outdoor',
  'minnie and lovie ward': 'minnie-and-lovie-rec-center-outdoor',
  'stern grove': 'sigmund-stern-recreation-grove-outdoor',
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parentheticals like "(15th St)"
    .replace(/&/g, ' and ')
    .replace(/[.,'’"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');

const num = (s) => {
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};
const yes = (s) => /^\s*y/i.test(String(s || ''));

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Read a directory table into header-keyed row objects.
function parseTable($, table) {
  const rows = $(table).find('tr');
  const head = rows
    .first()
    .find('th,td')
    .map((i, c) => $(c).text().trim().replace(/\s+/g, ' '))
    .get();
  const out = [];
  rows.slice(1).each((i, tr) => {
    const cells = $(tr)
      .find('th,td')
      .map((j, c) => $(c).text().trim().replace(/\s+/g, ' '))
      .get();
    if (!cells.length || !cells[0]) return;
    const row = {};
    head.forEach((h, k) => (row[h] = cells[k] ?? ''));
    out.push(row);
  });
  return out;
}

// Our outdoor courts, indexed for name matching, with the sports each offers.
function ourCourts() {
  const outdoor = require('../data/outdoor-courts.js').default;
  const offers = (c, s) => (c.dropins?.[s] || []).some((d) => d && d.length);
  return outdoor.map((c) => ({
    id: c.id,
    name: c.name,
    n: norm(c.name),
    sports: ['tennis', 'pickleball'].filter((s) => offers(c, s)),
  }));
}

// Match a directory facility (for a given sport) to one of our courts. Sport-gated;
// prefers an alias, then exact name, then the closest name that contains the
// facility name as whole words (fewest extra tokens wins).
function matchCourt(facility, sport, courts) {
  const fn = norm(facility);
  if (ALIASES[fn]) return courts.find((c) => c.id === ALIASES[fn]) || null;
  const pool = courts.filter((c) => c.sports.includes(sport));
  let best = null,
    bestScore = Infinity;
  for (const c of pool) {
    if (c.n === fn) return c; // exact
    const contains =
      c.n === fn ||
      c.n.startsWith(fn + ' ') ||
      c.n.endsWith(' ' + fn) ||
      c.n.includes(' ' + fn + ' ');
    if (!contains || fn.length < 4) continue;
    const extra = c.n.split(' ').length - fn.split(' ').length; // fewer extra words = closer
    if (extra < bestScore) {
      bestScore = extra;
      best = c;
    }
  }
  return best;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function build() {
  const courts = ourCourts();
  const out = {}; // courtId -> { sport: {...} }
  const misses = [];

  // --- Tennis ---
  const $t = cheerio.load(await getHtml(SOURCES.tennis));
  for (const r of parseTable($t, $t('table').first())) {
    const facility = r['Facility'];
    const court = matchCourt(facility, 'tennis', courts);
    const total = num(r['Total courts']);
    if (!court) {
      if (total > 0) misses.push(`tennis: ${facility}`);
      continue;
    }
    (out[court.id] ||= {}).tennis = {
      total,
      reservable: num(r['Reservable courts']),
      walkup: num(r['Walk-up courts']),
      lights: yes(r['Lights']),
      restrooms: yes(r['Restrooms']),
    };
  }

  // --- Pickleball (outdoor table only; indoor gym courts aren't in our data) ---
  const $p = cheerio.load(await getHtml(SOURCES.pickleball));
  for (const r of parseTable($p, $p('table').first())) {
    const facility = r['Facility'];
    const court = matchCourt(facility, 'pickleball', courts);
    const total = num(r['Total courts']);
    if (!court) {
      if (total > 0) misses.push(`pickleball: ${facility}`);
      continue;
    }
    const nets = (r['Nets*'] || r['Nets'] || '').trim();
    (out[court.id] ||= {}).pickleball = {
      total,
      reservable: num(r['Reservable']),
      walkup: num(r['Walk-up shared use']),
      lights: yes(r['Lights']),
      restrooms: yes(r['Restrooms']),
      nets: nets || null,
    };
  }

  let count = 0;
  for (const id of Object.keys(out)) count += Object.keys(out[id]).length;
  if (count < MIN_COURTS_OK) {
    throw new Error(`only ${count} directory readings (min ${MIN_COURTS_OK}) — page shape may have changed`);
  }
  if (misses.length) console.log(`  ⚠ unmatched directory rows:\n    ${misses.join('\n    ')}`);
  return { out, count };
}

function render(directory, generatedAt) {
  const ids = Object.keys(directory).sort();
  const body = ids
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory[id])},`)
    .join('\n');
  return `// AUTO-GENERATED by scripts/build-court-directory.js — do not edit by hand.
// Regenerate with: npm run build:directory
// Generated: ${generatedAt}
//
// Per-court facility facts from SF Rec & Park's tennis + pickleball court
// directories. Map of our court id -> { sport: { total, reservable, walkup,
// lights, restrooms, [dedicated], [nets] } }. Merged onto courts at runtime by
// lib/useCourts.js and shown on the court detail card.

export const DIRECTORY = {
${body}
};

export default DIRECTORY;
`;
}

async function main() {
  console.log('Fetching SF Rec & Park court directories…');
  let directory, source;
  try {
    const { out, count } = await build();
    directory = out;
    source = 'live';
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ directory, fetchedAt: new Date().toISOString() }, null, 2) + '\n'
    );
    console.log(`  parsed ${count} court-sport entries`);
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.directory) {
      throw new Error(`fetch failed (${e.message}) and no cache — data/court-directory.js left unchanged`);
    }
    directory = cache.directory;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.writeFileSync(OUT_FILE, render(directory, new Date().toISOString()));
  console.log(`\n✅ Wrote ${Object.keys(directory).length} courts to data/court-directory.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
