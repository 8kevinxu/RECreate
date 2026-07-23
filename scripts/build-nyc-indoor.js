#!/usr/bin/env node
/*
 * Build data/cities/nyc/indoor-courts.js — NYC Parks recreation centers with
 * indoor open-gym schedules (the NYC counterpart of build-indoor-courts.js).
 * Run: npm run build:nyc-indoor
 *
 * Sources (nycgovparks.org 403s non-browser UAs — browser UA required):
 *   • /facilities/recreationcenters — the 37-center directory (ids like X999;
 *     the id's first letter is the borough).
 *   • /facilities/recreationcenters/<id> — facility page (street address).
 *   • /facilities/recreationcenters/<id>/schedule — this week's calendar: a
 *     7-column Mon→Sun table; each day holds Building Hours plus programs
 *     (time range, title, room, and a hidden per-program detail div with the
 *     full description/ages — the "click through" for ambiguous titles).
 *   • geosearch.planninglabs.nyc — NYC Planning's free geocoder for
 *     coordinates (cached in nyc-indoor-cache.json; addresses don't move).
 *
 * Open-gym classification: a program counts as a drop-in block only when it's
 * unstructured open play, not instruction. Deterministic rules on the title
 * decide most ("Adult Open Access (Basketball)" vs "Basketball Clinic"); the
 * program's own description settles ambiguous titles ("The Art of Basketball"
 * describes ball-handling instruction → class). Programs still ambiguous after
 * both go to Claude Haiku (yes/no, cached in nyc-indoor-class-cache.json,
 * ANTHROPIC_API_KEY optional) — without a verdict they're EXCLUDED, so a class
 * is never shown as open gym. Audience prefixes become block tags (Youth/Teen/
 * Senior/Women/Wheelchair); adult/all-ages blocks are untagged.
 *
 * NYC rec centers require a (cheap) NYC Parks membership — noted on each
 * record rather than priced, since fees change.
 *
 * Resilience mirrors the other builds: live scrape -> last-good cache
 * (nyc-indoor-cache.json), with a gate that aborts (keeping the existing data
 * file) if too few centers parse. Weekly cron (refresh-schedules) matches the
 * SF indoor cadence.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { slug, emptyWeek, ALL_SPORTS, loadCache, saveCache } = require('./lib/courts-common');

const BASE = 'https://www.nycgovparks.org';
const LIST_URL = `${BASE}/facilities/recreationcenters`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-indoor-cache.json');
const AI_CACHE_FILE = path.join(__dirname, 'cities', 'nyc-indoor-class-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'cities', 'nyc', 'indoor-courts.js');

// Abort (keep last-good data) if fewer centers than this scrape with hours.
const MIN_CENTERS_OK = 15;
// Gentle pacing — nycgovparks.org's WAF challenge-pages a burst of parallel
// requests (seen in practice as HTTP 202 + empty markup).
const CONCURRENCY = 2;
const PACE_MS = 350;

const BOROUGH = { X: 'Bronx', B: 'Brooklyn', M: 'Manhattan', Q: 'Queens', R: 'Staten Island' };

// Which tracked sport a program belongs to, from its title + room. A bare
// "Open Gym" in the Gymnasium counts as basketball (hoops time), like SF.
const SPORT_RES = [
  ['basketball', /basketball/i],
  ['volleyball', /volleyball/i],
  ['pingpong', /table tennis|ping ?pong/i],
  ['badminton', /badminton/i],
  ['pickleball', /pickle ?ball/i],
  ['weightroom', /fitness room|weight ?room|weight training|weights\b/i],
];
const GENERIC_GYM_RE = /open (gym|game time)|family time/i;

// Unstructured drop-in play. "open" attached to play/access/gym/run/court —
// or the standard "<Audience> Open <Sport>" phrasing.
const OPEN_RE =
  /open (access|play|gym|run|court|basketball|volleyball|badminton|pickle ?ball|table tennis|wheelchair basketball|adult|teen|youth)|(access|play)[^|]*\bopen\b|drop.?in|pick ?-?up|come by and play|friendly (game|match)|scrimmage/i;
// Instructional/structured programming — never open gym.
const CLASS_RE =
  /clinic|workout|instruction|instructional|training|class|lesson|learn|intro\b|introduction|beginner top|fundamentals|skill|drill|academy|league|tournament|camp\b|karate|\bPE\b|art of|experience:|program\b|mommy|karaoke|dance|yoga|stretch|aerobic|zumba|sculpt|calisthenics|strength|conditioning|roller skate|movement|101\b/i;

function sportFor(title, room) {
  const hay = `${title} ${room}`;
  for (const [id, re] of SPORT_RES) if (re.test(hay)) return id;
  if (GENERIC_GYM_RE.test(title) && /gym/i.test(room)) return 'basketball';
  return null;
}

// true = open drop-in, false = class/structured, null = ambiguous.
function classify(title, desc) {
  if (OPEN_RE.test(title)) return true;
  if (CLASS_RE.test(title)) return false;
  if (CLASS_RE.test(desc)) return false;
  if (OPEN_RE.test(desc)) return true;
  return null;
}

// Audience tag for a block (lib/hours.js TAG_LABELS): youth/teen/55+/women/
// wheelchair; adult & all-ages stay untagged.
function tagFor(title, desc, ages) {
  const hay = `${title} | ${ages}`;
  if (/wheelchair/i.test(hay)) return 'wheelchair';
  if (/girls|women/i.test(hay)) return 'women';
  if (/teen/i.test(hay) && !/adult|senior/i.test(hay)) return 'teen';
  if (/youth|kids|children|junior/i.test(hay) && !/adult|senior/i.test(hay)) return 'youth';
  if (/senior/i.test(hay) && !/adult(?!s? *[,&])/i.test(hay)) return '55+';
  if (/ages? *(\d+) *(?:-|to) *(\d+)/i.test(hay)) {
    const m = hay.match(/ages? *(\d+) *(?:-|to) *(\d+)/i);
    if (Number(m[2]) <= 12) return 'youth';
    if (Number(m[2]) <= 17) return 'teen';
  }
  return null;
}

async function get(url, tries = 2) {
  for (let i = 1; ; i++) {
    try {
      await new Promise((r) => setTimeout(r, PACE_MS));
      const res = await fetchT(url, { headers: { 'User-Agent': UA } }, 20000);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

const strip = (s) =>
  String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;|&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

// "8:00 a" / "12:30 p" -> minutes from midnight.
function toMin(s) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/p/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2] || 0);
}

// Parse one schedule page into { schedule[7], dropins, programs[], ambiguous[] }.
// The table is Mon→Sun; our week arrays are 0=Sun..6=Sat.
function parseSchedule(html, aiCache) {
  const tableM = html.match(/<table class="table schedule-table">([\s\S]*?)<\/table>/);
  if (!tableM) return null;
  const table = tableM[1];
  const days = table.split(/<td>/).slice(1); // 7 cells, Monday first
  if (days.length < 7) return null;

  // Hidden per-program details, page-wide: id -> { title, room, desc, ages }.
  const details = {};
  for (const m of html.matchAll(
    /<div id="(program_\d+)">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>\s*([\s\S]*?)<\/div>/g
  )) {
    const paras = [...m[4].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((p) => strip(p[1]));
    details[m[1]] = {
      title: strip(m[2]),
      room: strip(m[3]),
      desc: paras.filter((p) => !/^(Ages:|Intensity:|Registration)/i.test(p)).join(' '),
      ages: (paras.find((p) => /^Ages:/i.test(p)) || '').replace(/^Ages:\s*/i, ''),
    };
  }

  const schedule = [null, null, null, null, null, null, null];
  const dropins = Object.fromEntries(ALL_SPORTS.map((s) => [s, emptyWeek()]));
  const ambiguous = [];
  let programs = 0;

  days.forEach((cell, i) => {
    const dow = (i + 1) % 7; // Monday cell -> 1, Sunday cell -> 0
    const hoursM = cell.match(/Building Hours<\/strong><br\/>\s*([\d:]+\s*[ap])[^-]*-\s*([\d:]+\s*[ap])/i);
    if (hoursM) {
      const o = toMin(hoursM[1]);
      const c = toMin(hoursM[2]);
      if (o != null && c != null) schedule[dow] = [o, c];
    }
    for (const pm of cell.matchAll(
      /<p class="program">\s*([\d:]+\s*[ap])[^-]*-\s*([\d:]+\s*[ap])[\s\S]*?href="#(program_\d+)"/g
    )) {
      const d = details[pm[3]];
      if (!d) continue;
      programs++;
      if (/outdoor/i.test(d.room)) continue; // outdoor sessions belong to the outdoor pins
      const sport = sportFor(d.title, d.room);
      if (!sport) continue;
      let open = classify(d.title, d.desc);
      if (open == null) {
        const key = `${d.title}|${d.desc.slice(0, 160)}`;
        open = key in aiCache ? aiCache[key] : null;
        if (open == null) {
          ambiguous.push({ key, title: d.title, room: d.room, desc: d.desc.slice(0, 300) });
          continue; // unresolved -> excluded (never show a class as open gym)
        }
      }
      if (!open) continue;
      const start = toMin(pm[1]);
      const end = toMin(pm[2]);
      if (start == null || end == null || end <= start) continue;
      const t = tagFor(d.title, d.desc, d.ages);
      dropins[sport][dow].push(t ? [start, end, t] : [start, end]);
    }
  });

  // Merge/sort each day's blocks for stable output.
  for (const s of Object.keys(dropins)) {
    dropins[s] = dropins[s].map((day) => {
      const seen = new Set();
      return day
        .filter((b) => !seen.has(b.join()) && seen.add(b.join()))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    });
  }
  return { schedule, dropins, programs, ambiguous };
}

// ---- Claude fallback for programs the rules can't settle ---------------------
async function resolveAmbiguous(items, aiCache) {
  const todo = items.filter((it, i, a) => a.findIndex((x) => x.key === it.key) === i);
  if (!todo.length) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`  ⚠ ANTHROPIC_API_KEY not set — ${todo.length} ambiguous program(s) excluded:`);
    for (const it of todo.slice(0, 10)) console.log(`      · ${it.title} (${it.room})`);
    return;
  }
  console.log(`  Classifying ${todo.length} ambiguous program(s) via Claude Haiku…`);
  const list = todo
    .map((it, i) => `${i + 1}. title: ${it.title} | room: ${it.room} | description: ${it.desc}`)
    .join('\n');
  const prompt =
    `These are programs on NYC recreation-center gym schedules. For each, answer whether it is ` +
    `UNSTRUCTURED DROP-IN OPEN PLAY of a sport (open gym / pickup games members just show up to), ` +
    `as opposed to an instructional class, clinic, league, camp, or other structured program. ` +
    `Reply with ONLY a JSON array of ${todo.length} booleans, same order — true = open play.\n\n${list}`;
  try {
    const res = await fetchT('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1));
    todo.forEach((it, i) => {
      if (typeof arr[i] === 'boolean') aiCache[it.key] = arr[i];
    });
    fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(aiCache, null, 2) + '\n');
    console.log(`  ✓ ${todo.filter((it) => aiCache[it.key] === true).length} classified open play`);
  } catch (e) {
    console.log(`  ⚠ classification skipped (${e.message}) — ambiguous programs excluded`);
  }
}

// GeoSearch handles street addresses; intersections ("X Street & Y Blvd") and
// park placements fall through to Nominatim by facility name. Results cached.
async function geocode(name, address, borough, geoCache) {
  const key = `${name}|${address}|${borough}`;
  if (geoCache[key]) return geoCache[key];
  const inNyc = (lat, lng) => lat > 40.4 && lat < 41.0 && lng > -74.3 && lng < -73.6;
  if (address) {
    const url = `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(`${address.replace(/&/g, 'and')}, ${borough}`)}&size=1`;
    try {
      const res = await fetchT(url, { headers: { 'User-Agent': UA } }, 15000);
      const f = res.ok && (await res.json()).features?.[0];
      if (f && inNyc(f.geometry.coordinates[1], f.geometry.coordinates[0])) {
        const [lng, lat] = f.geometry.coordinates;
        geoCache[key] = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
        return geoCache[key];
      }
    } catch {}
  }
  const nUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(`${name}, ${borough}, New York`)}`;
  const res = await fetchT(nUrl, { headers: { 'User-Agent': 'RECreate/1.0 (court data build)' } }, 15000);
  if (!res.ok) throw new Error(`geocode HTTP ${res.status}`);
  const hit = (await res.json())[0];
  if (!hit || !inNyc(Number(hit.lat), Number(hit.lon))) throw new Error(`geocode: no match for ${name}`);
  geoCache[key] = { lat: Number(Number(hit.lat).toFixed(6)), lng: Number(Number(hit.lon).toFixed(6)) };
  return geoCache[key];
}

async function scrapeCenter(id, listName, aiCache, geoCache) {
  const [facility, schedHtml] = await Promise.all([
    get(`${LIST_URL}/${id}`),
    get(`${LIST_URL}/${id}/schedule`),
  ]);
  const parsed = parseSchedule(schedHtml, aiCache);
  if (!parsed) return null;
  // The listing's anchor text is inconsistent (some are just "Details") — the
  // facility page's <h1> is the authoritative name.
  const h1 = facility.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const name = strip((h1 && h1[1]) || listName).replace(/\s*Details( and Schedule)?$/i, '');
  const addrM = facility.match(/(\d+[^<>\n]{2,60}(?:Avenue|Street|Road|Place|Boulevard|Parkway|Drive|Terrace|Walk|Plaza|Concourse|Broadway)[^<>\n]{0,20})/);
  const address = addrM ? strip(addrM[1]) : '';
  const borough = BOROUGH[id[0]] || '';
  let coords = null;
  try {
    coords = await geocode(name, address, borough, geoCache);
  } catch (e) {
    console.log(`  ⚠ ${name}: ${e.message}`);
  }
  return { id, name, address, borough, coords, ...parsed };
}

function buildCourts(centers) {
  return centers
    .filter((c) => c.coords && c.schedule.some(Boolean))
    .map((c) => ({
      id: `nyc-${slug(c.name)}`,
      city: 'nyc',
      name: c.name,
      address: c.address,
      neighborhood: c.borough,
      lat: c.coords.lat,
      lng: c.coords.lng,
      indoor: true,
      schedule: c.schedule,
      dropins: c.dropins,
      source: 'nycparks-indoor',
      notes:
        'NYC Parks recreation center — drop-in open-play times from this week’s posted schedule. NYC Parks membership required for entry (free for 24 and under; see nycgovparks.org).',
      disclaimer: 'Schedules change weekly — verify on nycgovparks.org.',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function render(courts, generatedAt, scheduleSource) {
  const body = courts
    .map(
      (c) => `  {
    id: ${JSON.stringify(c.id)},
    city: "nyc",
    name: ${JSON.stringify(c.name)},
    address: ${JSON.stringify(c.address)},
    neighborhood: ${JSON.stringify(c.neighborhood)},
    lat: ${c.lat},
    lng: ${c.lng},
    indoor: true,
    accessible: ${c.accessible !== false},
    restrooms: true,
    water: true,
    schedule: ${JSON.stringify(c.schedule)},
    dropins: ${JSON.stringify(c.dropins)},
    scheduleSource: ${JSON.stringify(scheduleSource)},
    source: "nycparks-indoor",
    notes: ${JSON.stringify(c.notes)},
    disclaimer: ${JSON.stringify(c.disclaimer)},
  },`
    )
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-nyc-indoor.js — do not edit by hand.
// Regenerate with: npm run build:nyc-indoor
// Generated: ${generatedAt}
//
// NYC Parks recreation centers with indoor open-gym drop-in times, scraped
// from each center's weekly nycgovparks.org schedule (open play only —
// classes/clinics are filtered out; ambiguous programs are classified from
// their own descriptions). Same record shape as data/courts.js:
// schedule[] = BUILDING hours 0=Sun..6=Sat; dropins = { sportId: week } of
// [startMin,endMin,tag?] open-play blocks (tags: youth/teen/55+/women/
// wheelchair). scheduleSource = "live" | "cache".

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const NYC_INDOOR_COURTS = [
${body}
];

export default NYC_INDOOR_COURTS;
`;
}

async function main() {
  console.log('Fetching NYC rec centers…');
  let aiCache = {};
  try {
    aiCache = JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8'));
  } catch {}

  let courts;
  let scheduleSource;
  try {
    const listing = await get(LIST_URL);
    const centers = [];
    for (const m of listing.matchAll(
      /<a href="\/facilities\/recreationcenters\/([A-Z][0-9A-Za-z-]+)">([^<]+?)(?:\s*Details and Schedule)?<\/a>/g
    )) {
      if (!centers.some((c) => c.id === m[1])) centers.push({ id: m[1], name: strip(m[2]) });
    }
    if (centers.length < MIN_CENTERS_OK) throw new Error(`only ${centers.length} centers listed`);
    console.log(`  ${centers.length} centers listed`);

    const prev = loadCache(CACHE_FILE);
    const geoCache = (prev && prev.geoCache) || {};

    // First pass: scrape + rule-based classification, collecting ambiguous.
    const scraped = [];
    const allAmbiguous = [];
    const queue = [...centers];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (;;) {
          const c = queue.shift();
          if (!c) return;
          try {
            const r = await scrapeCenter(c.id, c.name, aiCache, geoCache);
            if (r) {
              scraped.push(r);
              allAmbiguous.push(...r.ambiguous);
            }
          } catch (e) {
            console.log(`  ⚠ ${c.name}: ${e.message}`);
          }
        }
      })
    );

    // Resolve ambiguous programs, then re-scrape the affected schedules so the
    // newly-classified blocks land.
    await resolveAmbiguous(allAmbiguous, aiCache);
    if (allAmbiguous.some((it) => it.key in aiCache)) {
      for (const r of scraped) {
        if (!r.ambiguous.length) continue;
        try {
          const sched = parseSchedule(await get(`${LIST_URL}/${r.id}/schedule`), aiCache);
          if (sched) Object.assign(r, sched);
        } catch {}
      }
    }

    courts = buildCourts(scraped);
    if (courts.length < MIN_CENTERS_OK) {
      throw new Error(`only ${courts.length} centers scraped ok (min ${MIN_CENTERS_OK})`);
    }
    scheduleSource = 'live';
    saveCache(CACHE_FILE, { courts, geoCache, fetchedAt: new Date().toISOString() });
    const count = (sport) => courts.filter((c) => c.dropins[sport].some((d) => d.length)).length;
    console.log(
      `  ✓ ${courts.length} centers — ${count('basketball')} basketball, ${count('volleyball')} volleyball, ` +
        `${count('pingpong')} ping pong, ${count('badminton')} badminton, ${count('pickleball')} pickleball, ` +
        `${count('weightroom')} weight room (live)`
    );
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !Array.isArray(cache.courts)) {
      throw new Error(`scrape failed (${e.message}) and no cache available — ${OUT_FILE} left unchanged`);
    }
    courts = cache.courts;
    scheduleSource = 'cache';
    console.log(`  ↺ scrape failed (${e.message}); using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, render(courts, new Date().toISOString(), scheduleSource));
  console.log(`\n✅ Wrote ${courts.length} NYC indoor centers to data/cities/nyc/indoor-courts.js (${scheduleSource})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
