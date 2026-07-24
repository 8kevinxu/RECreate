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
const { fetchT } = require('./fetch-timeout');
const { applyTranslations } = require('./lib/translate-titles');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const BASE = 'https://anc.apm.activecommunities.com/sfrecpark';
const CACHE_FILE = path.join(__dirname, 'classes-cache.json');
const I18N_CACHE_FILE = path.join(__dirname, 'classes-i18n-cache.json');
// Persisted pass-2 skip list: ids proven dead (HTTP 202) or ended (last_date < today).
// Activity ids are assigned monotonically and an ended activity never re-opens, so
// these are stable — re-runs skip them instead of re-probing the whole id window. A
// full rescan every PASS2_FULL_RESCAN_DAYS refreshes the list against any drift (the
// weekly build:data run naturally triggers it; the 6h refresh stays incremental).
const PASS2_CACHE_FILE = path.join(__dirname, 'classes-pass2-cache.json');
const PASS2_FULL_RESCAN_DAYS = 7;
const OUT_FILE = path.join(__dirname, '..', 'data', 'classes.js');
const MIN_OK = 30; // abort (keep last-good) if fewer than this many classes parse

// Our categories. ActiveNet's own categories lump very different things together
// (its "Music & Arts" mixes ukulele with oil painting and darkroom photography), so
// we pull every ActiveNet category and re-bucket each item by keyword into clearer
// app categories. The ActiveNet ids each group queries — and the app category the
// group's unmatched items fall back to — live in `groups` inside scrape().
// ONE canonical program taxonomy, shared across every city so the Classes/Programs
// filter row is identical everywhere (a chip is blank only when the city genuinely
// has none of that program). Photography folds into Arts & Crafts; Film folds into
// "Performances & Screenings" (both are attend-and-watch events). The last three are
// cross-cutting FACET tags (youth/volunteer/accessible) that co-exist with a type.
const CATEGORIES = [
  { id: 'fitness', label: 'Fitness & Wellness', emoji: '🧘' },
  { id: 'dance', label: 'Dance', emoji: '💃' },
  { id: 'music', label: 'Music', emoji: '🎵' },
  { id: 'arts', label: 'Arts & Crafts', emoji: '🎨' },
  { id: 'sports', label: 'Sports & Rec', emoji: '🏅' },
  { id: 'aquatics', label: 'Aquatics', emoji: '🏊' },
  { id: 'nature', label: 'Nature & Outdoors', emoji: '🌳' },
  { id: 'learn', label: 'Learn & Explore', emoji: '🧭' },
  { id: 'camps', label: 'Camps', emoji: '🏕️' },
  { id: 'performances', label: 'Performances & Screenings', emoji: '🎭' },
  { id: 'social', label: 'Social & Games', emoji: '🎲' },
  { id: 'youth', label: 'Youth & After School', emoji: '🧒' },
  { id: 'philanthropy', label: 'Volunteer & Stewardship', emoji: '🤝' },
  { id: 'accessible', label: 'Accessible', emoji: '♿' },
];

// Drop-in sessions for sports the map already tracks are skipped: their hours are
// scraped from the facility pages into data/courts.js (the map's open-gym blocks),
// so listing them as classes too would duplicate the map. Sports the map doesn't
// cover (karate, parkour, archery, skateboarding…) stay in the catalog.
const MAP_SPORT_DROPIN_RE =
  /^drop-?in\b.*\b(basketball|volleyball|table tennis|ping[\s-]?pong|badminton|pickleball|tennis|soccer|baseball|weight ?room)\b/i;

// Drop-in swim sessions at the public pools (lap/rec/family/senior/water-exercise)
// duplicate the Pools tab, which already renders each pool's full weekly schedule
// from the official PDFs (data/pools.js). Skip them here — but keep registerable
// swim *lessons* (Learn to Swim, Adult Swim, Parent-and-Tot: dropIn === false),
// which the Pools tab can't sign you up for. Matches all 9 SF pools ("<name>
// Swimming Pool" + "Mission Community Pool"). Applied post-source in main() so it
// also cleans a cache-sourced build, where these rows already sit in the cache.
const POOL_LOC_RE = /\b(swimming|community)\s+pool\b/i;
const isPoolDropIn = (c) => c.dropIn && POOL_LOC_RE.test(c.location || '');

// Keyword classifiers, checked camp -> photo -> arts -> music; the caller supplies
// the fallback for items that match none (the ActiveNet category's dominant theme).
// CAMP_RE routes any "…Summer Camp…" / "Camp Mather…" title into camps regardless
// of its source category; the lookbehind spares fitness "Boot Camp" classes.
const CAMP_RE = /(?<!boot\s)\bcamps?\b/i;
const PHOTO_RE =
  /photo|lightroom|darkroom|\bfilm\b|camera|cyanotype|photoshop|collage|negative|develop/i;
const ARTS_RE =
  /paint|brush|sketch|draw|jewel|knit|crochet|bead|paper|ceramic|pottery|clay|\bsew\b|quilt|origami|craft|callig/i;
const MUSIC_RE =
  /music|sing|choir|ukulele|guitar|piano|drum|instrument|karaoke|\bband\b|orchestra|appreciation/i;

function classify(name, fallback) {
  if (CAMP_RE.test(name)) return 'camps';
  // Photography (and hobby filmmaking) fold into Arts & Crafts — no standalone
  // Photo/Film category in the shared taxonomy.
  if (PHOTO_RE.test(name) || ARTS_RE.test(name)) return 'arts';
  if (MUSIC_RE.test(name)) return 'music';
  return fallback;
}

// Cross-cutting THEME tags layered on top of the primary category (same model as
// the NYC builder's `categoriesFor`), so an SF class also surfaces under each
// matching theme filter. These backfill the categories that were previously
// NYC-only, so the shared chips aren't dead in SF. Matched against the class NAME
// only: ActiveNet descriptions carry boilerplate ("volunteer instructors", "refine
// their performance") that misfires these terms, whereas the curated title is a
// high-precision signal. A theme legitimately absent from the SF catalog (e.g. no
// registerable volunteer programs) simply yields an empty — but still visible — chip.
const NATURE_RE =
  /\bnature\b|wildlife|\bbird|canoe|kayak|\bfish(ing)?\b|marsh|wetland|garden|forest|habitat|\bhik(e|ing)\b|\btrail|outdoor|waterfront|\branger|excursion/i;
const LEARN_RE = /histor(y|ic)|lecture|\btalks?\b|museum|seminar|docent/i;
const PHILANTHROPY_RE = /volunteer|steward|clean.?up|restoration|litter|tree care|community service/i;
const ACCESSIBLE_RE = /adaptive|inclusive|sensory.?friendly|wheelchair|accessible activit/i;
const PERFORMANCES_RE =
  /concert|theat(er|re)|\brecital\b|showcase|\bcomedy\b|opera|symphony|orchestra|cabaret|\bperformance/i;

function tagsFor(text, primary) {
  const tags = [];
  const add = (id, cond) => {
    if (cond && id !== primary && !tags.includes(id)) tags.push(id);
  };
  add('nature', NATURE_RE.test(text));
  add('learn', LEARN_RE.test(text));
  add('philanthropy', PHILANTHROPY_RE.test(text));
  add('accessible', ACCESSIBLE_RE.test(text));
  add('performances', PERFORMANCES_RE.test(text));
  return tags;
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
    // Pools (Aquatics / Learn to Swim). ActiveNet labels them "<NAME> SWIMMING
    // POOL"; coords mirror data/pools.js so swim classes get distance + Directions.
    'balboa swimming pool': { lat: 37.726134, lng: -122.443381 },
    'coffman swimming pool': { lat: 37.713221, lng: -122.4158 },
    'garfield swimming pool': { lat: 37.750098, lng: -122.412027 },
    'hamilton swimming pool': { lat: 37.784566, lng: -122.435086 },
    'martin luther king jr swimming pool': { lat: 37.725545, lng: -122.393722 },
    'mission community pool': { lat: 37.759653, lng: -122.422606 },
    'north beach swimming pool': { lat: 37.802705, lng: -122.412437 },
    'rossi swimming pool': { lat: 37.779065, lng: -122.45828 },
    'sava swimming pool': { lat: 37.737803, lng: -122.475897 },
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

// Descriptions come as HTML — some carry <a href="…">link</a> markup and <br>/<p>
// tags. Strip the markup (keeping the visible link text, which is already a readable
// label/URL), decode entities, and collapse whitespace into a clean single-line blurb.
const stripHtml = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li)>/gi, ' ')
    .replace(/<[^>]+>/g, '') // drop all remaining tags (anchors, spans, …)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, '’')
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

async function getSession() {
  const res = await fetchT(`${BASE}/activity/search?locale=en-US`, { headers: { 'User-Agent': UA } });
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
    const res = await fetchT(
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
  if (!name) return null;
  let location = cleanLoc(item.location?.label);
  if (!location || /^n\/?a$/i.test(item.location?.label || '')) {
    // Multi-site/TBD listings ("Learn to Swim - Level 1" templates) have no usable
    // location; salvage the ones whose name embeds it ("Kayaking at India Basin").
    const at = name.match(/\bat ([A-Z][\w'’.\- ]{3,})$/);
    if (!at) return null;
    location = at[1].trim();
  }
  const when = [cleanDays(item.days_of_week), item.time_range].filter(Boolean).join(' · ');
  const c = coords.coordsFor(item.location?.label);
  const minAge = Number(item.age_min_year) || 0;
  // Upper age bound (e.g. camps "ages 5-10", parent-and-tot "under 5"). ActiveNet's
  // age_max_year is EXCLUSIVE ("less than 11 yrs" → 11) and 0 when there's no cap;
  // store the inclusive max (10), or null for open-ended.
  const rawMaxAge = Number(item.age_max_year) || 0;
  const maxAge = rawMaxAge > 0 ? rawMaxAge - 1 : null;
  // Availability: `openings` is the *actual* number of open spots — "0" when full,
  // or "Unlimited" for no-cap drop-ins. (total_open is capacity, NOT openings, so a
  // full class can still report total_open=4 with openings="0" — that was the bug.)
  const openingsRaw = String(item.openings ?? '');
  const unlimited = /unlimited/i.test(openingsRaw);
  const parsed = parseInt(openingsRaw, 10);
  const spots = unlimited ? null : Number.isFinite(parsed) ? parsed : null;
  // Some drop-in programs (bingo, mah-jong, ballroom, tai chi…) can't be registered
  // online — ActiveNet shows a "View Registration Info" fee placeholder instead of a
  // price. These are free community walk-ins: you just show up at the start time. We
  // flag them (noOnlineReg) and price them Free rather than the unhelpful "See site".
  const feeLabel = (item.fee && item.fee.label) || '';
  const noOnlineReg = /registration info/i.test(feeLabel);
  // Short catalog blurb ActiveNet returns inline on the list item (same text as the
  // detail page's description). Collapse the runs of whitespace it embeds; absent for
  // some classes, in which case the app shows a "No description available" fallback.
  const desc = stripHtml(item.desc);
  // Course term: ActiveNet gives ISO start/end + a one-day flag. A registered
  // (non-drop-in) course enrolls you for the ENTIRE range — every weekly meeting
  // from start to end — not a single session; oneDay marks a single-date activity.
  // Store ISO so the app can localize the display; drop when the source omits it.
  const start = /^\d{4}-\d{2}-\d{2}$/.test(item.date_range_start || '') ? item.date_range_start : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(item.date_range_end || '') ? item.date_range_end : null;
  const oneDay = !!item.only_one_day || (start && end && start === end);
  // Instructor name when the catalog names one ("Unspecified" is ActiveNet's blank).
  const instrRaw = typeof item.instructor === 'string' ? dehtml(item.instructor) : '';
  const instructor = /^(unspecified|n\/?a|tbd)$/i.test(instrRaw) ? '' : instrRaw;
  // Cross-cutting theme tags (nature/learn/volunteer/accessible/performances) from
  // the class name, so a class also appears under each matching shared filter.
  const tags = tagsFor(name, category);
  return {
    id: `anc-${item.id}`,
    name,
    category,
    ...(tags.length ? { tags } : {}),
    location,
    when,
    dropIn: /drop-?in/i.test(name) || unlimited,
    cost: noOnlineReg ? 'Free' : cleanFee(item.fee),
    ages: dehtml(item.age_description || '').replace(/,\s*$/, '') || 'All ages',
    minAge,
    ...(maxAge != null ? { maxAge } : {}),
    spots, // open spots remaining (null when unlimited/unknown)
    unlimited, // true = no registration cap
    ...(noOnlineReg ? { noOnlineReg: true } : {}), // free walk-in, no online sign-up
    ...(start ? { start } : {}), // course term start (ISO YYYY-MM-DD)
    ...(end ? { end } : {}), // course term end (ISO)
    ...(oneDay ? { oneDay: true } : {}), // single-date activity (not a multi-week course)
    ...(instructor ? { instructor } : {}), // named instructor, when the catalog lists one
    ...(desc ? { desc } : {}),
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
    if (c && !MAP_SPORT_DROPIN_RE.test(c.name) && !seen.has(c.id)) {
      seen.add(c.id);
      rows.push(c);
    }
  };

  // Each ActiveNet category, re-bucketed by keyword. The second arg is the fallback
  // category for items matching no keyword (the source category's dominant theme).
  // Covers ActiveNet's full category list (33 ids as of mid-2026); an item in two
  // queried categories dedupes by id, first group wins.
  const groups = [
    { ids: ['29', '56'], fallback: 'fitness' }, // Exercise & Fitness; Seniors - Virtual
    { ids: ['50', '25', '24', '23'], fallback: 'arts' }, // Arts & Crafts / Visual / Photography / Digital
    { ids: ['26'], fallback: 'dance' }, // Dance / Music / Performing Arts
    { ids: ['33', '30', '31', '32'], fallback: 'social' }, // Social; Food; Personal Dev; Sci & Tech
    { ids: ['40', '41', '51'], fallback: 'aquatics' }, // Aquatics; Waterfront; Learn-to-Swim camps
    // All seasonal camp categories (winter/spring break + the summer-camp family).
    { ids: ['34', '35', '36', '37', '38', '43', '44', '45', '46', '47', '52'], fallback: 'camps' },
    // Drop-in sports sessions, alternative rec (karate/parkour/archery), girls
    // sports, adaptive rec, outdoor rec (CAMP_RE reroutes its Camp Mather items).
    { ids: ['21', '49', '42', '54', '39', '18'], fallback: 'sports' },
    { ids: ['22', '28'], fallback: 'youth' }, // After School; Early Childhood
  ];
  // ActiveNet's multi-id search is unreliable — it repeats some categories' items
  // across pages and omits other categories entirely — so query one id at a time;
  // a group only supplies the shared fallback bucket.
  for (const g of groups) {
    for (const id of g.ids) {
      const items = await fetchCategory(session, [id]);
      for (const it of items) add(it, classify(dehtml(it.name), g.fallback));
      console.log(`  ANC ${id}: ${items.length}`);
    }
  }

  // Pass 2: backfill activities the category browse can't see (Full / unlisted). This
  // is where the bulk of the catalog actually lives; see backfillHidden's header. It's
  // best-effort — a failure keeps the crawl result — and merges by id like `add`.
  try {
    const hidden = await backfillHidden(session, coords, rows);
    for (const r of hidden) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
  } catch (e) {
    console.log(`  pass 2 skipped: ${e.message}`);
  }

  const collapsed = collapseSeries(rows);
  await fillFeeDetails(session, collapsed);
  return collapsed;
}

// Some classes' list fee is the literal "View Fee Details" placeholder (multi-tier
// pricing, e.g. Randall Museum member/non-member rates). Pull the real numbers from
// the detail page's price-estimate endpoint and show a price (or "$lo–$hi" range)
// instead. Only rows whose cost has no digits need it; failures keep the label.
async function fillFeeDetails(session, rows) {
  const needs = rows.filter((r) => !/\d/.test(r.cost) && !/free/i.test(r.cost));
  if (!needs.length) return;
  const fmt = (n) => '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
  let filled = 0;
  for (const r of needs) {
    try {
      const res = await fetchT(
        `${BASE}/rest/activity/detail/estimateprice/${r.id.replace(/^anc-/, '')}?locale=en-US`,
        {
          headers: {
            'User-Agent': UA,
            'X-CSRF-Token': session.csrf,
            'X-Requested-With': 'XMLHttpRequest',
            Cookie: session.cookies,
            Referer: `${BASE}/activity/search?locale=en-US`,
          },
        }
      );
      if (!res.ok) continue;
      const ep = (await res.json()).body?.estimateprice;
      if (!ep) continue;
      if (ep.free) {
        r.cost = 'Free';
        filled++;
        continue;
      }
      const amounts = [];
      for (const p of ep.prices || [])
        for (const det of p.details || []) {
          const m = String(det.price || '').match(/\$?([\d,]+(?:\.\d{2})?)/);
          if (m) amounts.push(parseFloat(m[1].replace(/,/g, '')));
        }
      if (!amounts.length) continue;
      const lo = Math.min(...amounts);
      const hi = Math.max(...amounts);
      r.cost = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
      filled++;
    } catch {
      // keep the placeholder label; the register link still shows the fees
    }
    await sleep(150);
  }
  console.log(`  fee details filled for ${filled}/${needs.length} placeholder-fee classes`);
}

// Drop-in series are published as one activity per date — five "Drop-in:
// Basketball" rows are five consecutive Tuesdays. Collapse rows identical in
// everything but their date into one card spanning earliest→latest date, keyed
// by the LATEST instance's id: the app hides ids missing from a healthy live
// catalog (delisted = cancelled), and past instances delist while the series is
// still running — the last instance outlives them all.
function collapseSeries(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = [r.name, r.location, r.category, r.when, r.cost, r.ages].join('|');
    const prev = by.get(k);
    if (!prev) {
      by.set(k, { ...r, _lastStart: r.start || '' });
      continue;
    }
    if (r.start && (!prev.start || r.start < prev.start)) prev.start = r.start;
    const rEnd = r.end || r.start;
    const pEnd = prev.end || prev.start;
    if (rEnd && (!pEnd || rEnd > pEnd)) prev.end = rEnd;
    if ((r.start || '') >= prev._lastStart) {
      prev.id = r.id;
      prev._lastStart = r.start || '';
    }
    if (prev.oneDay && prev.start && prev.end && prev.start !== prev.end) delete prev.oneDay;
    if (r.unlimited) {
      prev.unlimited = true;
      prev.spots = null;
    } else if (!prev.unlimited && r.spots != null && (prev.spots == null || r.spots > prev.spots)) {
      prev.spots = r.spots; // most open spots across upcoming instances
    }
  }
  return [...by.values()].map(({ _lastStart, ...r }) => r);
}

// --- Pass 2: id-backfill of browse-hidden activities ---------------------
// ActiveNet's activity SEARCH — category browse AND keyword — silently omits a large
// share of the live catalog: activities that are Full, waitlist-only, or "unlisted"
// (league / returning-player registrations) never appear in rest/activities/list, no
// matter which category or activity_select_param you query. Measured 2026-07: the
// category crawl above surfaces only ~14% of SF Rec's current registerable programs;
// the other ~86% (most senior programs — Palega line dancing/bingo — plus swim
// lessons, art-studio and rec-center classes) are reachable ONLY by fetching the
// activity directly by id from rest/activity/detail/<id>, which is index-independent.
// This pass scans the live id window (derived from the crawl's own id range) and
// backfills every current activity the crawl missed. A missing id returns HTTP 202.
//
// The detail record carries no weekly meeting pattern (days/time) — that lives only on
// list items — so we recover `when` (and the precise fee/openings) for the searchable
// ones with a keyword lookup (keywordSchedules), and fall back to the term date range
// for the truly unlisted. The whole pass is best-effort: any failure leaves the
// category-crawl result untouched (see scrape()).
const DETAIL_CONC = 5; // parallel detail fetches — the API tolerates ~6 before WAF pushback
const ID_PAD_LOW = 800; // scan a little below the lowest crawled id …
const ID_PAD_HIGH = 1500; // … and above the highest, to catch stragglers past the window
const ID_SCAN_CAP = 12000; // hard safety cap on ids probed in one build
const DEAD_STATUS = /^(cancelled|on hold)$/i;

const detailHeaders = (session) => ({
  'User-Agent': UA,
  'X-CSRF-Token': session.csrf,
  'X-Requested-With': 'XMLHttpRequest',
  Cookie: session.cookies,
  Referer: `${BASE}/activity/search?locale=en-US`,
});

// ActiveNet category label -> our fallback bucket (the text mirror of the id-keyed
// `groups`, since detail records give the category by NAME, not id). classify() still
// reroutes camp/photo/arts/music titles on top, exactly as in the crawl path.
function fallbackForCatText(text) {
  const t = String(text || '');
  if (/camp/i.test(t)) return 'camps';
  if (/aquatic|waterfront/i.test(t)) return 'aquatics';
  // "Dance / Music / Performing Arts" must be tested before the arts bucket — its own
  // label contains "Arts" — so line dancing lands in dance, not arts.
  if (/dance|music|performing/i.test(t)) return 'dance';
  if (/craft|photograph|visual|digital|\barts?\b/i.test(t)) return 'arts';
  if (/after school|early childhood/i.test(t)) return 'youth';
  if (/sport|recreation|adaptive|outdoor/i.test(t)) return 'sports';
  if (/social|food|nutrition|personal|science|tech/i.test(t)) return 'social';
  if (/fitness|exercise|senior/i.test(t)) return 'fitness';
  return 'social';
}

// "N openings remaining" -> N; "Full" -> 0; "Unlimited"/blank -> null (unknown).
function spotsFromStatus(status) {
  const t = String(status || '');
  if (/full/i.test(t)) return { spots: 0, unlimited: false };
  const m = t.match(/(\d+)\s+opening/i);
  if (m) return { spots: Number(m[1]), unlimited: false };
  if (/unlimited/i.test(t)) return { spots: null, unlimited: true };
  return { spots: null, unlimited: false };
}

// Fetch one activity by id. Returns the detail object, or null for a non-existent id
// (HTTP 202) or an error. Backs off on WAF throttling (429/403).
async function fetchDetail(session, id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchT(`${BASE}/rest/activity/detail/${id}?locale=en-US`, { headers: detailHeaders(session) });
      if (res.status === 202) return null; // no such activity id
      if (res.status === 429 || res.status === 403) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()).body?.detail || null;
    } catch {
      await sleep(400);
    }
  }
  return null;
}

// Paged keyword search (list endpoint) — the only path that returns list items (with
// days_of_week + time_range) for browse-hidden-but-searchable activities.
async function fetchKeyword(session, keyword) {
  const out = [];
  let page = 1;
  let total = 1;
  do {
    const body = {
      activity_search_pattern: { activity_select_param: 2, activity_keyword: keyword, for_map: false },
      activity_transfer_pattern: {},
    };
    const res = await fetchT(`${BASE}/rest/activities/list?locale=en-US&page_number=${page}&total_records_per_page=50`, {
      method: 'POST',
      headers: { ...detailHeaders(session), 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const d = await res.json();
    out.push(...(d.body?.activity_items || []));
    total = d.headers?.page_info?.total_page || 1;
    page++;
  } while (page <= total && page <= 10);
  return out;
}

// Detail record (rest/activity/detail/<id>) -> our class row. Schedule and fee are
// seeded empty / placeholder and filled downstream (keywordSchedules, then the shared
// fillFeeDetails estimateprice pass), so backfilled rows converge on the same shape as
// crawl rows.
function detailToClass(d, coords) {
  const name = dehtml(d.activity_name);
  if (!name) return null;
  const center = d.centers?.[0]?.name || d.facilities?.[0]?.name || '';
  const location = cleanLoc(center);
  if (!location) return null;
  const category = classify(name, fallbackForCatText(d.category));
  const minAge = Number(d.age_min_year) || 0;
  const rawMax = Number(d.age_max_year) || 0;
  const maxAge = rawMax > 0 ? rawMax - 1 : null; // ActiveNet max is exclusive; store inclusive
  const { spots, unlimited } = spotsFromStatus(d.space_status);
  const dropIn = !!d.allow_drop_in_reg || /drop-?in/i.test(name) || unlimited;
  const c = coords.coordsFor(center);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(d.first_date || '') ? d.first_date : null;
  const end = /^\d{4}-\d{2}-\d{2}$/.test(d.last_date || '') ? d.last_date : null;
  const oneDay = !!(start && end && start === end);
  const instr = d.instructors?.[0];
  const instrName = instr ? dehtml([instr.first_name, instr.last_name].filter(Boolean).join(' ')) : '';
  const instructor = /^(unspecified|n\/?a|tbd)$/i.test(instrName) ? '' : instrName;
  const desc = stripHtml(d.catalog_description);
  const tags = tagsFor(name, category);
  return {
    id: `anc-${d.activity_id}`,
    name,
    category,
    ...(tags.length ? { tags } : {}),
    location,
    when: '', // recovered by keywordSchedules when the activity is searchable
    dropIn,
    cost: 'See site', // resolved by the shared fillFeeDetails (estimateprice) pass
    ages: dehtml(d.age_description || '').replace(/,\s*$/, '') || 'All ages',
    minAge,
    ...(maxAge != null ? { maxAge } : {}),
    spots,
    unlimited,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(oneDay ? { oneDay: true } : {}),
    ...(instructor ? { instructor } : {}),
    ...(desc ? { desc } : {}),
    ...(c ? { lat: c.lat, lng: c.lng } : {}),
    url: `${BASE}/activity/detail/${d.activity_id}?locale=en-US`,
  };
}

// Recover the weekly schedule (and precise fee/openings) for backfilled rows: one
// keyword search per distinct activity name, indexed by id. Searchable-but-hidden
// activities (most of them) get a real `when`; fully-unlisted ones keep the date-range
// fallback. Returns the count of rows that gained a schedule.
async function keywordSchedules(session, rows) {
  const names = [...new Set(rows.map((r) => r.name))];
  const byId = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < names.length) {
      const name = names[cursor++];
      try {
        for (const it of await fetchKeyword(session, name.slice(0, 60))) byId.set(it.id, it);
      } catch {
        // leave rows with the date-range fallback
      }
      await sleep(60);
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONC }, worker));
  let filled = 0;
  for (const r of rows) {
    const it = byId.get(Number(r.id.replace(/^anc-/, '')));
    if (!it) continue;
    const when = [cleanDays(it.days_of_week), it.time_range].filter(Boolean).join(' · ');
    if (when) {
      r.when = when;
      filled++;
    }
    const fee = cleanFee(it.fee);
    if (/\d/.test(fee) || /free/i.test(fee)) r.cost = fee; // real price beats the placeholder
    const openingsRaw = String(it.openings ?? '');
    if (/unlimited/i.test(openingsRaw)) {
      r.unlimited = true;
      r.spots = null;
    } else {
      const n = parseInt(openingsRaw, 10);
      if (Number.isFinite(n)) r.spots = n;
    }
  }
  return filled;
}

// Load the persisted skip list and decide whether this run does a full rescan (cache
// missing or older than PASS2_FULL_RESCAN_DAYS) or an incremental one (skip the known
// dead/ended ids). Returns { full, skip:Set<number>, builtAt }.
function loadPass2Cache() {
  try {
    const c = JSON.parse(fs.readFileSync(PASS2_CACHE_FILE, 'utf8'));
    const ageDays = (Date.now() - new Date(c.builtAt).getTime()) / 86400000;
    if (!Array.isArray(c.skip) || !(ageDays < PASS2_FULL_RESCAN_DAYS)) return { full: true, skip: new Set() };
    return { full: false, skip: new Set(c.skip), builtAt: c.builtAt };
  } catch {
    return { full: true, skip: new Set() };
  }
}

// Scan the live id window for current activities the category crawl couldn't see.
// `crawlRows` are the crawl's rows (their ids define the window and the dedupe set).
// A committed skip-cache lets the frequent (6h) refresh skip the stable dead/ended ids
// and only re-probe current + newly-created ids; a weekly full rescan refreshes it.
async function backfillHidden(session, coords, crawlRows) {
  const seen = new Set(crawlRows.map((r) => Number(String(r.id).replace(/^anc-/, ''))).filter(Number.isFinite));
  if (!seen.size) return [];
  const lo = Math.min(...seen) - ID_PAD_LOW;
  const hi = Math.max(...seen) + ID_PAD_HIGH;
  const cache = loadPass2Cache();
  const ids = [];
  for (let i = lo; i <= hi && ids.length < ID_SCAN_CAP; i++) {
    if (!seen.has(i) && !cache.skip.has(i)) ids.push(i);
  }
  console.log(
    `  pass 2: id-scanning ${ids.length} ids (${lo}–${hi}) — ${cache.full ? 'full rescan' : `incremental, skipping ${cache.skip.size} known dead/ended`}…`
  );

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  const doneIds = []; // dead (202) or ended — add to the skip list for next run
  let cursor = 0;
  let exists = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const d = await fetchDetail(session, id);
      if (!d) {
        doneIds.push(id); // no such activity id (202) — stably dead
        continue;
      }
      exists++;
      const current = d.last_date && d.last_date >= today;
      const real = d.activity_type === 'Activity' && !d.is_package && !d.is_parent_activity;
      const alive = !DEAD_STATUS.test(d.space_status || '');
      if (!current) doneIds.push(id); // ended — never re-opens, safe to skip henceforth
      if (!current || !real || !alive) continue;
      const row = detailToClass(d, coords);
      if (row && !MAP_SPORT_DROPIN_RE.test(row.name)) rows.push(row);
      await sleep(20);
    }
  }
  await Promise.all(Array.from({ length: DETAIL_CONC }, worker));
  const filled = await keywordSchedules(session, rows);

  // Persist the skip list: carry the prior skips still inside the window (incremental
  // runs) plus everything proven dead/ended this run. builtAt marks the last FULL
  // rescan, so the weekly cadence re-verifies while the 6h cadence stays incremental.
  const nextSkip = new Set(doneIds.filter((i) => i >= lo && i <= hi));
  if (!cache.full) for (const i of cache.skip) if (i >= lo && i <= hi) nextSkip.add(i);
  try {
    fs.writeFileSync(
      PASS2_CACHE_FILE,
      JSON.stringify({ builtAt: cache.full ? new Date().toISOString() : cache.builtAt, skip: [...nextSkip].sort((a, b) => a - b) }) + '\n'
    );
  } catch {
    // non-fatal: next run just does more work
  }
  console.log(`  pass 2: ${exists} ids exist, ${rows.length} current hidden activities recovered (${filled} with schedule)`);
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
// Each class: { id, name, category, location, when, dropIn, cost, ages, minAge, maxAge?, spots,
// unlimited, noOnlineReg?, start?, end?, oneDay?, instructor?, desc?, lat?, lng?,
// url, name_zh?, name_es? }. start/end are the course term (ISO YYYY-MM-DD) — a registered course
// enrolls for the whole range, not one session; oneDay marks a single-date activity.
// lat/lng are
// present when the rec center matched our court data (for distance filtering);
// name_zh/name_es are bundled translations of the title (absent if untranslated);
// spots is the open-spot count from ActiveNet openings (0 = full, null = unknown),
// unlimited = no-cap drop-in; noOnlineReg = free walk-in with no online registration;
// desc is the catalog blurb (absent when the source has none); minAge/maxAge drive the
// age filters (maxAge omitted = no upper bound — an adult can attend).

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

  // Drop pool drop-in sessions (covered by the Pools tab) regardless of source.
  const beforePool = classes.length;
  classes = classes.filter((c) => !isPoolDropIn(c));
  if (classes.length < beforePool) {
    console.log(`  ⊘ dropped ${beforePool - classes.length} pool drop-in(s) — covered by the Pools tab`);
  }

  // Pre-translate titles (shared helper; cached, key-optional — see scripts/lib).
  await applyTranslations(classes, {
    cacheFile: I18N_CACHE_FILE,
    contextLine: 'San Francisco Rec & Park drop-in class titles',
  });

  fs.writeFileSync(OUT_FILE, render(classes, new Date().toISOString()));
  console.log(`\n✅ Wrote ${classes.length} classes to data/classes.js (${source})`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Failed:', e.message);
    process.exit(1);
  });
} else {
  // Exported for tests/tooling (e.g. validating the pass-2 backfill on a small window).
  module.exports = { getSession, buildCoords, backfillHidden, detailToClass, fetchDetail, keywordSchedules };
}
