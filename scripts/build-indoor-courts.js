#!/usr/bin/env node
/*
 * Build data/courts.js — SF Recreation & Parks recreation centers that have an
 * INDOOR basketball gym. Run with:  npm run build:courts
 *
 * Sources combined:
 *   1. Which rec centers have an indoor gym, facility hours, and the curated
 *      fallback open-gym blocks — the CENTERS table below.
 *   2. Exact coordinates / address / neighborhood — DataSF "Recreation and Parks
 *      Facilities" dataset (ib5c-xgwu), by property name.
 *   3. LIVE basketball open-gym schedules — scraped each run from the Gymnasium
 *      row of each center's sfrecpark.org facility page (see FID map + parser).
 *
 * Resilience: each center falls back live-scrape -> last-good cache -> curated
 * blocks. A validation gate aborts the whole run (keeping the existing
 * data/courts.js) if too few centers scrape successfully, so a site redesign
 * can't silently publish empty schedules.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const CACHE_FILE = path.join(__dirname, 'schedule-cache.json');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Abort (keep last-good courts.js) if fewer than this many centers scrape live.
const MIN_LIVE_OK = 10;

const DATASF =
  'https://data.sfgov.org/resource/ib5c-xgwu.json?' +
  "$select=property_name,facility_type,address,analysis_neighborhood,latitude,longitude&" +
  "$where=facility_type in('Rec Center','Fieldhouse','Rec Center/Pool')&$limit=200";

// Weekday order matches JS Date.getDay(): 0=Sun..6=Sat.
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const time = (h, m = 0) => h * 60 + m;

// Build a 7-slot schedule from a {day:[openH, closeH]} spec; missing = closed.
function schedule(spec) {
  const out = [null, null, null, null, null, null, null];
  for (const [day, [o, c]] of Object.entries(spec)) {
    out[DAY_INDEX[day]] = [time(o), time(c)];
  }
  return out;
}

// Common SF Rec & Park pattern: Tue–Fri + Sat, closed Mon/Sun.
const tueFriSat = (oWk, cWk) =>
  schedule({
    tue: [oWk, cWk],
    wed: [oWk, cWk],
    thu: [oWk, cWk],
    fri: [oWk, cWk],
    sat: [9, 17],
  });

// Basketball open-gym blocks: a {day: [[startMin,endMin], ...]} spec into a
// 7-slot array (0=Sun..6=Sat) where each slot is an array of time blocks.
// Times below are the CURRENT (summer 2026) drop-in basketball schedules
// scraped from each center's sfrecpark.org facility page.
function bball(spec) {
  const out = [[], [], [], [], [], [], []];
  for (const [day, blocks] of Object.entries(spec)) out[DAY_INDEX[day]] = blocks;
  return out;
}
const t = time; // shorthand for blocks below

// Some centers run a sport continuously whenever they're open but don't publish
// it as timed open-gym rows online (e.g. Palega's ping pong). Turn the facility
// `schedule[]` into a one-block-per-open-day drop-in week so the sport is shown
// across all open hours. Stays correct automatically if the hours change.
const allOpenHoursWeek = (sched) => sched.map((h) => (h ? [[h[0], h[1]]] : []));

// Verified indoor-basketball rec centers. `prop` matches DataSF property_name.
const CENTERS = [
  {
    prop: 'Mission Rec Center',
    name: 'Mission Recreation Center',
    sched: schedule({ tue: [9, 21], wed: [9, 21], thu: [9, 21], fri: [9, 21], sat: [9, 17] }),
    bball: bball({}), // facility page erroring online — open-gym schedule unavailable
    notes: 'Indoor gymnasium for basketball, volleyball, or indoor soccer. Open-gym schedule unavailable online — check sfrecpark.org.',
  },
  {
    prop: 'Moscone Rec Center',
    name: 'Moscone Recreation Center',
    sched: tueFriSat(10, 20),
    bball: bball({
      tue: [[t(15, 30), t(17)]],
      wed: [[t(13), t(14)]],
      thu: [[t(15, 30), t(17)]],
      fri: [[t(13), t(14)]],
      sat: [[t(13), t(16, 30)]],
    }),
    notes: 'Locals shoot hoops in the indoor basketball gym.',
  },
  {
    prop: "St. Mary's Rec Center",
    name: "St. Mary's Recreation Center",
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(17, 30), t(21, 30)]],
      fri: [[t(17, 30), t(21, 30)]],
      sat: [[t(9), t(17)]],
    }),
    notes: 'Gymnasium with indoor basketball.',
  },
  {
    prop: 'Upper Noe Rec Center',
    name: 'Upper Noe Recreation Center',
    sched: schedule({ tue: [9, 21], wed: [9, 21], thu: [9, 21], fri: [9, 21], sat: [9, 17] }),
    bball: bball({ sat: [[t(9), t(12)]] }),
    notes: 'Full-size indoor gym.',
  },
  {
    prop: 'Hamilton Rec Center',
    name: 'Hamilton Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(15, 30), t(20, 30)]],
      wed: [[t(15, 30), t(20, 30)]],
      thu: [[t(15, 30), t(20, 30)]],
      fri: [[t(15, 30), t(20, 30)]],
      sat: [[t(9, 30), t(16, 30)]],
    }),
    notes: 'Gymnasium with basketball open gym for all ages.',
  },
  {
    prop: 'Eureka Valley Rec Center',
    name: 'Eureka Valley Recreation Center',
    sched: tueFriSat(9, 20),
    bball: bball({ tue: [[t(9), t(11)], [t(18), t(20)]], thu: [[t(9), t(11)]] }),
    notes: 'Play a game of basketball inside; gym with drop-in hours.',
  },
  {
    prop: 'Eugene Friend Rec Center',
    name: 'Gene Friend Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({}), // facility page erroring — likely renovation
    notes: 'Gymnasium with basketball. Facility page is offline (renovation) — verify hours and open gym at sfrecpark.org.',
  },
  {
    prop: 'Richmond Rec Center',
    name: 'Richmond Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(18), t(23, 45)]],
      wed: [[t(14, 45), t(20, 45)]],
      thu: [[t(13, 45), t(17, 30)]],
      fri: [[t(14, 45), t(20, 45)]],
      sat: [[t(13, 45), t(16, 30)]],
    }),
    notes: 'Gymnasium with basketball open gym.',
  },
  {
    prop: 'Sunset Rec Center',
    name: 'Sunset Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({ thu: [[t(17, 30), t(21)]], fri: [[t(17, 30), t(21)]] }),
    notes: 'Gymnasium with basketball.',
  },
  {
    prop: 'Palega Playground',
    name: 'Palega Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(10), t(16)]],
      wed: [[t(10), t(16)]],
      thu: [[t(10), t(16)], [t(12), t(15, 30)]],
      fri: [[t(10), t(16)]],
      sat: [[t(9), t(10)], [t(10), t(11)], [t(11, 30), t(12, 30)]],
    }),
    // Ping pong runs all open hours but isn't listed on sfrecpark.org — curate it.
    pingpongAllHours: true,
    notes: 'Indoor gymnasium (also has outdoor courts). Drop-in ping pong runs all open hours.',
  },
  {
    prop: 'Joseph Lee Rec Center',
    name: 'Joseph Lee Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(10), t(17)]],
      wed: [[t(10), t(18)], [t(18), t(20)]],
      thu: [[t(10), t(17)]],
      fri: [[t(10), t(20)]],
      sat: [[t(14), t(16, 30)]],
    }),
    notes: 'Gymnasium — play basketball, ping-pong, tetherball or air hockey.',
  },
  {
    prop: 'Minnie and Lovie Rec Center',
    name: 'Minnie & Lovie Ward Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      wed: [[t(18, 45), t(20, 45)]],
      thu: [[t(16), t(18, 15)]],
      fri: [[t(16), t(20, 45)]],
      sat: [[t(10, 30), t(12, 30)], [t(12, 45), t(16, 45)]],
    }),
    notes: 'Gymnasium, auditorium, multipurpose rooms; basketball drop-in.',
  },
  {
    prop: 'Bernal Heights Rec Center',
    name: 'Bernal Heights Recreation Center',
    sched: tueFriSat(10, 20),
    bball: bball({
      tue: [[t(13), t(19, 45)]],
      wed: [[t(10), t(18)], [t(18), t(20)]],
      thu: [[t(13), t(19, 45)]],
      fri: [[t(10), t(19, 45)]],
      sat: [[t(10, 15), t(16, 45)]],
    }),
    notes: 'Clubhouse and gym with basketball. Closes 2–5pm daily for after-school programs.',
  },
  {
    prop: 'Betty Ann Ong Chinese Rec Center',
    name: 'Betty Ann Ong Recreation Center',
    sched: schedule({ mon: [14, 18], tue: [10, 21], wed: [10, 21], thu: [10, 21], fri: [10, 21], sat: [9, 17] }),
    bball: bball({
      tue: [[t(10), t(15, 30)]],
      wed: [[t(10), t(14)]],
      thu: [[t(10), t(20, 30)]],
      fri: [[t(16), t(20, 30)]],
      sat: [[t(9), t(13)]],
    }),
    notes: 'Gymnasium with basketball open gym.',
  },
  {
    prop: 'Glen Canyon Park',
    name: 'Glen Park Recreation Center',
    sched: tueFriSat(10, 21),
    bball: bball({
      tue: [[t(11, 30), t(18)]],
      wed: [[t(16), t(18)]],
      thu: [[t(16), t(19, 30)]],
      fri: [[t(12, 30), t(15)]],
      sat: [[t(12, 30), t(15)], [t(15), t(18), 'wheelchair']], // 3–6pm = wheelchair
    }),
    notes: 'Open gym for pickup basketball; Sat afternoon includes wheelchair basketball.',
  },
  {
    prop: 'Herz Playground',
    name: 'Herz Recreation Center',
    sched: schedule({ mon: [14, 18], tue: [10, 21], wed: [10, 21], thu: [10, 21], fri: [10, 21], sat: [9, 17] }),
    bball: bball({
      tue: [[t(14, 30), t(19, 45)]],
      wed: [[t(14, 30), t(20, 45)]],
      thu: [[t(14, 30), t(20, 45)]],
      fri: [[t(14, 30), t(20, 45)]],
      sat: [[t(9), t(16, 30)]],
    }),
    notes: 'New full-size indoor gym (bleacher seating for 200).',
  },
  {
    prop: 'Potrero Hill Rec Center',
    name: 'Potrero Hill Recreation Center',
    sched: schedule({ tue: [10, 20], wed: [10, 21], thu: [10, 21], fri: [10, 21], sat: [9, 17] }),
    bball: bball({
      tue: [[t(10), t(19, 30)]],
      wed: [[t(10), t(17)]],
      thu: [[t(10), t(17)]],
      fri: [[t(10), t(19, 30)]],
      sat: [[t(9), t(16, 30)]],
    }),
    notes: 'Full-size indoor basketball court with bleacher seating for 200.',
  },
];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// sfrecpark.org facility-page slugs (…/Facilities/Facility/Details/<slug>), keyed
// by center name. Used to scrape the live Gymnasium open-gym schedule.
const FID = {
  'Mission Recreation Center': 'Mission-Rec-Center-100',
  'Moscone Recreation Center': 'Moscone-Rec-Center-101',
  "St. Mary's Recreation Center": 'St-Marys-Rec-Center-109',
  'Upper Noe Recreation Center': 'Upper-Noe-Rec-Center-112',
  'Hamilton Recreation Center': 'Hamilton-Rec-Center-93',
  'Eureka Valley Recreation Center': 'Eureka-Valley-Rec-Center-86',
  'Gene Friend Recreation Center': 'Gene-Friend-Rec-Center-88',
  'Richmond Recreation Center': 'Richmond-Rec-Center-105',
  'Sunset Recreation Center': 'Sunset-Rec-Center-110',
  'Palega Recreation Center': 'Palega-Rec-Center-103',
  'Joseph Lee Recreation Center': 'Joseph-Lee-Rec-Center-95',
  'Minnie & Lovie Ward Recreation Center': 'Minnie-Love-Ward-Rec-Center-97',
  'Bernal Heights Recreation Center': 'Bernal-Heights-Rec-Center-83',
  'Betty Ann Ong Recreation Center': 'Betty-Ann-Ong-Recreation-Center-84',
  'Glen Park Recreation Center': 'Glen-Canyon-Park-Recreation-Center-89',
  'Herz Recreation Center': 'Herz-Recreation-Center-471',
  'Potrero Hill Recreation Center': 'Potrero-Hill-Rec-Center-275',
};

// ---- live schedule scraper -------------------------------------------------

// "10 a.m." | "11:30 a.m." | "4 p.m." | "12" (meridiem may be omitted on start)
function parseClock(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  return {
    h: +m[1],
    min: m[2] ? +m[2] : 0,
    mer: m[3] ? m[3].replace(/\./g, '').toLowerCase() : null,
  };
}
function toMin(c, mer) {
  let h = c.h % 12;
  if ((c.mer || mer) === 'pm') h += 12;
  return h * 60 + c.min;
}
// "12–3:30 p.m." -> [720, 930]; start inherits the end's a.m./p.m. when missing.
function parseRange(text) {
  const [a, b] = String(text).split(/[–—-]/).map((x) => x && x.trim());
  const A = parseClock(a || ''), B = parseClock(b || '');
  if (!A || !B) return null;
  const mer = B.mer || A.mer;
  const range = [toMin(A, mer), toMin(B, mer)];
  // Sanity: ordered and within a sane day window.
  if (range[0] >= range[1] || range[0] < 5 * 60 || range[1] > 24 * 60) return null;
  return range;
}

// Drop-in sports we pull from the Gymnasium row, in priority order (an item is
// matched to the first sport it mentions). Keep these in sync with lib/sports.js.
const SPORTS = [
  { id: 'basketball', match: /basketball/i },
  { id: 'volleyball', match: /volleyball/i },
  { id: 'pingpong', match: /table tennis|ping[\s-]?pong/i },
  { id: 'pickleball', match: /pickleball/i },
  // Not a sport — the rec-center weight/fitness room drop-in hours, surfaced on the
  // map as its own option (see lib/sports.js WEIGHT_ROOM). Lives in its own room row.
  { id: 'weightroom', match: /weight ?room|fitness (room|center)/i },
];
const emptyWeek = () => [[], [], [], [], [], [], []];
const emptyDropins = () => Object.fromEntries(SPORTS.map((s) => [s.id, emptyWeek()]));

// Restricted drop-in sessions carved out of general open gym. Returned as a
// block's optional third element (a tag string) and labeled in-app. Order
// matters — first match wins. Keep tag ids in sync with lib/hours.js.
function blockTag(activity) {
  if (/wheelchair/i.test(activity)) return 'wheelchair';
  if (/women|woman|ladies/i.test(activity)) return 'women';
  if (/55\s*(&|and|\+)|senior/i.test(activity)) return '55+';
  return null;
}

// Facility pages often list one continuous open gym as hourly rows (9–10, 10–11,
// …), sometimes with a short reset gap. Coalesce blocks into a single span when
// they're within this many minutes of each other — but only when they share the
// same tag, so a women's/wheelchair/55+ session never gets absorbed into general
// open gym.
const MERGE_GAP_MIN = 30;
function mergeBlocks(blocks) {
  const sorted = blocks.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const b of sorted) {
    const tag = b[2] || null;
    const prev = out[out.length - 1];
    if (prev && (prev[2] || null) === tag && b[0] - prev[1] <= MERGE_GAP_MIN) {
      prev[1] = Math.max(prev[1], b[1]);
    } else {
      out.push(tag ? [b[0], b[1], tag] : [b[0], b[1]]);
    }
  }
  return out;
}

// Parse drop-in blocks for every tracked sport from a facility page's HTML.
// Basketball/volleyball run in the Gymnasium, but table tennis lives in other
// rooms (Multi Purpose Room, Auditorium), so we scan every room row and match
// each activity to a sport. Returns { season, dropins: { sportId: [7][[s,e],...] },
// bballCount } (day index 0=Sun..6=Sat).
function parseGymDropins(html) {
  const $ = cheerio.load(html);
  const season = $('.schedule-title').first().text().trim();

  const table = $('table')
    .filter((_, el) => $(el).find('th[scope="col"]').length > 0)
    .first();
  const cols = table.find('th[scope="col"]').map((_, th) => $(th).text().trim()).get();
  const colDay = cols.map((name) => DAY_INDEX[name.slice(0, 3).toLowerCase()]);

  const dropins = emptyDropins();
  table.find('th[scope="row"]').each((_, th) => {
    $(th).closest('tr').find('td').each((i, td) => {
      const day = colDay[i + 1]; // cols[0] is "Facility / Room"; cells start at Monday
      if (day == null) return;
      $(td).find('.item').each((_, item) => {
        const activity = $(item).find('.activity').text();
        // Exclude structured programs — keep only show-up-and-play sessions.
        if (/league|class|clinic|camp|academy|practice|training|tournament/i.test(activity)) return;
        const sport = SPORTS.find((s) => s.match.test(activity));
        if (!sport) return;
        const range = parseRange($(item).find('.time').text());
        if (range) {
          // Tag restricted sessions (wheelchair / women's / 55+) for in-app labeling.
          const tag = blockTag(activity);
          if (tag) range.push(tag);
          dropins[sport.id][day].push(range);
        }
      });
    });
  });

  // Coalesce each day's hourly listing rows into continuous spans.
  for (const s of SPORTS) {
    for (let d = 0; d < 7; d++) dropins[s.id][d] = mergeBlocks(dropins[s.id][d]);
  }

  const bballCount = dropins.basketball.reduce((n, d) => n + d.length, 0);
  return { season, dropins, bballCount };
}

async function scrapeSchedule(fid) {
  const url = `https://sfrecpark.org/Facilities/Facility/Details/${fid}`;
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseGymDropins(await res.text());
  // Gate on basketball (broad coverage); volleyball/etc. are legitimately sparse.
  if (parsed.bballCount === 0) throw new Error('no gym basketball blocks found');
  return parsed;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  console.log('Fetching rec-center coordinates from DataSF…');
  const rows = await (await fetch(DATASF, {
    headers: { 'User-Agent': 'RECreateSF/1.0', Accept: '*/*' },
  })).json();

  // Lookup by property name; prefer a "Rec Center" row, else first with coords.
  const byProp = {};
  for (const r of rows) {
    if (!r.latitude || !r.longitude) continue;
    const cur = byProp[r.property_name];
    if (!cur || (cur.facility_type !== 'Rec Center' && r.facility_type === 'Rec Center')) {
      byProp[r.property_name] = r;
    }
  }

  // Scrape each center's live open-gym schedule (sequential = polite to the site).
  const cache = loadCache();
  const stats = { live: 0, cache: 0, curated: 0 };
  const seasons = new Set();
  console.log('Scraping live open-gym schedules from sfrecpark.org…');

  for (const c of CENTERS) {
    const fid = FID[c.name];
    // Curated fallback covers basketball only (hand-maintained); other sports
    // have no curated source, so they start empty unless scraped.
    let chosen = { dropins: { ...emptyDropins(), basketball: c.bball }, source: 'curated' };
    if (fid) {
      try {
        const live = await scrapeSchedule(fid);
        cache[fid] = { dropins: live.dropins, season: live.season, scrapedAt: new Date().toISOString() };
        chosen = { dropins: live.dropins, source: 'live' };
        const s = (live.season.match(/spring|summer|fall|autumn|winter/i) || [])[0];
        if (s) seasons.add(s[0].toUpperCase() + s.slice(1).toLowerCase());
        const counts = SPORTS.map((sp) => `${live.dropins[sp.id].reduce((n, d) => n + d.length, 0)} ${sp.id}`);
        console.log(`  ✓ ${c.name} — ${counts.join(', ')} (live)`);
      } catch (e) {
        // Old caches stored a bare `basketball` week; wrap it into dropins shape.
        const cached = cache[fid] && (cache[fid].dropins ||
          (cache[fid].basketball && { ...emptyDropins(), basketball: cache[fid].basketball }));
        if (cached) {
          chosen = { dropins: cached, source: 'cache' };
          console.log(`  ↺ ${c.name} — scrape failed (${e.message}); using cached`);
        } else {
          console.log(`  ⚠ ${c.name} — scrape failed (${e.message}); using curated fallback`);
        }
      }
    }
    stats[chosen.source]++;
    // Curated open-gym overrides for sports the city doesn't publish online.
    if (c.pingpongAllHours) {
      chosen.dropins = { ...chosen.dropins, pingpong: allOpenHoursWeek(c.sched) };
      console.log(`    + ${c.name} — curated ping pong across all open hours`);
    }
    c._dropins = chosen.dropins;
    c._scheduleSource = chosen.source;
  }

  // Validation gate: refuse to publish a mostly-empty scrape (e.g. site redesign).
  if (stats.live < MIN_LIVE_OK) {
    throw new Error(
      `Only ${stats.live}/${CENTERS.length} centers scraped live (min ${MIN_LIVE_OK}). ` +
        `Site markup may have changed — data/courts.js left unchanged.`
    );
  }

  const courts = CENTERS.map((c) => {
    const row = byProp[c.prop];
    if (!row) throw new Error(`No DataSF coordinates found for "${c.prop}"`);
    return {
      id: slug(c.name),
      name: c.name,
      address: row.address || '',
      neighborhood: row.analysis_neighborhood || '',
      lat: Number(Number(row.latitude).toFixed(6)),
      lng: Number(Number(row.longitude).toFixed(6)),
      indoor: true,
      hoops: 2,
      lights: true,
      schedule: c.sched,
      dropins: c._dropins,
      scheduleSource: c._scheduleSource,
      source: 'sfrecpark',
      notes: c.notes,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
  const season = [...seasons].join(' / ') || 'unknown';
  const generatedAt = new Date().toISOString();
  const dataDir = path.join(__dirname, '..', 'data');

  // Bundled module (offline fallback baked into the app).
  fs.writeFileSync(path.join(dataDir, 'courts.js'), render(courts, season, generatedAt));

  // Hostable JSON the app fetches at launch (committed + served via raw GitHub
  // / Pages; the cron keeps it fresh). Wrapped with metadata for a freshness UI.
  const payload = { generatedAt, season, courts };
  fs.writeFileSync(path.join(dataDir, 'courts.json'), JSON.stringify(payload, null, 2) + '\n');

  console.log(
    `\n✅ Wrote ${courts.length} courts to data/courts.js + data/courts.json` +
      `\n   open-gym schedules: ${stats.live} live, ${stats.cache} cached, ${stats.curated} curated fallback` +
      `\n   season: ${season}`
  );
}

function render(courts, season, generatedAt) {
  const body = courts
    .map(
      (c) => `  {
    id: ${JSON.stringify(c.id)},
    name: ${JSON.stringify(c.name)},
    address: ${JSON.stringify(c.address)},
    neighborhood: ${JSON.stringify(c.neighborhood)},
    lat: ${c.lat},
    lng: ${c.lng},
    indoor: true,
    hoops: ${c.hoops},
    lights: true,
    schedule: ${JSON.stringify(c.schedule)},
    dropins: ${JSON.stringify(c.dropins)},
    scheduleSource: ${JSON.stringify(c.scheduleSource)},
    source: "sfrecpark",
    notes: ${JSON.stringify(c.notes)},
  },`
    )
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-indoor-courts.js — do not edit by hand.
// Regenerate with: npm run build:courts
// Generated: ${generatedAt}
// Schedule season (from sfrecpark.org): ${season}
//
// SF Recreation & Parks recreation centers with an INDOOR basketball gym.
// Indoor-gym determination + facility hours: curated in the build script.
// Coordinates/address/neighborhood: DataSF dataset ib5c-xgwu.
// Open-gym basketball times: scraped live from each center's sfrecpark.org page.
//
// schedule[]   = FACILITY hours, indexed 0=Sun..6=Sat; [openMin,closeMin] or null.
// dropins      = { sportId: week } drop-in OPEN-GYM blocks per sport; each week is
//   indexed 0=Sun..6=Sat and each day is an array of [startMin,closeMin] blocks
//   (empty when none that day). Sports: basketball, volleyball, pingpong, pickleball;
//   plus weightroom (rec-center weight/fitness room drop-in hours, not a sport).
// scheduleSource = "live" (scraped this run) | "cache" (last good) | "curated".

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const COURTS = [
${body}
];

export default COURTS;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
