#!/usr/bin/env node
/*
 * Build data/classes.js — SF Rec & Park drop-in classes & programs (fitness, dance,
 * music/arts, social games), scraped from their ActiveNet (ActiveCommunities) catalog.
 * Run with:  npm run build:classes
 *
 * ActiveNet's activity search is a JSON API behind a CSRF token + session cookie:
 *   1. GET /sfrecpark/activity/search to get JSESSIONID + a CSRF token.
 *   2. POST /sfrecpark/rest/activities/list with those, filtered by category, paged.
 * Items don't carry their own category, so we query each category we care about and
 * tag the rows; Dance/Music/Performing-Arts is split into dance vs music by keyword.
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (classes-cache.json); a fetch failure keeps the existing data file.
 */

const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://anc.apm.activecommunities.com/sfrecpark';
const CACHE_FILE = path.join(__dirname, 'classes-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'classes.js');
const MIN_OK = 30; // abort (keep last-good) if fewer than this many classes parse

// Our categories, and which ActiveNet category ids feed each directly (arts/crafts
// go under Music & Arts). Two ActiveNet categories are mixed and split by keyword:
//   26 Dance / Music / Performing Arts  -> music vs dance
//   33 Social Activities (bingo, mahjong, sing-along, music appreciation) -> music vs social
const CATEGORIES = [
  { id: 'fitness', label: 'Fitness & Wellness', emoji: '🧘', anc: ['29'] },
  { id: 'dance', label: 'Dance', emoji: '💃', anc: [] },
  { id: 'music', label: 'Music & Arts', emoji: '🎵', anc: ['50', '25', '24'] },
  { id: 'social', label: 'Social & Games', emoji: '🎲', anc: [] },
];
const SPLITS = [
  { ids: ['26'], music: 'music', other: 'dance' },
  { ids: ['33'], music: 'music', other: 'social' },
];
const MUSIC_RE =
  /music|sing|choir|ukulele|guitar|piano|drum|instrument|karaoke|\bband\b|orchestra|appreciation/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Match a rec-center name to coordinates from our existing court data (ActiveNet gives
// only a name, no lat/lng). Keys strip common suffixes so "Glen Canyon Rec Center"
// matches our "Glen Canyon Park".
function buildCoords() {
  const strip = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(rec(reation)? center|playgrounds?|park|plgd|center|clubhouse|pool|square|mini)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const map = {};
  const sources = [];
  for (const f of ['../data/outdoor-courts.js', '../data/courts.js', '../data/manual-courts.js']) {
    try {
      const m = require(f);
      const arr = m.default || m;
      if (Array.isArray(arr)) sources.push(...arr);
    } catch {
      // optional source
    }
  }
  for (const c of sources) {
    if (c && c.name && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
      const k = strip(c.name);
      if (k && !map[k]) map[k] = { lat: c.lat, lng: c.lng };
    }
  }
  return { coordsFor: (label) => map[strip(label)] || null };
}

// Title-case an ALL-CAPS location label and expand a couple of abbreviations.
function cleanLoc(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/\bplgd\b/g, 'playground')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bMlk\b/g, 'MLK')
    .trim();
}

const cleanFee = (f) => {
  const t = (f && f.label) || '';
  if (/registration info/i.test(t)) return 'See site';
  return t.replace(/\.00\b/g, '') || '—';
};

const cleanDays = (d) => (d ? String(d).replace(/,/g, ' & ') : '');

// Decode the handful of HTML entities ActiveNet returns in names.
const dehtml = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .trim();

async function getSession() {
  const res = await fetch(`${BASE}/activity/search?locale=en-US`, { headers: { 'User-Agent': UA } });
  const cookies = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');
  const html = await res.text();
  const csrf = (html.match(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/) || [])[1];
  if (!csrf) throw new Error('could not find ActiveNet CSRF token');
  return { cookies, csrf };
}

// All activity items for a set of ActiveNet category ids (paged).
async function fetchCategory(session, catIds) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const body = {
      activity_search_pattern: {
        activity_select_param: 2,
        activity_keyword: '',
        activity_category_ids: catIds,
        for_map: false,
      },
      activity_transfer_pattern: {},
    };
    const res = await fetch(
      `${BASE}/rest/activities/list?locale=en-US&page_number=${page}&total_records_per_page=20`,
      {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json;charset=utf-8',
          'X-CSRF-Token': session.csrf,
          'X-Requested-With': 'XMLHttpRequest',
          Cookie: session.cookies,
          Referer: `${BASE}/activity/search?locale=en-US`,
        },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} on category ${catIds.join(',')} page ${page}`);
    const d = await res.json();
    const items = d.body?.activity_items || [];
    out.push(...items);
    totalPages = d.headers?.page_info?.total_page || 1;
    page++;
    await sleep(150);
  } while (page <= totalPages && page <= 30);
  return out;
}

// ActiveNet item -> our class row, or null to drop it.
function toClass(item, category, coords) {
  const name = dehtml(item.name);
  const location = cleanLoc(item.location?.label);
  if (!name || !location || /^n\/?a$/i.test(item.location?.label || '')) return null; // multi-site / TBD
  const when = [cleanDays(item.days_of_week), item.time_range].filter(Boolean).join(' · ');
  const c = coords.coordsFor(item.location?.label);
  const minAge = Number(item.age_min_year) || 0;
  return {
    id: `anc-${item.id}`,
    name,
    category,
    location,
    when,
    dropIn: /drop-?in/i.test(name) || item.item_type === 7,
    cost: cleanFee(item.fee),
    ages: dehtml(item.age_description || '').replace(/,\s*$/, '') || 'All ages',
    minAge,
    spots: Number.isFinite(item.total_open) ? item.total_open : null,
    ...(c ? { lat: c.lat, lng: c.lng } : {}),
    url: item.detail_url || `${BASE}/activity/search?locale=en-US`,
  };
}

async function scrape() {
  const session = await getSession();
  const coords = buildCoords();
  const rows = [];
  const seen = new Set();
  const add = (item, cat) => {
    const c = toClass(item, cat, coords);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      rows.push(c);
    }
  };

  // Direct-mapped categories.
  for (const cat of CATEGORIES) {
    if (!cat.anc.length) continue;
    const items = await fetchCategory(session, cat.anc);
    for (const it of items) add(it, cat.id);
    console.log(`  ${cat.id}: ${items.length} from ANC ${cat.anc.join(',')}`);
  }

  // Mixed categories split by keyword (music vs dance/social).
  for (const sp of SPLITS) {
    const items = await fetchCategory(session, sp.ids);
    for (const it of items) add(it, MUSIC_RE.test(dehtml(it.name)) ? sp.music : sp.other);
    console.log(`  split ANC ${sp.ids.join(',')}: ${items.length}`);
  }

  return rows;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function render(classes, generatedAt) {
  const body = classes
    .map((c) => `  ${JSON.stringify(c)},`)
    .join('\n');
  const cats = CATEGORIES.map((c) => ({ id: c.id, label: c.label, emoji: c.emoji }));
  return `// AUTO-GENERATED by scripts/build-classes.js — do not edit by hand.
// Regenerate with: npm run build:classes
// Generated: ${generatedAt}
//
// SF Rec & Park drop-in classes & programs (non-court), from their ActiveNet catalog.
// Each class: { id, name, category, location, when, dropIn, cost, ages, minAge, spots,
// lat?, lng?, url }. lat/lng are present when the rec center matched our court data
// (for distance filtering); spots is open seats (null if unknown); minAge drives the
// 18+/55+ filters.

export const CLASS_CATEGORIES = ${JSON.stringify(cats, null, 2)
    .replace(/\n/g, '\n')};

export const CLASSES = [
${body}
];

export default CLASSES;
`;
}

async function main() {
  console.log('Fetching SF Rec & Park classes from ActiveNet…');
  let classes;
  let source;
  try {
    classes = await scrape();
    classes.sort((a, b) => a.category.localeCompare(b.category) || a.location.localeCompare(b.location));
    if (classes.length < MIN_OK) {
      throw new Error(`only ${classes.length} classes (min ${MIN_OK}) — ActiveNet shape may have changed`);
    }
    source = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ classes, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.classes) {
      throw new Error(`fetch failed (${e.message}) and no cache — data/classes.js left unchanged`);
    }
    classes = cache.classes;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.writeFileSync(OUT_FILE, render(classes, new Date().toISOString()));
  console.log(`\n✅ Wrote ${classes.length} classes to data/classes.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
