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
const I18N_CACHE_FILE = path.join(__dirname, 'classes-i18n-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'classes.js');
const MIN_OK = 30; // abort (keep last-good) if fewer than this many classes parse

// Our categories. ActiveNet's own categories lump very different things together
// (its "Music & Arts" mixes ukulele with oil painting and darkroom photography), so
// we pull each ActiveNet category and re-bucket every item by keyword into clearer
// app categories. ActiveNet category ids we query:
//   29 Fitness & Wellness        -> fitness
//   50/25/24 Music & Arts        -> music / arts / photo (by keyword)
//   26 Dance / Music / Perf Arts -> dance (default) / music / arts / photo
//   33 Social Activities         -> social (default) / music
const CATEGORIES = [
  { id: 'fitness', label: 'Fitness & Wellness', emoji: '🧘' },
  { id: 'dance', label: 'Dance', emoji: '💃' },
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'arts', label: 'Arts & Crafts', emoji: '🎨' },
  { id: 'photo', label: 'Photography', emoji: '📷' },
  { id: 'social', label: 'Social & Games', emoji: '🎲' },
];

// Keyword classifiers, checked photo -> arts -> music; the caller supplies the
// fallback for items that match none (the ActiveNet category's dominant theme).
const PHOTO_RE =
  /photo|lightroom|darkroom|\bfilm\b|camera|cyanotype|photoshop|collage|negative|develop/i;
const ARTS_RE =
  /paint|brush|sketch|draw|jewel|knit|crochet|bead|paper|ceramic|pottery|clay|\bsew\b|quilt|origami|craft|callig/i;
const MUSIC_RE =
  /music|sing|choir|ukulele|guitar|piano|drum|instrument|karaoke|\bband\b|orchestra|appreciation/i;

function classify(name, fallback) {
  if (PHOTO_RE.test(name)) return 'photo';
  if (ARTS_RE.test(name)) return 'arts';
  if (MUSIC_RE.test(name)) return 'music';
  return fallback;
}

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
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\bplgd\b/g, 'playground')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  // Rec/senior centers whose names don't match our court data (coords from DataSF
  // ib5c-xgwu). Keyed by the normalized ActiveNet location label.
  const MANUAL = {
    'golden gate park senior center': { lat: 37.77154, lng: -122.49702 },
    'civic center plaza': { lat: 37.77952, lng: -122.41758 },
    'harvey milk photo center': { lat: 37.76958, lng: -122.43456 },
  };
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
  return { coordsFor: (label) => MANUAL[norm(label)] || map[strip(label)] || null };
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
  // Availability: `openings` is the *actual* number of open spots — "0" when full,
  // or "Unlimited" for no-cap drop-ins. (total_open is capacity, NOT openings, so a
  // full class can still report total_open=4 with openings="0" — that was the bug.)
  const openingsRaw = String(item.openings ?? '');
  const unlimited = /unlimited/i.test(openingsRaw);
  const parsed = parseInt(openingsRaw, 10);
  const spots = unlimited ? null : Number.isFinite(parsed) ? parsed : null;
  return {
    id: `anc-${item.id}`,
    name,
    category,
    location,
    when,
    dropIn: /drop-?in/i.test(name) || unlimited,
    cost: cleanFee(item.fee),
    ages: dehtml(item.age_description || '').replace(/,\s*$/, '') || 'All ages',
    minAge,
    spots, // open spots remaining (null when unlimited/unknown)
    unlimited, // true = no registration cap
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

  // Each ActiveNet category, re-bucketed by keyword. The second arg is the fallback
  // category for items matching no keyword (the source category's dominant theme).
  const groups = [
    { ids: ['29'], fallback: 'fitness' },
    { ids: ['50', '25', '24'], fallback: 'arts' }, // Music & Arts
    { ids: ['26'], fallback: 'dance' }, // Dance / Music / Performing Arts
    { ids: ['33'], fallback: 'social' }, // Social Activities
  ];
  for (const g of groups) {
    const items = await fetchCategory(session, g.ids);
    for (const it of items) add(it, classify(dehtml(it.name), g.fallback));
    console.log(`  ANC ${g.ids.join(',')}: ${items.length}`);
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

// --- Class-name localization ---------------------------------------------
// Class titles are scraped English; the app UI is translated (en/zh/es). We
// pre-translate the *distinct* titles once and bundle name_zh/name_es onto each
// row, so the app stays instant/offline and never calls an API. Translations are
// cached by title in classes-i18n-cache.json, so each weekly refresh only spends
// tokens on titles it hasn't seen — usually zero. Degrades gracefully: with no
// ANTHROPIC_API_KEY (or on any API error) we keep the English names and move on.

function loadI18nCache() {
  try {
    return JSON.parse(fs.readFileSync(I18N_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Translate one chunk of titles via Claude Haiku. Returns { title: { zh, es } }.
async function translateChunk(names) {
  const list = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const prompt =
    `Translate these ${names.length} San Francisco Rec & Park drop-in class titles ` +
    `into Simplified Chinese and Spanish. They are recreational classes (fitness, ` +
    `dance, art, music, social games). Keep translations natural and concise and ` +
    `preserve level markers like "Intermediate"/"Beginner". Reply with ONLY a JSON ` +
    `array of exactly ${names.length} objects, same order, each {"zh":"…","es":"…"} ` +
    `— no prose, no code fences.\n\n${list}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
  const out = {};
  names.forEach((n, i) => {
    const t = arr[i];
    if (t && t.zh && t.es) out[n] = { zh: String(t.zh), es: String(t.es) };
  });
  return out;
}

// Add name_zh/name_es to each class from cache, translating any new titles first.
async function applyTranslations(classes) {
  const cache = loadI18nCache();
  const distinct = [...new Set(classes.map((c) => c.name))];
  const missing = distinct.filter((n) => !cache[n]);

  if (missing.length) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log(`  ⚠ ANTHROPIC_API_KEY not set — ${missing.length} title(s) stay English-only`);
    } else {
      console.log(`  Translating ${missing.length} new class title(s) via Claude Haiku…`);
      try {
        for (let i = 0; i < missing.length; i += 40) {
          Object.assign(cache, await translateChunk(missing.slice(i, i + 40)));
        }
        fs.writeFileSync(I18N_CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
      } catch (e) {
        console.log(`  ⚠ translation skipped (${e.message}) — keeping English titles`);
      }
    }
  }

  for (const c of classes) {
    const t = cache[c.name];
    if (t) {
      c.name_zh = t.zh;
      c.name_es = t.es;
    }
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
// unlimited, lat?, lng?, url, name_zh?, name_es? }. lat/lng are present when the rec
// center matched our court data (for distance filtering); name_zh/name_es are bundled
// translations of the title (absent if untranslated); spots is the open-spot count from
// ActiveNet openings (0 = full, null = unknown), unlimited = no-cap drop-in;
// minAge drives the age filters.

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

  await applyTranslations(classes);

  fs.writeFileSync(OUT_FILE, render(classes, new Date().toISOString()));
  console.log(`\n✅ Wrote ${classes.length} classes to data/classes.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
