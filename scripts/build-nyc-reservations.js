#!/usr/bin/env node
/*
 * Build data/cities/nyc/reservations.js — how much of each NYC court/field is
 * spoken for, in the same `reserved` shape SF's rec.us snapshot uses
 * (data/reservations.js), so the app's existing reservation UI renders it with
 * no new render path. Run with:  npm run build:nyc-reservations
 *
 * NYC has TWO unrelated systems, and they mean different things to a player:
 *
 *   kind 'permit'  — NYC Parks issues season permits to leagues for fields and
 *                    courts. A permitted court is not bookable by you; it's
 *                    simply taken. Source is the undocumented JSON API behind
 *                    /permits/field-and-court/map:
 *                      /api/athletic-fields?datetime=YYYY-MM-DD+H:mm
 *                        -> { dusk, l: [<system id>, ...] }   // UNAVAILABLE now
 *                    One request covers the whole city, so a 30-minute sweep of
 *                    the next 7 days is ~217 requests total (not per court).
 *
 *   kind 'reserve'  — 8 tennis sites take $15/hour online reservations through
 *                    /tennisreservation/availability/<id>, an HTML grid of
 *                    court x hour cells over the next 7 days. This is the true
 *                    rec.us analogue: you can book these.
 *
 * The join that makes the permit half cheap: the API's `system` id (e.g.
 * "B214-02-FOOTBALL-1") is a column in the SAME Socrata dataset the outdoor
 * build scrapes (qnem-b8re), alongside `gispropnum` — which build-city-outdoor
 * now emits on every pin as `key`. So system -> park key -> our court id is
 * exact, with no name or distance matching. Never parse the sport out of the id
 * string; read it from the row's sport flag columns.
 *
 * Denominators matter as much as counts. A reading of "2 courts taken" is only
 * meaningful against how many courts exist: for permits that's every active
 * facility of that sport at the park (Socrata), and for tennis it's reservation
 * courts + walk-on courts (the index page publishes both). Without the walk-on
 * half, 2 booked reservation courts at Riverside would read "fully booked" while
 * 8 walk-on courts sat empty — the exact failure lib/reservations.js was written
 * to avoid for SF.
 *
 * Resilience mirrors the other builds: live -> last-good cache
 * (scripts/cities/nyc-reservations-cache.json) -> abort keeping the old file.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchT } = require('./fetch-timeout');
const { loadCache, saveCache } = require('./lib/courts-common');

const BASE = 'https://www.nycgovparks.org';
const PERMIT_MAP_URL = `${BASE}/permits/field-and-court/map`;
// Named on every entry so the card can say where a reading came from without
// inferring it — the app's reservation strings take the source as {src}.
const SRC = 'nycgovparks.org';
const SOCRATA = 'https://data.cityofnewyork.us/resource/qnem-b8re.json';
// nycgovparks WAF-challenges anything that doesn't look like a browser.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/html' };

const OUT_DIR = path.join(__dirname, '..', 'data', 'cities', 'nyc');
const OUT_FILE = path.join(OUT_DIR, 'reservations.js');
const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-reservations-cache.json');
const COURTS_FILE = path.join(OUT_DIR, 'outdoor-courts.js');

const TZ = 'America/New_York';
const WINDOW_DAYS = 7;
// Sweep window: park hours start at 8 AM and lit fields run to 11 PM, so 7 AM–10 PM
// covers every hour anyone can play plus a margin. STEP matches the app's 30-minute
// slot grid (lib/reservations.js slotKeyOf) — sampling hourly would leave every
// :30 lookup with no reading at all.
const SWEEP_FROM_H = 7;
const SWEEP_TO_H = 22;
const STEP_MIN = 30;
const PACE_MS = 200; // be gentle: this is a .gov host, and it's ~217 requests

// Abort (keep last-good data) below this many court+sport readings.
const MIN_READINGS_OK = 40;
// How long a cached tennis grid stays usable when the live scrape is blocked.
const TENNIS_CACHE_MAX_DAYS = 3;

// Socrata sport flag column -> our sport id. Deliberately a subset of the
// outdoor build's map: only sports the app can render. Handball is unmapped
// until it exists in lib/sports.js.
const SPORT_FLAGS = {
  basketball: 'basketball',
  tennis: 'tennis',
  volleyball: 'volleyball',
  pickleball: 'pickleball',
  adult_baseball: 'baseball',
  adult_softball: 'baseball',
  ll_baseb_12andunder: 'baseball',
  ll_baseb_13andolder: 'baseball',
  ll_softball: 'baseball',
  t_ball: 'baseball',
  regulation_soccer: 'soccer',
  nonregulation_soccer: 'soccer',
};

/* The 8 online-reservation tennis sites, mapped to the court pin they belong to.
 * Curated because the automatic joins all fail here: the reservation system's
 * location names don't match Socrata park names, DPR_Tennis_001's coordinates
 * are null for half of them, and Riverside Park's two reservation sites (96th
 * and 119th) share ONE park key — so they merge onto one pin, which is right:
 * "how booked is tennis at Riverside Park" is the question the card answers.
 * `null` = no outdoor tennis pin exists (indoor bubble sites); we skip those
 * rather than attach tennis to a pin that doesn't offer it.
 * Re-check when NYC Parks adds a site to /tennisreservation. */
const TENNIS_PINS = {
  'Central Park': 'nyc-central-park-outdoor',
  'Commonpoint Tennis at Alley Pond Park': null, // indoor center; Q001 pin has no tennis
  'McCarren Park': 'nyc-mccarren-park-outdoor',
  'Mill Pond Park': 'nyc-mill-pond-park-outdoor',
  'Riverside Clay Tennis Association at Riverside Park (96 Street)': 'nyc-riverside-park-outdoor',
  'Riverside Park (119 Street)': 'nyc-riverside-park-outdoor',
  "Sportime at Randall's Island Park": 'nyc-randall-s-island-park-outdoor',
  'Sutton East at Queensborough Oval': null, // seasonal bubble; no outdoor pin
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

// NYC-local wall clock, regardless of where the build runs.
const nycNow = (d = new Date()) => new Date(d.toLocaleString('en-US', { timeZone: TZ }));
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const slotKey = (date, min) => `${date} ${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

async function getJson(url) {
  const res = await fetchT(url, { headers: HEADERS }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// HTML pages go through the WAF, which answers a heavy caller with an EMPTY 200
// rather than an error status — seen in practice when the permit sweep's ~217
// API calls ran immediately before these page loads (which is why fetchTennis
// runs first). The cooldown is on the order of a minute, so back off hard.
const HTML_BACKOFF_MS = [0, 5000, 20000, 45000];
async function getText(url, tries = HTML_BACKOFF_MS.length) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) {
      console.log(`    ↻ retry ${i} in ${HTML_BACKOFF_MS[i] / 1000}s — ${last.message}`);
      await sleep(HTML_BACKOFF_MS[i]);
    }
    try {
      const res = await fetchT(url, { headers: HEADERS }, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const html = await res.text();
      if (html.length > 5000) return html;
      last = new Error(`short response (${html.length}b) for ${url} — WAF challenge?`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// The next WINDOW_DAYS dates (NYC-local), starting today.
function windowDates() {
  const out = [];
  const base = nycNow();
  base.setHours(0, 0, 0, 0);
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push(ymd(d));
  }
  return out;
}

// --- Socrata: system id -> { key, sports } + per-park court counts ----------

async function fetchFacilities() {
  const cols = ['system', 'gispropnum', ...Object.keys(SPORT_FLAGS)].join(',');
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const qs = new URLSearchParams({
      $select: cols,
      $where: "featurestatus='Active'",
      $order: ':id', // required for stable paging (see socrata-outdoor.js)
      $limit: '1000',
      $offset: String(offset),
    });
    const page = await getJson(`${SOCRATA}?${qs}`);
    rows.push(...page);
    if (page.length < 1000) break;
  }

  const truthy = (v) => v === true || v === 'true';
  const bySystem = new Map(); // system -> { key, sports:[] }
  const counts = new Map(); // `${key}|${sport}` -> how many facilities exist
  for (const r of rows) {
    if (!r.gispropnum) continue;
    const sports = new Set();
    for (const [col, sport] of Object.entries(SPORT_FLAGS)) if (truthy(r[col])) sports.add(sport);
    if (!sports.size) continue;
    for (const s of sports) {
      const k = `${r.gispropnum}|${s}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // Only permittable facilities carry a system id; the rest still count
    // toward the denominator above.
    if (r.system) bySystem.set(r.system, { key: r.gispropnum, sports: [...sports] });
  }
  return { bySystem, counts, rows: rows.length };
}

// --- Permit sweep ----------------------------------------------------------

// One citywide snapshot: which systems are unavailable at this moment, + dusk.
async function fetchMoment(date, min) {
  const h = Math.floor(min / 60);
  const m = pad2(min % 60);
  const d = await getJson(`${BASE}/api/athletic-fields?datetime=${date}+${h}:${m}`);
  return { dusk: d.dusk || null, unavailable: Array.isArray(d.l) ? d.l : [] };
}

// courtId -> sport -> { slots, courts } from the permit API, plus dusk by date.
async function sweepPermits(dates, bySystem, counts, keyToCourt) {
  const acc = new Map(); // `${courtId}|${sport}` -> Map(slotKey -> taken)
  const dusk = {};
  let requests = 0;
  for (const date of dates) {
    for (let min = SWEEP_FROM_H * 60; min <= SWEEP_TO_H * 60; min += STEP_MIN) {
      const { dusk: d, unavailable } = await fetchMoment(date, min);
      requests++;
      if (d && !dusk[date]) dusk[date] = d;
      const key = slotKey(date, min);
      // A park can have several facilities of one sport taken at once; count
      // them per (pin, sport) rather than per system.
      const taken = new Map();
      for (const system of unavailable) {
        const meta = bySystem.get(system);
        if (!meta) continue; // a sport we don't track (football, cricket, …)
        const courtId = keyToCourt.get(meta.key);
        if (!courtId) continue; // park property with no pin of ours
        for (const sport of meta.sports) {
          const id = `${courtId}|${sport}`;
          taken.set(id, (taken.get(id) || 0) + 1);
        }
      }
      for (const [id, n] of taken) {
        let m = acc.get(id);
        if (!m) acc.set(id, (m = new Map()));
        m.set(key, n);
      }
      await sleep(PACE_MS);
    }
    process.stdout.write(`  · swept ${date}\n`);
  }

  const courtToKey = new Map([...keyToCourt].map(([k, id]) => [id, k]));
  const out = {};
  for (const [id, slotMap] of acc) {
    const [courtId, sport] = id.split('|');
    // Denominator: every active facility of this sport at the park, not just
    // the permittable ones — a permitted court out of 8 leaves 7 to play on.
    const parkKey = courtToKey.get(courtId);
    const total = counts.get(`${parkKey}|${sport}`) || Math.max(...slotMap.values());
    (out[courtId] ||= {})[sport] = {
      slots: Object.fromEntries([...slotMap].sort(([a], [b]) => (a < b ? -1 : 1))),
      courts: total,
    };
  }
  return { permits: out, dusk, requests };
}

// --- Tennis reservation grids ----------------------------------------------

// The 8 locations from /tennisreservation: availability page id + published
// reservation / walk-on court counts (the walk-on half is the denominator that
// keeps a booked-out reservation grid from reading as "nothing to play on").
function parseTennisIndex(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('table tr').each((_, tr) => {
    const $tr = $(tr);
    const link = $tr.find('a[href*="/tennisreservation/availability/"]').attr('href');
    if (!link) return;
    const cells = $tr.find('td').map((__, td) => $(td).text().trim()).get();
    // The name cell is "<strong>Name</strong>, Borough<br><a>View Availability…</a>",
    // so take the first <strong> — the cell's full text drags the borough and the
    // link label along with it.
    const name = $tr.find('td').first().find('strong').first().text().replace(/\s+/g, ' ').trim();
    const nums = cells.map((c) => parseInt(c, 10)).filter(Number.isFinite);
    out.push({
      id: link.split('/').pop(),
      name,
      reservationCourts: nums[0] ?? null,
      walkOnCourts: nums[1] ?? null,
    });
  });
  return out;
}

// One availability page -> { slots, open, courts } in the app's slot shape.
// Cell classes: status1 = Not Available (outside hours / not released),
// status2 = "Reserve this time" (free), status3 = Booked.
function parseTennisAvailability(html) {
  const $ = cheerio.load(html);
  const slots = {}; // slotKey -> booked court count
  const open = {}; // slotKey -> courts actually open then
  let courts = 0;

  $('.tab-content .tab-pane').each((_, pane) => {
    const date = $(pane).attr('id');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const rows = $(pane).find('table tbody tr');
    courts = Math.max(courts, $(pane).find('table thead th').length);
    rows.each((__, tr) => {
      const cells = $(tr).find('td');
      const label = $(cells[0]).text().trim(); // "6:00 a.m."
      const m = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(label.replace(/\s+/g, ' '));
      if (!m) return;
      let h = parseInt(m[1], 10) % 12;
      if (m[3].toLowerCase() === 'p') h += 12;
      const min = h * 60 + parseInt(m[2], 10);

      let booked = 0;
      let openNow = 0;
      cells.slice(1).each((___, td) => {
        const cls = $(td).attr('class') || '';
        if (/status1/.test(cls)) return; // not available at all
        openNow++;
        if (/status3/.test(cls)) booked++;
      });
      if (!openNow) return;
      // Tennis books in 1-hour blocks, so a 9:00 booking genuinely occupies
      // 9:30 too — writing both keys reflects the booking, it doesn't invent it.
      for (const k of [slotKey(date, min), slotKey(date, min + 30)]) {
        open[k] = (open[k] || 0) + openNow;
        if (booked) slots[k] = (slots[k] || 0) + booked;
        else if (!(k in slots)) slots[k] = 0;
      }
    });
  });
  return { slots, open, courts };
}

async function fetchTennis(keyToCourt) {
  const index = parseTennisIndex(await getText(`${BASE}/tennisreservation`));
  if (!index.length) throw new Error('no locations parsed from /tennisreservation');
  const out = {}; // courtId -> { tennis: {...} }
  for (const loc of index) {
    const courtId = TENNIS_PINS[loc.name];
    if (courtId === undefined) {
      console.log(`  ⚠ tennis: unmapped location "${loc.name}" — add it to TENNIS_PINS`);
      continue;
    }
    if (courtId === null) continue; // known: no outdoor pin for this site
    const url = `${BASE}/tennisreservation/availability/${loc.id}`;
    let grid;
    try {
      grid = parseTennisAvailability(await getText(url));
    } catch (e) {
      console.log(`  ⚠ tennis: ${loc.name} — ${e.message}`);
      continue;
    }
    await sleep(PACE_MS);
    const reservation = loc.reservationCourts ?? grid.courts;
    const total = reservation + (loc.walkOnCourts || 0);
    // Riverside's two reservation sites share one pin — merge rather than
    // letting the second overwrite the first.
    const prev = out[courtId]?.tennis;
    out[courtId] = {
      tennis: prev
        ? {
            slots: mergeCounts(prev.slots, grid.slots),
            open: mergeCounts(prev.open, grid.open),
            courts: prev.courts + reservation,
            total: prev.total + total,
            url: prev.url,
          }
        : { slots: grid.slots, open: grid.open, courts: reservation, total, url },
    };
    console.log(`  ✓ tennis: ${loc.name} → ${courtId} (${reservation} res + ${loc.walkOnCourts || 0} walk-on)`);
  }
  return out;
}

const mergeCounts = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] || 0) + v;
  return out;
};

// --- Assemble --------------------------------------------------------------

// Window average, used for the card's headline badge when no specific time is picked.
function pctOf(slots, courts) {
  const vals = Object.values(slots);
  if (!vals.length || !courts) return 0;
  return Math.round((vals.reduce((s, n) => s + n, 0) / (vals.length * courts)) * 100);
}

// Slot map -> run-length runs [[startIdx, endIdx, count], ...] on the 30-minute
// grid, indexed from `origin`. Permits are contiguous by nature (a league holds
// a field 3-6 PM, not alternating half-hours), so this is a ~13x reduction —
// 37k slot entries became 5.2k runs, 921 KB of bundled JS became 68 KB — with
// no loss at all. data/cities/index.js expands it back at import.
// Slot keys are NYC WALL CLOCK, so index math must be too: parsing them as real
// instants would shift every index by an hour across a DST boundary, and would
// depend on the build host's own timezone. Date.UTC on the literal fields makes
// the arithmetic pure and exactly reversible (see expandRuns in
// data/cities/index.js, which must stay in sync with this).
const wallMs = (k) =>
  Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10), +k.slice(11, 13), +k.slice(14, 16));

function toRuns(map, originMs) {
  const pts = Object.entries(map)
    .map(([k, v]) => [Math.round((wallMs(k) - originMs) / 1800000), v])
    .sort((a, b) => a[0] - b[0]);
  const runs = [];
  let cur = null;
  for (const [i, v] of pts) {
    if (cur && cur[1] + 1 === i && cur[2] === v) {
      cur[1] = i;
      continue;
    }
    runs.push((cur = [i, i, v]));
  }
  return runs;
}

function assemble(permits, tennis, dates) {
  const from = slotKey(dates[0], SWEEP_FROM_H * 60);
  const to = slotKey(dates[dates.length - 1], SWEEP_TO_H * 60);
  const out = {};
  for (const [courtId, bySport] of Object.entries(permits)) {
    for (const [sport, agg] of Object.entries(bySport)) {
      (out[courtId] ||= {})[sport] = {
        v: 2, // slots hold RESERVED COURT COUNTS (see data/reservations.js)
        kind: 'permit',
        src: SRC,
        pct: pctOf(agg.slots, agg.courts),
        courts: agg.courts,
        slots: agg.slots,
        url: PERMIT_MAP_URL,
      };
    }
  }
  for (const [courtId, bySport] of Object.entries(tennis)) {
    for (const [sport, agg] of Object.entries(bySport)) {
      // Tennis reservations win over any permit reading for the same court+sport:
      // the reservation grid is the finer-grained, player-facing truth.
      (out[courtId] ||= {})[sport] = {
        v: 2,
        kind: 'reserve',
        src: SRC,
        pct: pctOf(agg.slots, agg.courts),
        courts: agg.courts,
        total: agg.total, // reservation + walk-on courts (the real denominator)
        slots: agg.slots,
        open: agg.open,
        url: agg.url,
      };
    }
  }
  return { entries: out, window: [from, to] };
}

async function main() {
  console.log('Building NYC reservations (permits + tennis)…');
  const dates = windowDates();

  // Park key -> our court id, straight off the generated outdoor pins.
  const src = fs.readFileSync(COURTS_FILE, 'utf8');
  const keyToCourt = new Map();
  for (const m of src.matchAll(/id: "([^"]+)",\s*\n\s*key: "([^"]+)"/g)) keyToCourt.set(m[2], m[1]);
  if (!keyToCourt.size) {
    throw new Error(`no park keys in ${COURTS_FILE} — run "npm run build:nyc" first`);
  }
  console.log(`  ${keyToCourt.size} park pins with a join key`);

  let reservations;
  let dusk;
  let window;
  let source;
  try {
    const { bySystem, counts, rows } = await fetchFacilities();
    console.log(`  ${rows} active facilities → ${bySystem.size} permittable systems on tracked sports`);

    // Tennis first, deliberately: it's ~7 HTML page loads through the WAF, and
    // running them after the sweep's 217 API calls got the whole batch served
    // empty 200s instead of content.
    //
    // The two halves fall back INDEPENDENTLY. They're unrelated sources, and a
    // shared all-or-nothing cache would mean one bad tennis scrape either
    // discards a perfectly good citywide permit sweep, or (worse) silently
    // republishes week-old permits because tennis hiccuped.
    let tennis = null;
    try {
      tennis = await fetchTennis(keyToCourt);
    } catch (e) {
      console.log(`  ⚠ tennis reservations failed (${e.message})`);
    }
    if (!tennis || !Object.keys(tennis).length) {
      // Slot keys are absolute dates, so cached tennis expires on its own: past
      // dates simply stop matching. Drop it after TENNIS_CACHE_MAX_DAYS anyway,
      // so a long outage publishes "reservations exist here" rather than a grid
      // of dead dates that quietly covers less and less of the week.
      const cache = loadCache(CACHE_FILE);
      const ageDays = cache?.fetchedAt ? (Date.now() - Date.parse(cache.fetchedAt)) / 864e5 : Infinity;
      const prior = ageDays <= TENNIS_CACHE_MAX_DAYS ? cache?.tennis : null;
      tennis = prior || {};
      console.log(
        prior
          ? `  ↺ tennis: reusing ${Object.keys(prior).length} cached locations (${ageDays.toFixed(1)}d old)`
          : '  ↺ tennis: no usable cache — permits only this run'
      );
    }

    const sweep = await sweepPermits(dates, bySystem, counts, keyToCourt);
    dusk = sweep.dusk;
    console.log(`  permit sweep: ${sweep.requests} requests, ${Object.keys(sweep.permits).length} parks with permits`);

    const built = assemble(sweep.permits, tennis, dates);
    reservations = built.entries;
    window = built.window;
    const readings = Object.values(reservations).reduce((n, s) => n + Object.keys(s).length, 0);
    if (readings < MIN_READINGS_OK) {
      throw new Error(`only ${readings} readings (min ${MIN_READINGS_OK}) — source shape may have changed`);
    }
    source = 'live';
    saveCache(CACHE_FILE, { reservations, tennis, dusk, window, fetchedAt: new Date().toISOString() });
    console.log(`  ✓ ${Object.keys(reservations).length} courts, ${readings} court+sport readings (live)`);
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !cache.reservations) {
      throw new Error(`fetch failed (${e.message}) and no cache — ${OUT_FILE} left unchanged`);
    }
    reservations = cache.reservations;
    dusk = cache.dusk || {};
    window = cache.window || [null, null];
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, render(reservations, dusk, window, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${Object.keys(reservations).length} courts to data/cities/nyc/reservations.js (${source})`);
}

function render(reservations, dusk, window, generatedAt, source) {
  // Index 0 of every run list. Runs may go negative (the tennis grid starts at
  // 6 AM, before the permit sweep's 7 AM) — that's fine, it's just an offset.
  const origin = window[0];
  const originMs = wallMs(String(origin));
  let runCount = 0;

  const compact = (entry) => {
    const { slots, open, ...rest } = entry;
    const runs = toRuns(slots, originMs);
    runCount += runs.length;
    const openRuns = open ? toRuns(open, originMs) : null;
    if (openRuns) runCount += openRuns.length;
    return { ...rest, runs, ...(openRuns ? { openRuns } : {}) };
  };

  const body = Object.keys(reservations)
    .sort()
    .map((id) => {
      const bySport = Object.fromEntries(
        Object.entries(reservations[id]).map(([sport, e]) => [sport, compact(e)])
      );
      return `  ${JSON.stringify(id)}: ${JSON.stringify(bySport)},`;
    })
    .join('\n');
  console.log(`  encoded ${runCount} runs`);

  return `// AUTO-GENERATED by scripts/build-nyc-reservations.js — do not edit by hand.
// Regenerate with: npm run build:nyc-reservations
// Generated: ${generatedAt} (${source})
//
// How much of each NYC court/field is spoken for — court id -> { sport: {...} }:
//   v        slot-value contract; 2 = counts are RESERVED COURT COUNTS
//   kind     'permit'  — a league holds it via a NYC Parks field/court permit.
//                        You cannot book it; it is simply taken. Coverage is
//                        SPARSE (absent = nobody has it), so WINDOW below says
//                        what the sweep covered and a gap inside it means 0.
//            'reserve' — one of the 8 tennis sites taking \$15/hr online
//                        reservations; you can actually book these.
//   pct      window-average share of courts taken
//   courts   courts of this sport at the location (permit: every active
//            facility at the park; tennis: the RESERVATION courts only)
//   total    tennis only — reservation + walk-on courts, the real denominator
//            for "is there anything left to play on"
//   runs     RUN-LENGTH ENCODED occupancy: [[startIdx, endIdx, courtsTaken]],
//            inclusive, on a 30-minute grid indexed from ORIGIN. Permits are
//            contiguous by nature, so this is ~13x smaller than a slot map
//            (5.2k runs vs 37.8k keys) with no loss. Indices may be negative —
//            the tennis grid starts at 6 AM, before the permit sweep's 7 AM.
//   openRuns tennis only — same encoding, courts actually open at that time
//   url      where to check/book (permit map, or the tennis availability page)
//
// data/cities/index.js expands \`runs\`/\`openRuns\` back into the \`slots\`/\`open\`
// maps that lib/reservations.js reads, so this ends up in exactly the same
// \`reserved\` contract as SF's data/reservations.js and shares its render path.
//
// A point-in-time snapshot over the next 7 days: it goes stale, so the daily
// cron re-runs this. Merged onto courts by lib/useCourts.js as \`reserved\`.

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

// Slot index 0: the datetime every \`runs\` index counts 30-minute steps from.
export const ORIGIN = ${JSON.stringify(origin)};

// [first, last] slot the permit sweep covered. Inside it, a court+sport with no
// run at a time genuinely has nobody on it; outside it we simply have no data.
export const WINDOW = ${JSON.stringify(window)};

// Dusk (NYC-local "HH:MM") per date, straight from the permit API — the honest
// close time for first-come outdoor courts. Only dates inside the permit window
// are real; the API returns a fallback for anything further out.
export const DUSK = ${JSON.stringify(dusk || {}, null, 0)};

export const NYC_RESERVATIONS = {
${body}
};

export default NYC_RESERVATIONS;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
