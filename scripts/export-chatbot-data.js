#!/usr/bin/env node
// Data bridge: the app's world, as JSON the Python assistant can read.
//
//   npm run export:chatbot        (re-run whenever data/ changes)
//
// The app's data lives in ESM `.js` modules that also import each other and the
// app's runtime helpers, so this bundles each with esbuild (same trick as
// scripts/check-app.js) and reads the exports.
//
// This script is deliberately the ONLY place that understands how the app
// assembles a court. It reproduces what lib/useCourts.js does at launch —
// union every source, attach rec.us booked-% and the SFRP directory facts, let a
// posted `playWeek` override the generic hours — and then goes one step further:
//
//   it RESOLVES each court's weekly drop-in schedule by calling the app's own
//   lib/hours.js `resolveDropinWeek()`, open-play carve-outs and all.
//
// That last step is why the Python side has no schedule logic to keep in sync.
// It receives a finished 7-day grid of [startMin, endMin, tag?] blocks and only
// has to ask "is the asked-about moment inside one of these?". The subtle part
// (which source wins, how open-play is subtracted) happens once, here, in the
// same function the app itself renders from — so the assistant can never
// disagree with the screen.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'chatbot', 'data');

// lib/hours.js imports lib/i18n.js for localized labels, which drags in React,
// JSX and AsyncStorage — none of which belong in a data script. Everything we
// export is raw data (minutes, ids, scraped text), so the localizer is stubbed to
// an identity: the functions we call here never emit a user-facing string.
const stubI18n = {
  name: 'stub-i18n',
  setup(build) {
    build.onResolve({ filter: /(^|\/)i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const tg = (k) => k; export default { tg };',
      loader: 'js',
    }));
  },
};

// Bundle an app module to CJS and return its exports.
async function load(relFile) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, relFile)],
    bundle: true,
    format: 'cjs',
    write: false,
    logLevel: 'silent',
    platform: 'node',
    loader: { '.js': 'jsx' }, // app .js files may contain JSX (same as check-app.js)
    plugins: [stubI18n],
  });
  const bundled = built.outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', bundled)(mod, mod.exports);
  return mod.exports;
}

// JSON you can actually read. Plain JSON.stringify(x, null, 2) is worse than
// useless for this data: it explodes every [startMin, endMin] pair across five
// lines and buries the schedule grid. This indents objects but keeps arrays of
// primitives on one line, so a week renders as one line per weekday:
//   "basketball": [
//     [],
//     [[540,1020],[1080,1260]],
//     ...
const MAX_INLINE = 110;
function pretty(v, pad = '') {
  const inner = pad + '  ';
  const primitive = (x) => x === null || typeof x !== 'object';

  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(primitive)) return JSON.stringify(v);
    // A day's blocks / a facility schedule: array of primitive-arrays. Inline
    // when it fits, so the shape stays visible at a glance.
    if (v.every((x) => primitive(x) || (Array.isArray(x) && x.every(primitive)))) {
      const oneLine = JSON.stringify(v);
      if (oneLine.length <= MAX_INLINE) return oneLine;
    }
    return `[\n${v.map((x) => inner + pretty(x, inner)).join(',\n')}\n${pad}]`;
  }

  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined);
    if (!keys.length) return '{}';
    const body = keys.map((k) => `${inner}${JSON.stringify(k)}: ${pretty(v[k], inner)}`);
    return `{\n${body.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(v);
}

const withCity = (arr, fallback) => (arr || []).map((r) => ({ ...r, city: r.city || fallback }));
const omit = (obj, keys) =>
  Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !keys.includes(k)));

// NYC's Socrata records abbreviate what SF's directory spells out. Renaming here
// means one amenity vocabulary reaches the assistant, so "which courts have
// lights" works in both cities off the same field.
const FACT_ALIASES = { n: 'total', lit: 'lights', surf: 'surface' };

// Amenities recorded per park rather than per sport. A filter asks "does this
// court have X", so they're copied onto each sport the park offers.
const COURT_LEVEL_FACTS = ['accessible', 'water', 'restrooms'];

function normalizeFacts(court, sports) {
  const shared = {};
  for (const key of COURT_LEVEL_FACTS) {
    if (court[key] !== undefined) shared[key] = court[key];
  }
  const raw = court.facts || {};
  const sportsWithFacts = new Set([...Object.keys(raw), ...(Object.keys(shared).length ? sports : [])]);
  if (!sportsWithFacts.size) return undefined;

  const out = {};
  for (const sport of sportsWithFacts) {
    const entry = { ...shared };
    for (const [key, value] of Object.entries(raw[sport] || {})) {
      entry[FACT_ALIASES[key] || key] = value;
    }
    out[sport] = entry;
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { resolveDropinWeek } = await load('lib/hours.js');
  const { CITIES } = await load('lib/cities.js');

  // ---- 1. Union every court source, exactly like lib/useCourts.js ----------
  const { COURTS } = await load('data/courts.js');
  const { OUTDOOR_COURTS } = await load('data/outdoor-courts.js');
  const { MANUAL_COURTS } = await load('data/manual-courts.js');
  const { SANBRUNO_COURTS } = await load('data/sanbruno-court.js');
  const { POOL_COURTS } = await load('lib/poolCourts.js'); // the 9 pools, shaped as swimming courts
  const { CITY_COURTS, CITY_CLASSES } = await load('data/cities/index.js');

  const all = [
    ...withCity(COURTS, 'sf'),
    ...withCity(OUTDOOR_COURTS, 'sf'),
    ...withCity(MANUAL_COURTS, 'sf'),
    ...withCity(SANBRUNO_COURTS, 'sf'),
    ...withCity(POOL_COURTS, 'sf'),
    // CITY_COURTS = { nyc: [...] } — those records already carry their own city.
    ...Object.entries(CITY_COURTS).flatMap(([city, list]) => withCity(list, city)),
  ];
  const seen = new Set();
  const merged = all.filter((c) => c && (seen.has(c.id) ? false : seen.add(c.id)));

  // ---- 2. Attach reservations + directory, honoring a posted playWeek ------
  const { RESERVATIONS } = await load('data/reservations.js');
  const { DIRECTORY } = await load('data/court-directory.js');

  const courts = merged.map((c) => {
    const dir = DIRECTORY[c.id];
    const reserved = RESERVATIONS[c.id];

    // A posted `playWeek` is authoritative — it REPLACES the generic daylight
    // hours for that sport, same as useCourts does, so what we resolve below is
    // what the app shows.
    let dropins = c.dropins || {};
    if (dir) {
      for (const [sport, entry] of Object.entries(dir)) {
        if (entry && entry.playWeek && dropins[sport]) {
          dropins = { ...dropins, [sport]: entry.playWeek };
        }
      }
    }

    // ---- 3. Resolve each sport's week with the app's own logic -------------
    // openPlayWeek (shared-use windows) gets carved out of the base blocks here,
    // so the grid we ship has no overlaps and needs no further interpretation.
    // Sports with an all-empty week are dropped entirely: a court's `dropins` map
    // carries a key for every sport the venue *could* host, so keeping the empty
    // ones would make "does Mission have volleyball?" read as "yes, but closed"
    // rather than "no". Presence in `weeks` means the sport is actually offered.
    const weeks = {};
    for (const sport of Object.keys(dropins)) {
      const week = resolveDropinWeek({ ...c, dropins }, sport, dir?.[sport]?.openPlayWeek);
      // Normalize to a dense 7-element array so Python can index it blindly.
      const dense = Array.from({ length: 7 }, (_, d) => week[d] || []);
      if (dense.some((d) => d.length)) weeks[sport] = dense;
    }

    // Facility facts minus the two schedule fields — they're already baked into
    // `weeks`, and shipping a second copy invites the assistant to read the
    // wrong one.
    //
    // Two sources with different vocabularies: SF's directory spells things out
    // (`lights`, `total`), NYC's Socrata records abbreviate (`lit`, `n`). They
    // are normalized to one set of names here so a question like "courts with
    // lights" is answerable in either city without per-city special-casing
    // downstream. Court-level amenities (accessible, water, restrooms) are
    // folded onto each sport, because that's the level a filter asks at.
    const facts = dir
      ? Object.fromEntries(
          Object.entries(dir).map(([sport, e]) => [sport, omit(e, ['playWeek', 'openPlayWeek'])])
        )
      : normalizeFacts(c, Object.keys(weeks));

    return {
      id: c.id,
      name: c.name,
      city: c.city,
      address: c.address || null,
      neighborhood: c.neighborhood || null,
      lat: c.lat,
      lng: c.lng,
      phone: c.phone || null,
      indoor: !!c.indoor,
      sports: Object.keys(weeks),
      schedule: c.schedule || null, // facility open/close, [openMin, closeMin]|null x7
      weeks, // sport -> 7 x [[startMin, endMin, tag?], ...]
      ...(facts && { facts }),
      ...(reserved && { reserved }), // rec.us "% booked" snapshot
      ...(c.pool && { pool: c.pool }), // full pool detail (sessions/fees ride here)
      ...(c.golf && { golf: c.golf }),
      ...(c.notes && { notes: c.notes }),
      ...(c.booking && { booking: c.booking }),
      ...(c.subregion && { subregion: c.subregion }),
    };
  });

  // ---- 4. Classes -----------------------------------------------------------
  const { CLASSES, CLASS_CATEGORIES } = await load('data/classes.js');
  const classes = [
    ...withCity(CLASSES, 'sf'),
    ...Object.entries(CITY_CLASSES).flatMap(([city, list]) => withCity(list, city)),
  ];

  // ---- 5. Reference tables --------------------------------------------------
  const pools = await load('data/pools.js');

  const files = {
    'courts.json': courts,
    'classes.json': classes,
    'reference.json': {
      generatedAt: new Date().toISOString(),
      // Conventions used throughout courts.json, spelled out for whoever reads
      // these files by eye (they match the app's own data/*.js conventions).
      format: {
        weekIndex: '0=Sunday .. 6=Saturday',
        times: 'minutes from midnight, local to the court city (540 = 9:00 AM, 1020 = 5:00 PM)',
        block: '[startMin, endMin] or [startMin, endMin, tag] where tag restricts the session',
        tags: ['women', 'wheelchair', '55+', 'openplay', 'reservable', 'youth', 'teen'],
        schedule: 'facility open/close per weekday, or null when closed that day',
        weeks: 'sport -> 7 weekdays of drop-in blocks; a sport is absent when not offered',
      },
      cities: CITIES,
      classCategories: CLASS_CATEGORIES,
      poolFees: pools.POOL_FEES,
      poolClosures: pools.POOL_CLOSURES,
      poolSessionKinds: pools.POOL_SESSION_KINDS,
    },
  };
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT_DIR, name), pretty(data) + '\n');
  }

  // ---- Report + a loose sanity gate ----------------------------------------
  const byCity = (arr) => arr.reduce((m, r) => ((m[r.city] = (m[r.city] || 0) + 1), m), {});
  const withWeeks = courts.filter((c) => c.sports.length).length;
  const sports = new Set(courts.flatMap((c) => c.sports));

  console.log('Exported → chatbot/data/');
  console.log(`  courts:  ${courts.length}`, byCity(courts), `(${withWeeks} with drop-in hours)`);
  console.log(`  sports:  ${[...sports].sort().join(', ')}`);
  console.log(`  classes: ${classes.length}`, byCity(classes));

  // Catch a gutted export before the assistant starts answering from nothing.
  if (courts.length < 500 || classes.length < 200 || withWeeks < 200) {
    console.error('\n✖ Export looks too small — refusing to call this good. Check data/.');
    process.exit(1);
  }
  console.log('\n✅ Looks healthy.');
}

main();
