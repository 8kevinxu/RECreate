#!/usr/bin/env node
/*
 * Build data/pools.js — SF Rec & Park public swimming pools + their weekly swim
 * schedules. Run with:  npm run build:pools
 *
 * Why this looks different from the other builds: the pools' schedules don't live
 * in an API or an HTML table — each pool posts a *seasonal PDF* (re-issued every
 * few months) on its facility page. So the pipeline is:
 *   1. For each known pool (stable facility id), GET its sfrecpark.org page and
 *      find the current schedule PDF link(s) (text-labeled DocumentCenter docs,
 *      excluding the shared deck-rules PDFs).
 *   2. Download each PDF and pull positioned text via pdfjs-dist.
 *   3. Reconstruct the weekly grid geometrically: merge text fragments into row
 *      cells, map cells to day columns by x, pair each activity label with the
 *      time below it, and classify the label into a session `kind`.
 *   4. Emit sessions[dow] = [{ kind, start, end }] (0=Sun..6=Sat, minutes from
 *      midnight — same convention as the court schedule data).
 *
 * Coordinates, addresses and phones come from the curated META table below (the
 * facility pages don't expose lat/lng, and there are only nine pools). Fees are
 * a single city-wide schedule (POOL_FEES) refreshed by hand from the aquatics
 * fee notice — they change ~annually, not seasonally.
 *
 * Resilience mirrors the other builds: live -> last-good cache (pools-cache.json);
 * a fetch/parse failure (or a suspiciously empty result) keeps the existing data.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');

const BASE = 'https://sfrecpark.org';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_FILE = path.join(__dirname, 'pools-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'pools.js');
const MIN_OK_POOLS = 7; // abort (keep last-good) if fewer than this scrape with sessions
const DECK_RULES = new Set(['/DocumentCenter/View/19018', '/DocumentCenter/View/19019', '/DocumentCenter/View/19020']);

// Curated facts per pool. `slug` is the stable sfrecpark facility path; the
// schedule PDF link is discovered live from that page each run. Coords were
// geocoded once (pages have no lat/lng); addresses/phones are hand-verified.
const META = [
  { id: 'pool-balboa', slug: 'Balboa-Pool-212', name: 'Balboa Pool', address: 'San Jose Ave & Havelock St, San Francisco, CA 94112', lat: 37.726134, lng: -122.443381, phone: '(415) 831-6805', season: 'Jun 9 – Aug 15' },
  { id: 'pool-coffman', slug: 'Coffman-Pool-213', name: 'Coffman Pool', address: '1701 Visitacion Ave, San Francisco, CA 94134', lat: 37.713221, lng: -122.4158, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-garfield', slug: 'Garfield-Pool-214', name: 'Garfield Pool', address: '1271 Treat Ave, San Francisco, CA 94110', lat: 37.750098, lng: -122.412027, phone: '(628) 652-7221', season: 'Jun 7 – Aug 13' },
  { id: 'pool-hamilton', slug: 'Hamilton-Pool-215', name: 'Hamilton Pool', address: '1900 Geary Blvd, San Francisco, CA 94115', lat: 37.784566, lng: -122.435086, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-mlk', slug: 'Martin-Luther-King-Jr-Pool-216', name: 'Martin Luther King Jr. Pool', address: '5701 3rd St, San Francisco, CA 94124', lat: 37.725545, lng: -122.393722, phone: '(415) 288-2807', season: 'Jun 9 – Aug 15' },
  { id: 'pool-mission', slug: 'Mission-Community-Pool-217', name: 'Mission Community Pool', address: '1 Linda St, San Francisco, CA 94110', lat: 37.759653, lng: -122.422606, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-northbeach', slug: 'North-Beach-Pool-218', name: 'North Beach Pool', address: '661 Lombard St, San Francisco, CA 94133', lat: 37.802705, lng: -122.412437, phone: null, season: 'Jun 6 – Aug 10', note: 'Two pools under one roof: a warm pool and a cool pool.' },
  { id: 'pool-rossi', slug: 'Rossi-Pool-219', name: 'Rossi Pool', address: '600 Arguello Blvd, San Francisco, CA 94118', lat: 37.779065, lng: -122.45828, phone: '(628) 652-7230', season: 'Jun 7 – Aug 13' },
  { id: 'pool-sava', slug: 'Sava-Pool-220', name: 'Sava Pool', address: '1149 Wawona St (19th Ave), San Francisco, CA 94116', lat: 37.737803, lng: -122.475897, phone: null, season: 'Jun 30 – Aug 15' },
];

// City-wide aquatics fees (sfrecpark.org/DocumentCenter/View/29318). Update by
// hand when the annual fee notice changes — they're not seasonal.
const FEES = {
  effective: '2026-07-01',
  source: `${BASE}/DocumentCenter/View/29318`,
  note: 'FY26-27 CPI +2.18%',
  groups: [
    { id: 'child', label: 'Children (0–17)', dropIn: 2, passes: [['Monthly (no lessons)', 27], ['Summer pass', 34], ['Yearly swim pass', 285]] },
    { id: 'adult', label: 'Adults (18–64)', dropIn: 8, passes: [['Rec swim – 10 visits', 76], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 101], ['Monthly (no lessons)', 111], ['Yearly swim pass', 1007]] },
    { id: 'senior', label: 'Seniors (65+)', dropIn: 7, passes: [['Rec swim – 10 visits', 35], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 52], ['Monthly (no lessons)', 59], ['Yearly swim pass', 672]] },
    { id: 'medical', label: 'Economic need (Medi-Cal)', dropIn: 7, passes: [['Rec swim – 10 visits', 35], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 52], ['Monthly (no lessons)', 62], ['Yearly swim pass', 672]] },
  ],
};

// All-pool closures (from the PDFs' notes). Update per year.
const CLOSURES = [
  { date: '2026-06-19', label: 'Juneteenth' },
  { date: '2026-07-04', label: 'Independence Day' },
];

const KIND_ORDER = ['lap', 'family', 'senior', 'lessons', 'adult_lessons', 'parent_child', 'exercise', 'camp', 'rental', 'other'];

// ---- PDF schedule parsing -------------------------------------------------

const DOW = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 };
const TIME = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*[-–]\s*((\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)|noon)/i;
const KINDS = [
  [/parent\s*(&|and)?\s*tot|piranha|parent.?child/i, 'parent_child'],
  [/adult\s*(swim\s*)?lesson/i, 'adult_lessons'],
  [/learn\s*to\s*swim|\blts\b|swim\s*lesson|youth\s*lesson|pre-?school|swim\s*team|youth\s*team|special\s*olympic/i, 'lessons'],
  [/water\s*exercise|self.?guided|deep\s*water/i, 'exercise'],
  [/senior|therapy/i, 'senior'],
  [/rec\/?family|family|recreation|rec\s*swim/i, 'family'],
  [/lap/i, 'lap'],
  [/rental|masters|synchro|hockey/i, 'rental'],
  [/sfrpd|camp/i, 'camp'],
];
const kindOf = (s) => {
  for (const [re, k] of KINDS) if (re.test(s)) return k;
  return 'other';
};
// Cells that are notes/legend/footer, not activity labels.
const isNote = (s) =>
  /^\(|notes?:|pool info|^_+$|^•|lanes?\)$|^\(shallow|^\(deep|^\(main|^\(small|^\(water|^\(1 |^\(advanced|^\(beg|temperature|@|\.org|francisco|\bave\b|\bblvd\b|\bstreet\b|treat|geary|lombard|arguello|wawona/i.test(s) ||
  s.length < 3;

const toMin = (h, m, ap, nextAp) => {
  h = +h;
  m = m ? +m : 0;
  ap = (ap || '').replace(/\./g, '').toLowerCase();
  if (!ap && nextAp) ap = nextAp;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + m;
};
function parseTime(s) {
  s = s.replace(/\bnoon\b/i, '12:00pm');
  const m = s.match(TIME);
  if (!m) return null;
  const endAp = (m[7] || '').replace(/\./g, '').toLowerCase() || (/noon/i.test(m[4]) ? 'pm' : '');
  let start = toMin(m[1], m[2], m[3], endAp);
  let end = toMin(m[5] || 12, m[6], m[7] || '', endAp);
  // Borrowing the end's meridiem can invert a range that straddles noon
  // ("11:30–12:30 PM" must not read as 11:30 PM), and a 12:xx end after an
  // AM start is PM even when the PDF says otherwise. Prefer the reading that
  // makes the session run forward.
  if (end <= start) {
    if (!m[3] && start >= 720 && start - 720 < end) start -= 720;
    else if (end + 720 > start && end + 720 <= 1440) end += 720;
  }
  return end > start ? { start, end } : null;
}

// Merge per-glyph text fragments on the same line into row cells (dropping the
// right-side notes panel at x>760), so split words/times become whole strings.
function mergeRows(items) {
  const rows = [];
  items
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .forEach((it) => {
      let r = rows.find((r) => Math.abs(r.y - it.y) <= 4);
      if (!r) {
        r = { y: it.y, its: [] };
        rows.push(r);
      }
      r.its.push(it);
    });
  return rows.map((r) => {
    r.its.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    let lastEnd = null;
    for (const it of r.its) {
      if (cur && it.x - lastEnd < 45) cur.s += (it.x - lastEnd > 8 ? ' ' : '') + it.s;
      else {
        cur = { x: it.x, s: it.s };
        cells.push(cur);
      }
      lastEnd = it.x + it.s.length * 5.5;
    }
    return { y: r.y, cells: cells.filter((c) => c.x < 760) };
  });
}

// One PDF's positioned text -> { dow: [{kind,start,end}] }.
function parseGrid(items) {
  const rows = mergeRows(items);
  const dkey = (s) => DOW[s.toUpperCase().replace(/[^A-Z]/g, '')];
  const hdr = rows.find((r) => r.cells.filter((c) => dkey(c.s) !== undefined).length >= 2);
  if (!hdr) return null;
  const cols = hdr.cells
    .filter((c) => dkey(c.s) !== undefined)
    .map((c) => ({ dow: dkey(c.s), x: c.x }))
    .sort((a, b) => a.x - b.x);
  const colOf = (x) => {
    let best = null;
    let bd = 80;
    for (const c of cols) {
      const d = Math.abs(c.x - x);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  const body = rows.filter((r) => r.y < hdr.y - 6);
  const perCol = {};
  cols.forEach((c) => (perCol[c.dow] = []));
  for (const r of body)
    for (const cell of r.cells) {
      const c = colOf(cell.x);
      if (c) perCol[c.dow].push({ y: r.y, s: cell.s });
    }
  const out = {};
  for (const c of cols) {
    const cells = perCol[c.dow].sort((a, b) => b.y - a.y);
    const sess = [];
    let buf = [];
    for (const cell of cells) {
      const t = parseTime(cell.s);
      if (t) {
        const inline = cell.s.replace(TIME, '').replace(/noon/gi, '').trim();
        const labels = [...buf.map((b) => b.s), inline].filter((x) => x && !isNote(x));
        for (const L of [...new Set(labels)]) sess.push({ kind: kindOf(L), start: t.start, end: t.end });
        buf = [];
      } else buf.push({ s: cell.s });
    }
    const seen = new Set();
    out[c.dow] = sess
      .filter((s) => {
        // A session that runs backwards or longer than 10h is a misparse of the
        // PDF grid — publish nothing rather than a wrong time.
        if (s.end <= s.start || s.end - s.start > 600) {
          console.warn(`    ⚠ dropping implausible session dow=${c.dow} ${s.kind} ${s.start}–${s.end}`);
          return false;
        }
        const k = s.kind + s.start + s.end;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.start - b.start);
  }
  return out;
}

// ---- Scraping -------------------------------------------------------------

// Site-wide boilerplate that appears on every facility page (department blurb,
// contact/accessibility footer, share widget), funding minutiae, dated
// announcement letters ("Dear Swimmers…"), and the "offers lap swim, …" line
// that just duplicates the card's program chips. Footer phrases are matched
// precisely — a pool's real blurb may legitimately mention accessibility.
const DESC_SKIP =
  /SocialShare|\$\(document\)|Department manages|10-minute walk|Main Office|committed to ensuring|accessibility barrier|WCAG|Human Resources|Language Access|reasonable effort|offers lap swim|funded by|GO Bond|Impact Fee|^Dear\b|excited to announce/i;

// The facility page's own paragraph about this pool (renovation, layout,
// amenities) — the only per-pool description SFRP publishes anywhere. First
// substantial paragraph that isn't boilerplate wins; null when a page has none.
function pageDesc($) {
  let best = null;
  $('p').each((_, p) => {
    if (best) return;
    const t = $(p).text().replace(/\s+/g, ' ').trim();
    if (t.length < 80 || DESC_SKIP.test(t)) return;
    best = t.length > 340 ? t.slice(0, 337).replace(/\s+\S*$/, '') + '…' : t;
  });
  return best;
}

async function fetchFacilityPage(slug) {
  const cheerio = require('cheerio');
  const html = await (await fetchT(`${BASE}/Facilities/Facility/Details/${slug}`, { headers: { 'User-Agent': UA } })).text();
  const $ = cheerio.load(html);
  const docs = [];
  $('a[href*="/DocumentCenter/View/"]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    const rel = href.replace(BASE, '');
    if (href && text && !DECK_RULES.has(rel) && !docs.find((d) => d.url.endsWith(rel))) {
      docs.push({ label: text, url: href.startsWith('http') ? href : BASE + href });
    }
  });
  return { docs, desc: pageDesc($) };
}

async function pdfItems(url) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = Buffer.from(await (await fetchT(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return tc.items
    .filter((i) => i.str.trim())
    .map((i) => ({ x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), s: i.str.trim() }));
}

async function scrapePool(m) {
  const { docs: scheduleUrls, desc } = await fetchFacilityPage(m.slug);
  // A facility with separate warm-pool and cool-pool PDFs (North Beach) gets each
  // session tagged with which pool runs it, so the app can show the two schedules
  // separately. Single-PDF pools stay untagged (no `pool` field).
  const poolTag = (label) => (/warm/i.test(label) ? 'warm' : /cool/i.test(label) ? 'cool' : null);
  const tags = new Set(scheduleUrls.map((d) => poolTag(d.label)).filter(Boolean));
  const tagPdfs = tags.has('warm') && tags.has('cool');
  const week = [[], [], [], [], [], [], []];
  const seen = week.map(() => new Set());
  for (const d of scheduleUrls) {
    const tag = tagPdfs ? poolTag(d.label) : null;
    const grid = parseGrid(await pdfItems(d.url)) || {};
    for (const dow of Object.keys(grid))
      for (const s of grid[dow]) {
        const k = (tag || '') + s.kind + s.start + s.end;
        if (!seen[dow].has(k)) {
          seen[dow].add(k);
          week[dow].push(tag ? { ...s, pool: tag } : s);
        }
      }
  }
  week.forEach((a) => a.sort((x, y) => x.start - y.start || x.kind.localeCompare(y.kind)));
  const kinds = new Set(week.flat().map((s) => s.kind));
  return {
    id: m.id,
    name: m.name,
    address: m.address,
    lat: m.lat,
    lng: m.lng,
    phone: m.phone,
    season: m.season,
    ...(m.note ? { note: m.note } : {}),
    ...(desc ? { desc } : {}),
    programs: KIND_ORDER.filter((k) => kinds.has(k)),
    scheduleUrls,
    sessions: week,
  };
}

// ---- Output ---------------------------------------------------------------

function render(pools) {
  return `// AUTO-GENERATED by scripts/build-pools.js — do not edit by hand.
// Regenerate with: npm run build:pools
// Generated: ${new Date().toISOString()}
//
// SF Rec & Park public swimming pools, scraped from sfrecpark.org. Each pool's
// weekly schedule is parsed from its seasonal PDF (the authoritative source —
// see scheduleUrls). sessions[dow] = array of { kind, start, end } where dow is
// 0=Sun..6=Sat and start/end are minutes-from-midnight. kind is one of
// POOL_SESSION_KINDS; the app renders a localized label per kind. A facility
// with separate warm-/cool-pool PDFs (North Beach) also tags each session with
// pool: "warm" | "cool" so the two schedules render separately. Schedules are
// seasonal (see \`season\`) and the build refreshes them when SFRP posts new PDFs.

export const POOL_SESSION_KINDS = ${JSON.stringify(KIND_ORDER)};

export const POOL_FEES = ${JSON.stringify(FEES, null, 2)};

export const POOL_CLOSURES = ${JSON.stringify(CLOSURES)};

export const POOLS = [
${pools.map((p) => '  ' + JSON.stringify(p)).join(',\n')}
];

export default POOLS;
`;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  console.log('Fetching SF Rec & Park pool schedules…');
  let pools;
  let source;
  try {
    pools = [];
    for (const m of META) {
      const p = await scrapePool(m);
      const n = p.sessions.flat().length;
      console.log(`  ${p.name}: ${p.scheduleUrls.length} pdf(s), ${n} sessions`);
      pools.push(p);
    }
    const withSessions = pools.filter((p) => p.sessions.flat().length > 0).length;
    if (withSessions < MIN_OK_POOLS) {
      throw new Error(`only ${withSessions} pools parsed sessions (min ${MIN_OK_POOLS}) — PDF layout may have changed`);
    }
    source = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ pools, fees: FEES, closures: CLOSURES, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.pools) throw new Error(`fetch failed (${e.message}) and no cache — data/pools.js left unchanged`);
    pools = cache.pools;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.writeFileSync(OUT_FILE, render(pools));
  console.log(`\n✅ Wrote ${pools.length} pools to data/pools.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
