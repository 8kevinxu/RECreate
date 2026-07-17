#!/usr/bin/env node
/*
 * Build data/outdoor-courts.js — SF Recreation & Parks OUTDOOR courts & fields
 * (basketball + tennis + pickleball + soccer + baseball). Run: npm run build:outdoor
 *
 * Source: the DataSF "Recreation and Parks Facilities" dataset (ib5c-xgwu) — the
 * same one build-indoor-courts.js uses for coordinates. We pull the court/field
 * facility types and map each to the sport(s) it offers:
 *   Basketball Court            -> basketball
 *   Tennis Court                -> tennis
 *   Pickleball Courts           -> pickleball
 *   Tennis/Pickleball Court     -> tennis + pickleball (one surface lined for both)
 *   Volleyball Court            -> volleyball (outdoor sand/asphalt courts)
 *   Soccer Field                -> soccer
 *   Multi-Use Turf              -> soccer (synthetic turf; also football/lacrosse)
 *   Ball Field                  -> baseball (baseball/softball diamonds)
 *   Adult Fitness Court/Course  -> weightroom (outdoor fitness equipment — joins the
 *                                  map's weight-room facility view alongside the
 *                                  rec-center weight rooms)
 *
 * Outdoor courts have no posted drop-in schedule — they're first-come during park
 * hours — so each is modeled as open a fixed daily window (PARK_HOURS) with its
 * sport(s) available across all of it. Records are grouped by park, so a park with
 * several court records becomes one pin offering the union of its sports.
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (outdoor-courts-cache.json), with a gate that aborts (keeping the existing data
 * file) if too few courts come back.
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'outdoor-courts-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'outdoor-courts.js');

const DATASF =
  'https://data.sfgov.org/resource/ib5c-xgwu.json?' +
  '$select=property_name,facility_type,address,analysis_neighborhood,latitude,longitude&' +
  "$where=facility_type in('Basketball Court','Tennis Court','Tennis/Pickleball Court','Pickleball Courts','Volleyball Court','Soccer Field','Multi-Use Turf','Ball Field','Adult Fitness Court/Course')&$limit=500";

// Abort (keep last-good data) if fewer than this many courts come back.
const MIN_COURTS_OK = 20;

const time = (h, m = 0) => h * 60 + m;

// First-come outdoor courts have no posted schedule; treat them as open a fixed
// daily daytime window (approx. park hours) every day of the week.
const PARK_HOURS = [time(8), time(20)]; // 8 AM – 8 PM
const parkSchedule = () => Array.from({ length: 7 }, () => [...PARK_HOURS]);
// One drop-in block per open day spanning the window — "available all open hours".
const allOpenHoursWeek = (sched) => sched.map((h) => (h ? [[h[0], h[1]]] : []));

// All tracked sports (keep in sync with lib/sports.js) + the weight-room facility
// view; every court carries a week for each so the dropins shape is uniform.
const ALL_SPORTS = ['basketball', 'volleyball', 'pingpong', 'badminton', 'pickleball', 'tennis', 'soccer', 'baseball', 'weightroom'];
const emptyWeek = () => [[], [], [], [], [], [], []];

// Which sport(s) each outdoor court/field facility type offers. SF's fields are
// strictly designated by type (verified against DataSF): soccer = dedicated
// "Soccer Field" + "Multi-Use Turf" (synthetic turf, also football/lacrosse);
// baseball = "Ball Field" (baseball/softball diamonds). A single field is never
// both — parks that offer both simply contain a separate pitch and diamond, which
// this build unions onto one pin (like a park with both a basketball & tennis court).
const TYPE_SPORTS = {
  'Basketball Court': ['basketball'],
  'Tennis Court': ['tennis'],
  'Pickleball Courts': ['pickleball'],
  'Tennis/Pickleball Court': ['tennis', 'pickleball'],
  'Volleyball Court': ['volleyball'],
  'Soccer Field': ['soccer'],
  'Multi-Use Turf': ['soccer'],
  'Ball Field': ['baseball'],
  'Adult Fitness Court/Course': ['weightroom'],
};

// The dataset covers all SFRPD property, including Camp Mather (Yosemite) and other
// out-of-area holdings. Keep only the greater-SF area (SF proper plus the adjacent
// Sharp Park / San Bruno assets the app already covers).
const IN_AREA = (lat, lng) => lat > 37.5 && lat < 37.9 && lng > -122.6 && lng < -122.2;

// DataSF (by property_name) that are INDOOR-only rec centers whose gym court it
// tags as a plain "Basketball Court" — with no indoor/outdoor field to tell them
// apart, they'd surface as phantom always-open outdoor courts duplicating the
// indoor record from build-indoor-courts.js. Skip them here. (Only list a facility
// once confirmed it has no real outdoor courts — many rec-center parks legitimately
// do.) Gene Friend (270 6th St, SoMa) is an indoor-only gym, currently under
// renovation, so its DataSF "Basketball Court" is the indoor court, not outdoor.
const EXCLUDE_PROPERTIES = new Set(['Eugene Friend Rec Center']);

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Order a park's sports for readable notes/labels ('weightroom' reads as its
// facility, not a sport).
const ORDER = ['basketball', 'volleyball', 'tennis', 'pickleball', 'soccer', 'baseball', 'weightroom'];
const LABEL = { weightroom: 'fitness equipment' };
const ordered = (sports) => ORDER.filter((s) => sports.includes(s));

// SF Rec's designated open-play soccer fields (sfrecpark.org/508/Open-Play). The
// page posts no online hours, so this only adds an informational note; matched
// loosely by property_name keyword against DataSF's soccer/turf records.
const OPEN_PLAY_KEYS = [
  'beach chalet', 'crocker', 'garfield', 'kimbell', 'minnie', 'mission playground', 'silver terrace', 'south sunset',
];
const isOpenPlaySoccer = (name) => {
  const n = (name || '').toLowerCase();
  return OPEN_PLAY_KEYS.some((k) => n.includes(k));
};

function noteFor(sports, sharedTennis) {
  const list = ordered(sports).map((s) => LABEL[s] || s).join(' & ');
  // Neutral noun: a park pin can mix courts (basketball/tennis) and fields (soccer).
  let n = `Outdoor ${list} — first-come, open during park hours (no posted drop-in schedule).`;
  if (sharedTennis && sports.includes('pickleball') && sports.includes('tennis')) {
    n += ' Pickleball shares the tennis courts (lined for both).';
  } else if (sharedTennis && sports.includes('pickleball')) {
    n += ' Played on tennis courts lined for pickleball.';
  }
  return n;
}

// ---- Golden Gate Park pick-up volleyball -------------------------------------
// sfrecpark.org/1830 designates rotating no-permit grass meadows in GGP for
// volleyball — one set of meadows open in odd months, another in even months,
// with occasional closures for turf recovery. DataSF has no record of these, so
// we scrape the page into one synthetic park pin (volleyball only). If the page
// won't parse, the pin ships with a static note pointing at the page.
const VB_URL = 'https://sfrecpark.org/1830/Pick-Up-Volleyball';
const VB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VB_FALLBACK_NOTE =
  'No-permit volleyball on rotating Golden Gate Park grass meadows (one set odd months, another even) — see sfrecpark.org/1830 for current areas. Max 4 standard nets; bring your own.';

async function ggpVolleyballNote() {
  const res = await fetch(VB_URL, { headers: { 'User-Agent': VB_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text())
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&apos;|&#8217;|&rsquo;/g, "'")
    .replace(/&#8211;|&ndash;/g, '-');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const groups = { odd: [], even: [] };
  let cur = null;
  for (const line of lines) {
    if (/^Additional information/i.test(line)) break;
    if (/^Open January/i.test(line)) cur = 'odd';
    else if (/^Open February/i.test(line)) cur = 'even';
    else if (cur && /\b(meadow|fields?)\b/i.test(line) && !/^(please|areas|-)/i.test(line)) {
      groups[cur].push(line.replace(/\s*-\s*$/, ''));
    } else if (cur && /closed/i.test(line) && groups[cur].length) {
      groups[cur][groups[cur].length - 1] += ' (closed for turf recovery)';
    } else if (cur && /^\(.+\)$/.test(line) && groups[cur].length) {
      groups[cur][groups[cur].length - 1] += ' ' + line;
    }
  }
  if (!groups.odd.length || !groups.even.length) {
    throw new Error('meadow groups not found — page layout changed?');
  }
  return (
    'No-permit volleyball on rotating Golden Gate Park meadows. ' +
    `Odd months (Jan/Mar/May/Jul/Sep/Nov): ${groups.odd.join(', ')}. ` +
    `Even months (Feb/Apr/Jun/Aug/Oct/Dec): ${groups.even.join(', ')}. ` +
    'Max 4 standard nets — bring your own.'
  );
}

async function ggpVolleyball() {
  let notes = VB_FALLBACK_NOTE;
  try {
    notes = await ggpVolleyballNote();
    console.log('  ✓ GGP volleyball meadows scraped from sfrecpark.org/1830');
  } catch (e) {
    console.log(`  ⚠ GGP volleyball page: ${e.message} — using static note`);
  }
  const week = () => Array.from({ length: 7 }, () => []);
  const daylight = Array.from({ length: 7 }, () => [[480, 1200]]);
  const dropins = {};
  for (const s of ORDER) dropins[s] = week();
  dropins.volleyball = daylight;
  return {
    id: 'ggp-volleyball-meadows',
    name: 'Golden Gate Park Volleyball Meadows',
    address: 'Golden Gate Park (JFK Dr area)',
    neighborhood: 'Golden Gate Park',
    lat: 37.77,
    lng: -122.459,
    schedule: Array.from({ length: 7 }, () => [480, 1200]),
    dropins,
    notes,
  };
}

// Group DataSF records by park; union the sports across that park's court records.
function buildCourts(rows) {
  const byPark = new Map();
  for (const r of rows) {
    const sports = TYPE_SPORTS[r.facility_type];
    if (!sports || !r.latitude || !r.longitude) continue;
    if (!IN_AREA(Number(r.latitude), Number(r.longitude))) continue;
    if (EXCLUDE_PROPERTIES.has(r.property_name)) continue;
    let p = byPark.get(r.property_name);
    if (!p) {
      p = {
        name: r.property_name,
        address: r.address || '',
        neighborhood: r.analysis_neighborhood || '',
        lat: Number(Number(r.latitude).toFixed(6)),
        lng: Number(Number(r.longitude).toFixed(6)),
        sports: new Set(),
        sharedTennis: false,
      };
      byPark.set(r.property_name, p);
    }
    sports.forEach((s) => p.sports.add(s));
    if (r.facility_type === 'Tennis/Pickleball Court') p.sharedTennis = true;
  }

  const sched = parkSchedule();
  return [...byPark.values()]
    .map((p) => {
      const offered = [...p.sports];
      const dropins = Object.fromEntries(ALL_SPORTS.map((s) => [s, emptyWeek()]));
      for (const s of offered) dropins[s] = allOpenHoursWeek(sched);
      return {
        id: `${slug(p.name)}-outdoor`,
        name: p.name,
        address: p.address,
        neighborhood: p.neighborhood,
        lat: p.lat,
        lng: p.lng,
        indoor: false,
        schedule: sched,
        dropins,
        source: 'sfrecpark-outdoor',
        notes:
          noteFor(offered, p.sharedTennis) +
          (offered.includes('soccer') && isOpenPlaySoccer(p.name)
            ? ' Designated SF Rec open-play soccer field.'
            : ''),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function render(courts, generatedAt, scheduleSource) {
  const body = courts
    .map(
      (c) => `  {
    id: ${JSON.stringify(c.id)},
    name: ${JSON.stringify(c.name)},
    address: ${JSON.stringify(c.address)},
    neighborhood: ${JSON.stringify(c.neighborhood)},
    lat: ${c.lat},
    lng: ${c.lng},
    indoor: false,
    schedule: ${JSON.stringify(c.schedule)},
    dropins: ${JSON.stringify(c.dropins)},
    scheduleSource: ${JSON.stringify(scheduleSource)},
    source: "sfrecpark-outdoor",
    notes: ${JSON.stringify(c.notes)},
    disclaimer: "Outdoor public courts — first-come; verify on sfrecpark.org.",
  },`
    )
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-outdoor-courts.js — do not edit by hand.
// Regenerate with: npm run build:outdoor
// Generated: ${generatedAt}
//
// SF Recreation & Parks OUTDOOR courts (basketball + tennis + pickleball), from
// the DataSF facilities dataset (ib5c-xgwu). One pin per park, offering the union
// of the sports its court records list. These are first-come public courts with
// no posted drop-in schedule, so each is modeled as open a fixed daily park-hours
// window with its sport(s) available across all of it.
//
// schedule[]   = approx. park hours, indexed 0=Sun..6=Sat; [openMin,closeMin].
// dropins      = { sportId: week }; offered sports span the open window, others
//   are empty so the court only appears under its sport(s)' toggle.
// scheduleSource = "datasf" (fetched this run) | "cache" (last good).

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const OUTDOOR_COURTS = [
${body}
];

export default OUTDOOR_COURTS;
`;
}

async function main() {
  console.log('Fetching outdoor courts from DataSF…');
  let courts;
  let scheduleSource;

  try {
    const res = await fetch(DATASF, { headers: { 'User-Agent': 'RECreateSF/1.0', Accept: '*/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    courts = buildCourts(rows);
    if (courts.length < MIN_COURTS_OK) {
      throw new Error(`only ${courts.length} courts (min ${MIN_COURTS_OK}) — dataset may have changed`);
    }
    scheduleSource = 'datasf';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ courts, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
    const count = (sport) => courts.filter((c) => c.dropins[sport].some((d) => d.length)).length;
    console.log(
      `  ✓ ${courts.length} parks — ${count('basketball')} basketball, ` +
        `${count('volleyball')} volleyball, ${count('tennis')} tennis, ` +
        `${count('pickleball')} pickleball, ${count('soccer')} soccer, ` +
        `${count('baseball')} baseball, ${count('weightroom')} fitness courts (live)`
    );
  } catch (e) {
    const cache = loadCache();
    if (!cache || !Array.isArray(cache.courts)) {
      throw new Error(`fetch failed (${e.message}) and no cache available — data/outdoor-courts.js left unchanged`);
    }
    courts = cache.courts;
    scheduleSource = 'cache';
    console.log(`  ↺ fetch failed (${e.message}); using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  // Synthetic GGP volleyball pin (scraped from sfrecpark.org/1830, not DataSF).
  // Cache-safe: drop any prior copy before appending, then keep the name sort.
  const vb = await ggpVolleyball();
  courts = courts.filter((c) => c.id !== vb.id).concat(vb);
  courts.sort((a, b) => a.name.localeCompare(b.name));

  const generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT_FILE, render(courts, generatedAt, scheduleSource));
  console.log(`\n✅ Wrote ${courts.length} outdoor courts to data/outdoor-courts.js (${scheduleSource})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
