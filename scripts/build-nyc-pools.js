#!/usr/bin/env node
/*
 * Build data/cities/nyc/pools.js — NYC's 79 free outdoor pools and 13 indoor
 * rec-center pools, in the same POOLS record shape as SF's data/pools.js so
 * lib/poolCourts.js turns both into `swimming` courts on the map and
 * components/PoolDetail.js renders both. Run with:  npm run build:nyc-pools
 *
 * Far simpler than SF, which reconstructs a weekly grid out of seasonal PDF
 * geometry. NYC publishes:
 *
 *   outdoor — ONE citywide schedule, stated in prose on /facilities/outdoor-pools
 *             and repeated on every pool's own page: 11 a.m.-7 p.m. daily with a
 *             cleaning break 3-4 p.m. So two blocks a day, the same everywhere.
 *             Free, no membership.
 *   indoor  — a real per-facility weekly grid, in the `#Pool-schedule` table on
 *             the rec center's schedule page. Same markup as the center schedule
 *             that build-nyc-indoor.js parses, but a DIFFERENT table: that build
 *             matches only the first `table.schedule-table` on the page, so the
 *             pool grid was going unread. Year-round, membership required.
 *
 * SEASON. The outdoor pools run roughly late June to Labor Day, and NYC Parks
 * publishes no machine-readable start date — only a live banner ("Pools are
 * open! … now through Labor Day weekend"). Rather than hardcode a guessed
 * opening date and quietly be wrong for weeks either side, this reads the
 * banner and ships what NYC Parks says RIGHT NOW: out of season the outdoor
 * pools carry no sessions, so they read as closed instead of advertising swim
 * hours in February. The weekly cron re-runs this, so the worst case at a season
 * boundary is a few days stale, and `season.checked` dates the claim.
 *
 * Resilience mirrors the other builds: live -> last-good cache -> abort keeping
 * the existing data file.
 *
 * ONE RECORD PER SITE, NOT PER BASIN. NYC's feeds list a row per basin, so a
 * site with a swimming pool and a wading pool arrives as two rows — and the id
 * is derived from the site name, so both got the SAME id (24 sites did; Fort
 * Totten has three). Two courts sharing an id is not something the app can hold:
 * lib/useCourts.js only dedupes EXTRA_COURTS against the bundled list, not
 * against itself, so both reached the map under one id — colliding React keys,
 * and a favorite or crowd check-in on the wading pool indistinguishable from one
 * on the pool beside it. They are also one place you go swimming, so the fix is
 * to merge them: `mergeSites()` emits one record per id, keeping the swimming
 * basin's name/coords/description and listing every basin in `basins`. Ids are
 * unchanged by this (they were always site-derived), so existing favorites and
 * check-ins keep resolving.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { slug, loadCache, saveCache, reportStale } = require('./lib/courts-common');

const BASE = 'https://www.nycgovparks.org';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json, text/html' };

const OUT_DIR = path.join(__dirname, '..', 'data', 'cities', 'nyc');
const OUT_FILE = path.join(OUT_DIR, 'pools.js');
const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-pools-cache.json');

// nycgovparks WAF-challenges bursts — same pacing as build-nyc-indoor.js.
const CONCURRENCY = 2;
const PACE_MS = 350;

// Abort (keep last-good data) below this many pools.
// Basin rows as scraped (~92); mergeSites() then collapses them to ~67 sites.
const MIN_POOLS_OK = 60;

// Fallback citywide outdoor hours, used only if the page's prose stops parsing.
// Kept as a constant so a wording change fails visibly in the log rather than
// silently publishing nothing.
const DEFAULT_OUTDOOR = { open: 11 * 60, close: 19 * 60, breakFrom: 15 * 60, breakTo: 16 * 60 };

// Rec-center membership, which is what an indoor pool actually costs. Curated
// like SF's fee table (published rates, revisited ~annually), matching the
// POOL_FEES shape components/PoolDetail.js renders.
const INDOOR_FEES = {
  effective: '2026-01-01',
  source: 'https://www.nycgovparks.org/programs/recreation-centers/membership',
  note: 'Recreation center membership — indoor pools are members-only',
  groups: [
    { id: 'youth', label: 'Ages 24 and under', dropIn: 0, passes: [['Annual membership', 0]] },
    { id: 'adult', label: 'Adults (25–61)', dropIn: 0, passes: [['Annual membership', 150], ['Six months', 75]] },
    {
      id: 'senior',
      label: 'Seniors 62+, veterans, people with disabilities',
      dropIn: 0,
      passes: [['Annual membership', 25]],
    },
  ],
};

// Outdoor pools are free, full stop — the fee table says so rather than being
// absent, so the card answers "how much?" instead of staying silent.
const OUTDOOR_FEES = {
  effective: '2026-01-01',
  source: 'https://www.nycgovparks.org/facilities/outdoor-pools',
  note: 'NYC outdoor pools are free — no membership, no fee',
  groups: [{ id: 'all', label: 'Everyone', dropIn: 0, passes: [] }],
};

// NYC pool program title -> the session kind PoolDetail already labels.
// Order matters: "Adult Lap Swim" must hit `lap` before any generic swim rule.
const KIND_RULES = [
  [/lap\s*swim|masters/i, 'lap'],
  [/learn\s*to\s*swim|swim\s*(lesson|instruction)|beginner|stroke/i, 'lessons'],
  [/adult\s*(swim\s*)?(lesson|instruction)/i, 'adult_lessons'],
  [/parent|tot\b|toddler|mommy|caregiver/i, 'parent_child'],
  [/senior|55\+|60\+/i, 'senior'],
  [/aqua|water\s*(aerobic|exercise|fitness|walking)|arthritis/i, 'exercise'],
  [/camp/i, 'camp'],
  [/rental|party/i, 'rental'],
  [/swim\s*team|competitive|practice/i, 'other'],
  [/open\s*swim|general\s*swim|rec(reation(al)?)?\s*swim|family|public\s*swim|free\s*swim/i, 'family'],
];
const kindFor = (title) => KIND_RULES.find(([re]) => re.test(title))?.[1] || 'other';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function getJson(url) {
  const res = await fetchT(url, { headers: HEADERS }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const HTML_BACKOFF_MS = [0, 5000, 20000];
async function getText(url) {
  let last;
  for (let i = 0; i < HTML_BACKOFF_MS.length; i++) {
    if (i) await sleep(HTML_BACKOFF_MS[i]);
    try {
      const res = await fetchT(url, { headers: HEADERS }, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const html = await res.text();
      // The WAF answers a heavy caller with an empty 200 rather than an error.
      if (html.length > 5000) return html;
      last = new Error(`short response (${html.length}b) — WAF challenge?`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// "11:00 a.m." / "7 p.m." -> minutes from midnight.
function toMin(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])/i.exec(String(s || ''));
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2] || 0);
}

// Labor Day (first Monday in September) — the published end of the outdoor season.
function laborDay(year) {
  const d = new Date(year, 8, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

// The citywide outdoor schedule + season status, both stated in prose on the
// index page. Parsed rather than hardcoded so a change shows up in the diff.
function parseOutdoorPage(html) {
  // Strip HTML comments first: the page still carries commented-out COVID-era
  // text ("Indoor pools remain closed until September 27") that would otherwise
  // match every pattern here.
  const text = strip(html.replace(/<!--[\s\S]*?-->/g, ''));

  const hoursM = /hours are from\s*([\d:]+\s*[ap])\.?m\.?\s*through\s*([\d:]+\s*[ap])\.?m/i.exec(text);
  const breakM = /cleaning between\s*([\d:]+\s*[ap])\.?m\.?\s*and\s*([\d:]+\s*[ap])\.?m/i.exec(text);
  const hours = {
    open: (hoursM && toMin(hoursM[1])) ?? DEFAULT_OUTDOOR.open,
    close: (hoursM && toMin(hoursM[2])) ?? DEFAULT_OUTDOOR.close,
    breakFrom: (breakM && toMin(breakM[1])) ?? DEFAULT_OUTDOOR.breakFrom,
    breakTo: (breakM && toMin(breakM[2])) ?? DEFAULT_OUTDOOR.breakTo,
  };
  if (!hoursM) console.log('  ⚠ outdoor hours prose did not parse — using the documented default');

  const open = /pools are open/i.test(text);
  const end = laborDay(new Date().getFullYear());
  return {
    hours,
    season: {
      open,
      // What the page itself says, so the label can never outrun the source.
      label: open
        ? `Open daily through Labor Day (${end.getMonth() + 1}/${end.getDate()})`
        : 'Closed for the season — NYC outdoor pools run late June through Labor Day',
      checked: new Date().toISOString().slice(0, 10),
      source: `${BASE}/facilities/outdoor-pools`,
    },
  };
}

// Why a pool has no schedule. An empty pool table is real data, not a parse
// failure — St. Mary's publishes none because the whole center is "closed for
// reconstruction", and several others run no pool sessions in summer while
// their lifeguards staff the outdoor pools. The page says so in an alert box,
// and that sentence is far more useful on the card than an empty schedule.
function parseNotice(html) {
  const m = /<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]{0,900}?)<\/div>/i.exec(
    html.replace(/<!--[\s\S]*?-->/g, '')
  );
  const t = m ? strip(m[1]) : '';
  return t.length > 30 && /pool|closed|reconstruct|reduced|lifeguard|membership/i.test(t) ? t : null;
}

// The `#Pool-schedule` table on a rec center's schedule page -> sessions[7].
// Identical markup to the center schedule, but the SECOND schedule-table on the
// page; build-nyc-indoor.js only ever reads the first.
function parsePoolSchedule(html) {
  const section = html.split(/id="Pool-schedule"/)[1];
  if (!section) return null;
  const tableM = section.match(/<table class="table schedule-table">([\s\S]*?)<\/table>/);
  if (!tableM) return null;

  const details = {};
  for (const m of html.matchAll(/<div id="(program_\d+)">\s*<h3>([\s\S]*?)<\/h3>/g)) {
    details[m[1]] = strip(m[2]);
  }

  const sessions = Array.from({ length: 7 }, () => []);
  const days = tableM[1].split(/<td>/).slice(1);
  if (days.length < 7) return null;
  days.forEach((cell, i) => {
    const dow = (i + 1) % 7; // the table runs Monday-first; our weeks are 0=Sun
    for (const pm of cell.matchAll(
      /<p class="program">\s*([\d:]+\s*[ap])[^-]*-\s*([\d:]+\s*[ap])[\s\S]*?href="#(program_\d+)"/g
    )) {
      const title = details[pm[3]];
      if (!title) continue;
      const start = toMin(pm[1]);
      const end = toMin(pm[2]);
      if (start == null || end == null || end <= start) continue;
      sessions[dow].push({ kind: kindFor(title), start, end });
    }
  });
  for (const day of sessions) day.sort((a, b) => a.start - b.start || a.end - b.end);
  return sessions;
}

const clean = (s) => strip(s).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

// A pool's blurb: what kind of pool it is and how big, which is what someone
// choosing between two nearby pools actually wants.
function describe(r) {
  const bits = [];
  const type = clean(r.Pools_outdoor_Type || r.Pools_indoor_Type);
  if (type) bits.push(`${type} pool`);
  const size = clean(r.Size);
  if (size) bits.push(size);
  return bits.join(' · ');
}

function baseRecord(r, indoor) {
  const name = clean(r.Name);
  return {
    id: `nyc-pool-${slug(name)}`,
    name,
    address: clean(r.Location),
    lat: Number(r.lat),
    lng: Number(r.lon),
    phone: clean(r.Phone) || null,
    indoor,
    accessible: String(r.Accessible || '').toUpperCase() === 'Y',
    desc: describe(r),
  };
}

// Which basin speaks for the site: the one you would actually go there to swim
// in. A site's name and coordinates should point at its Olympic pool, not at the
// toddler wading pool 60 feet away.
const BASIN_RANK = ['olympic', 'intermediate', 'diving', 'mini', 'wading'];
const basinRank = (p) => {
  const i = BASIN_RANK.findIndex((k) => new RegExp(k, 'i').test(p.desc || ''));
  return i === -1 ? BASIN_RANK.length : i;
};

// Collapse the per-basin rows into one record per site. See the header note.
function mergeSites(pools) {
  const bySite = new Map();
  for (const p of pools) {
    if (!bySite.has(p.id)) bySite.set(p.id, []);
    bySite.get(p.id).push(p);
  }
  return [...bySite.values()].map((group) => {
    if (group.length === 1) return group[0];
    const [primary] = [...group].sort((a, b) => basinRank(a) - basinRank(b));
    const notice = group.find((p) => p.notice)?.notice;
    return {
      ...primary,
      // Accessible if ANY basin is: the site has an accessible pool.
      accessible: group.some((p) => p.accessible),
      // Every basin, best first — the card can say what is actually here.
      basins: [...group].sort((a, b) => basinRank(a) - basinRank(b)).map((p) => p.desc).filter(Boolean),
      programs: [...new Set(group.flatMap((p) => p.programs || []))],
      // Basins at one site can publish the same session (the outdoor week is
      // citywide, so every basin carries an identical copy of it).
      sessions: Array.from({ length: 7 }, (_, d) => {
        const seen = new Set();
        return group
          .flatMap((p) => p.sessions?.[d] || [])
          .filter((x) => {
            const k = `${x.kind}-${x.start}-${x.end}`;
            return !seen.has(k) && seen.add(k);
          });
      }),
      ...(notice ? { notice } : {}),
    };
  });
}

const inNyc = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat > 40.4 && p.lat < 41 && p.lng > -74.3 && p.lng < -73.6;

async function main() {
  console.log('Building NYC pools…');

  let rows; // one per basin, the shape both the feeds and the cache use
  let season;
  let source;
  let staleCache = null;
  try {
    const [outdoorRows, indoorRows] = await Promise.all([
      getJson(`${BASE}/bigapps/DPR_Pools_outdoor_001.json`),
      getJson(`${BASE}/bigapps/DPR_Pools_indoor_001.json`),
    ]);

    const { hours, season: seasonInfo } = parseOutdoorPage(await getText(`${BASE}/facilities/outdoor-pools`));
    season = seasonInfo;
    console.log(
      `  outdoor schedule: ${hours.open / 60}:00–${hours.breakFrom / 60}:00 and ` +
        `${hours.breakTo / 60}:00–${hours.close / 60}:00 daily · season ${season.open ? 'OPEN' : 'closed'}`
    );

    // Outdoor: one citywide schedule, in season only. Two blocks a day around
    // the cleaning break. Out of season we ship NO sessions rather than hours
    // nobody can use — the card then reads "closed" and shows the season label.
    const outdoorWeek = season.open
      ? Array.from({ length: 7 }, () => [
          { kind: 'family', start: hours.open, end: hours.breakFrom },
          { kind: 'family', start: hours.breakTo, end: hours.close },
        ])
      : Array.from({ length: 7 }, () => []);

    const out = [];
    for (const r of outdoorRows) {
      const p = baseRecord(r, false);
      if (!inNyc(p)) continue;
      out.push({
        ...p,
        season: season.label,
        seasonal: true,
        programs: season.open ? ['family'] : [],
        fees: OUTDOOR_FEES,
        scheduleUrls: [{ label: 'NYC Parks outdoor pools', url: `${BASE}/facilities/outdoor-pools` }],
        sessions: outdoorWeek,
      });
    }

    // Indoor: a real weekly grid per rec center, paced through the WAF.
    const indoorTargets = indoorRows.filter((r) => r.rec_center_id);
    const noCenter = indoorRows.length - indoorTargets.length;
    if (noCenter) console.log(`  ${noCenter} indoor pool(s) have no rec_center_id — no schedule page to read`);
    let idx = 0;
    const indoorOut = [];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (idx < indoorTargets.length) {
          const r = indoorTargets[idx++];
          const p = baseRecord(r, true);
          const url = `${BASE}/facilities/recreationcenters/${r.rec_center_id}/schedule`;
          let sessions = null;
          let notice = null;
          try {
            const html = await getText(url);
            sessions = parsePoolSchedule(html);
            notice = parseNotice(html);
          } catch (e) {
            console.log(`  ⚠ ${p.name}: ${e.message}`);
          }
          await sleep(PACE_MS);
          const n = (sessions || []).reduce((a, d) => a + d.length, 0);
          indoorOut.push({
            ...p,
            // The season line is a short status; the full explanation lives in
            // `notice` and renders once, below the schedule. Putting the notice
            // in both printed the same paragraph twice on the card.
            season: n ? 'Year-round (recreation center members)' : 'No pool sessions currently published',
            seasonal: false,
            ...(notice ? { notice } : {}),
            programs: [...new Set((sessions || []).flat().map((s) => s.kind))],
            fees: INDOOR_FEES,
            scheduleUrls: [{ label: 'Pool schedule', url: `${url}#Pool-schedule` }],
            sessions: sessions || Array.from({ length: 7 }, () => []),
          });
          console.log(
            n
              ? `  ✓ ${p.name}: ${n} pool sessions`
              : `  · ${p.name}: no sessions published — ${notice ? `"${notice.slice(0, 70)}…"` : 'no notice on the page'}`
          );
        }
      })
    );

    rows = [...out, ...indoorOut].filter((p) => inNyc(p));
    if (rows.length < MIN_POOLS_OK) {
      throw new Error(`only ${rows.length} pools (min ${MIN_POOLS_OK}) — feed shape may have changed`);
    }
    source = 'live';
    // The cache holds the SOURCE shape (one row per basin); mergeSites runs
    // after the fallback so a cached run gets merged records too — merging
    // before would have left an old cache shipping the colliding ids.
    saveCache(CACHE_FILE, { pools: rows, season, fetchedAt: new Date().toISOString() });
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !cache.pools) {
      throw new Error(`fetch failed (${e.message}) and no cache — ${OUT_FILE} left unchanged`);
    }
    rows = cache.pools;
    season = cache.season;
    source = 'cache';
    staleCache = cache;
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  const pools = mergeSites(rows).sort((a, b) => a.name.localeCompare(b.name));
  console.log(
    `  ${rows.length} basin rows → ${pools.length} sites ` +
      `(${pools.filter((p) => !p.indoor).length} outdoor, ${pools.filter((p) => p.indoor).length} indoor)`
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, render(pools, season, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${pools.length} pools to data/cities/nyc/pools.js (${source})`);
  reportStale(source, staleCache, { label: 'NYC pools', maxHours: 240 });
}

function render(pools, season, generatedAt, source) {
  const body = pools.map((p) => `  ${JSON.stringify(p)},`).join('\n');
  return `// AUTO-GENERATED by scripts/build-nyc-pools.js — do not edit by hand.
// Regenerate with: npm run build:nyc-pools
// Generated: ${generatedAt} (${source})
//
// NYC's free outdoor pools and its rec-center indoor pools, in the same record
// shape as SF's data/pools.js so lib/poolCourts.js shapes both into \`swimming\`
// courts and components/PoolDetail.js renders both. sessions[dow] = array of
// { kind, start, end }, dow 0=Sun..6=Sat, minutes from midnight.
//
//   outdoor (seasonal: true) — ONE citywide schedule, 11 a.m.–7 p.m. daily with
//     a 3–4 p.m. cleaning break, free, no membership. OUT OF SEASON these carry
//     no sessions at all, so they read as closed rather than advertising swim
//     hours in February. NYC Parks publishes no machine-readable season start,
//     only a live banner, so SEASON below records what the site said and when.
//   indoor (seasonal: false) — a real per-facility weekly grid from the
//     \`#Pool-schedule\` table on each rec center's schedule page, year-round,
//     rec-center membership required.

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

// Live outdoor-season status as of \`checked\` — re-read weekly by the cron.
export const SEASON = ${JSON.stringify(season || {}, null, 0)};

export const NYC_POOLS = [
${body}
];

export default NYC_POOLS;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
