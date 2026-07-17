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

// Pickleball open-play times for "See schedule" directory rows come from the
// schedule PDF each row links (DocumentCenter): openPlayFromPdf() parses the
// poster's weekly grid when the PDF has a text layer (Moscone) into a 7-day
// week of [startMin, endMin] blocks (0=Sun..6=Sat — same convention as
// court.dropins, so the app can merge them into the schedule rows). Some
// posters are flattened images with NO text layer (Presidio Wall, Rossi as of
// 2026-07) — those fall back to the entries below, transcribed from the
// posters: a `week` when the times are concrete, a display-only `times` string
// when they aren't ("9AM-dusk"). The build logs when a fallback is used;
// re-verify these if SFRP posts a new poster (the log prints the PDF URL).
const PDF_FALLBACK = {
  'presidio wall': { times: 'Daily 9AM-dusk · courts B/D/F always drop-in' },
  // Tue/Thu/Fri 9AM-3PM, Sun 9AM-5PM
  rossi: { week: [[[540, 1020]], [], [[540, 900]], [], [[540, 900]], [[540, 900]], []] },
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

// Read a directory table into header-keyed row objects. Cell links survive as
// row._links[header] (absolute URLs) — the pickleball "See schedule" cells link
// each court's posted schedule PDF.
function parseTable($, table) {
  const rows = $(table).find('tr');
  const head = rows
    .first()
    .find('th,td')
    .map((i, c) => $(c).text().trim().replace(/\s+/g, ' '))
    .get();
  const out = [];
  rows.slice(1).each((i, tr) => {
    const cellEls = $(tr).find('th,td');
    const cells = cellEls.map((j, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
    if (!cells.length || !cells[0]) return;
    const row = { _links: {} };
    head.forEach((h, k) => {
      row[h] = cells[k] ?? '';
      const href = cellEls.eq(k).find('a[href]').attr('href');
      if (href) row._links[h] = new URL(href, 'https://sfrecpark.org').href;
    });
    out.push(row);
  });
  return out;
}

// ---- posted schedule PDFs ---------------------------------------------------
// Parse a court-schedule poster (e.g. Moscone's) into a compact open-play string.
// The template is a weekly grid: 7 day rows top-to-bottom Mon..Sun, each
// pickleball open-play block an "OPEN GROUP PLAY" label under a "PICKLEBALL"
// heading with its time range beside it. We pull positioned text via pdfjs-dist
// (build-only devDep, same as build-pools), cluster items into day rows by
// y-gaps, and take the time ranges x-aligned with each OPEN GROUP PLAY label.
// Returns null when the PDF has no text layer (a flattened image poster).
const TIME_RE = /^\d{1,2}(:\d{2})?(AM|PM)?\s*-\s*\d{1,2}(:\d{2})?(AM|PM)$/i;

// "7AM" / "10:30 a.m." → minutes from midnight; a missing meridiem borrows the
// range's end meridiem ("3-6PM" → 3PM).
function toMin(s, fallbackMer) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let h = +m[1] % 12;
  if (/^p/i.test(m[3] || fallbackMer || '')) h += 12;
  return h * 60 + (+m[2] || 0);
}

// "7AM-3PM" / "10:30 a.m. to 1:30 p.m." → [startMin, endMin], or null.
function parseRange(str) {
  const m = String(str).match(
    /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i
  );
  if (!m) return null;
  const endMer = (m[2].match(/a\.?m\.?|p\.?m\.?/i) || [''])[0];
  const s = toMin(m[1], endMer);
  const e = toMin(m[2]);
  return s != null && e != null && e > s ? [s, e] : null;
}

// Explicit directory-cell text like "Tuesdays and Thursdays, 10:30 a.m. to
// 1:30 p.m." → a 7-day week (one shared time range), or null when unparseable.
const DAY_TOKENS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function weekFromText(text) {
  const days = new Set();
  const re = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi;
  let m;
  while ((m = re.exec(text))) days.add(DAY_TOKENS[m[1].toLowerCase()]);
  const range = parseRange(text);
  if (!days.size || !range) return null;
  const week = Array.from({ length: 7 }, () => []);
  for (const d of days) week[d] = [range];
  return week;
}

async function openPlayFromPdf(url) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const items = tc.items
    .map((it) => ({ s: it.str.trim().replace(/\s+/g, ' '), x: it.transform[4], y: it.transform[5] }))
    .filter((it) => it.s);
  if (!items.length) return null; // image-only poster — caller falls back

  // Cluster into horizontal bands: rows of the grid sit far apart in y compared
  // to the lines within one block.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const bands = [];
  for (const it of sorted) {
    const band = bands[bands.length - 1];
    if (band && band[band.length - 1].y - it.y < 60) band.push(it);
    else bands.push([it]);
  }
  // Day rows are the bands that contain schedule times (title/footer bands don't).
  const dayBands = bands.filter((b) => b.some((it) => TIME_RE.test(it.s)));
  if (dayBands.length !== 7) {
    throw new Error(`expected 7 day rows in ${url}, found ${dayBands.length} — poster layout changed?`);
  }

  // Per day: time ranges x-aligned with a standalone "PICKLEBALL" heading — the
  // open-group-play blocks. Reservable blocks are headed "TENNIS OR PICKLEBALL"
  // (never plain PICKLEBALL), and as a guard we skip a heading whose block
  // carries an x-aligned RESERVABLE tag. (Most blocks also say "OPEN GROUP
  // PLAY", but e.g. Moscone's Sunday block omits it, so it can't be the anchor.)
  // Rows read top-to-bottom Mon..Sun; emit Sun-first to match court.dropins.
  const week = Array.from({ length: 7 }, () => []);
  dayBands.forEach((band, i) => {
    const heads = band.filter((it) => /^pickleball$/i.test(it.s));
    const blocks = [];
    for (const h of heads) {
      if (band.some((it) => /^reservable$/i.test(it.s) && Math.abs(it.x - h.x) < 60)) continue;
      for (const it of band) {
        if (TIME_RE.test(it.s) && Math.abs(it.x - h.x) < 60) {
          const r = parseRange(it.s);
          if (r) blocks.push(r);
        }
      }
    }
    week[(i + 1) % 7] = blocks.sort((a, b) => a[0] - b[0]);
  });
  return week.some((d) => d.length) ? week : null;
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
    // "Open Play" column: a court count (dedicated open-play courts), explicit
    // times ("Tues/Thurs 10:30am-1:30pm"), or "See schedule" linking the court's
    // posted schedule PDF — parsed when it has a text layer, else the transcribed
    // fallback above.
    const openKey = Object.keys(r).find((k) => /open\s*play/i.test(k) && k !== '_links');
    const openRaw = openKey ? String(r[openKey]).trim() : '';
    const openPlayCourts = /^\d+$/.test(openRaw) ? num(openRaw) : 0;
    let openPlayWeek = null;
    let openPlayTimes = openRaw && !/^\d+$/.test(openRaw) ? openRaw : null;
    if (openPlayTimes && /^(see\s+)?schedule/i.test(openPlayTimes)) {
      const link = openKey && r._links[openKey];
      if (link) {
        try {
          openPlayWeek = await openPlayFromPdf(link);
        } catch (e) {
          console.log(`  ⚠ ${facility} schedule PDF: ${e.message}`);
        }
      }
      if (!openPlayWeek) {
        const fb = PDF_FALLBACK[norm(facility)];
        openPlayWeek = (fb && fb.week) || null;
        openPlayTimes = (fb && fb.times) || openPlayTimes;
        console.log(
          `  ↺ ${facility}: open-play from ${fb ? 'transcribed fallback' : 'nowhere (left as-is)'}` +
            (link ? ` — poster is not machine-readable, re-verify against ${link}` : '')
        );
      }
    } else if (openPlayTimes) {
      // Explicit times right in the cell (e.g. Upper Noe) — structure when parseable.
      openPlayWeek = weekFromText(openPlayTimes);
    }
    if (openPlayWeek) openPlayTimes = null; // week supersedes the display string
    (out[court.id] ||= {}).pickleball = {
      total,
      reservable: num(r['Reservable']),
      walkup: num(r['Walk-up shared use']),
      lights: yes(r['Lights']),
      restrooms: yes(r['Restrooms']),
      nets: nets || null,
      ...(openPlayCourts > 0 ? { openPlayCourts } : {}),
      ...(openPlayWeek ? { openPlayWeek } : {}),
      ...(openPlayTimes ? { openPlayTimes } : {}),
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
// lights, restrooms, [dedicated], [nets], [openPlayCourts], [openPlayTimes] } }.
// openPlayCourts = dedicated open-play court count; openPlayWeek = shared-use
// open-play blocks as a dropins-style week (0=Sun..6=Sat, [startMin, endMin] —
// parsed from the posted schedule PDF each "See schedule" row links, or from
// explicit cell text; transcribed fallback for image-only posters); openPlayTimes
// = display-only string when the times can't be structured ("9AM-dusk"). Merged
// onto courts at runtime by lib/useCourts.js; the card folds openPlayWeek into
// the weekly schedule rows tagged "(open play)".

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
