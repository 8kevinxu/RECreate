// SEO post-build pass for the web export (npm run build:web) — runs AFTER
// `npx expo export --platform web` and rewrites/augments `dist/` in place:
//
//   1. Injects real <head> metadata into dist/index.html (title, description,
//      canonical, OpenGraph/Twitter cards, JSON-LD, App Store smart banner) —
//      the raw Expo export ships an empty-bodied SPA shell that gives crawlers
//      nothing to index.
//   2. Emits static, crawlable landing pages from the bundled data, per city —
//      SF at /basketball, /pickleball, …, /golf, /pools, /classes and NYC under
//      the /nyc prefix — each a real HTML document (h1, court list with
//      addresses + drop-in hours, SportsActivityLocation JSON-LD) linking into
//      the app via the URL-state params (lib/urlState.web.js). Both hosts serve
//      real files before the SPA rewrite, so these coexist with the app.
//   3. Emits sitemap.xml + robots.txt and copies the app icon to /og.png.
//
// SF paths are LOAD-BEARING: /basketball, /pools, /classes … are already indexed,
// so their URLs must not move. New cities take a path prefix instead.
//
// Court/pool/class content comes from the same generated data/ modules the app
// bundles, so the weekly refresh crons keep these pages current on the next
// deploy. Loaded via esbuild→CJS like scripts/check-app.js (the files are ESM).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SITE = 'https://playrecreate.com';
const SITE_NAME = 'RECreate';
const APP_STORE_ID = '6786438986';
const APP_STORE_URL = `https://apps.apple.com/us/app/recreate-recreation-made-easy/id${APP_STORE_ID}`;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('✗ dist/index.html not found — run `npx expo export --platform web` first');
  process.exit(1);
}

// --- load the bundled ESM data modules (same technique as check-app.js) -----

function loadModule(file) {
  const bundled = esbuild.buildSync({
    entryPoints: [path.join(ROOT, file)],
    bundle: true,
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', bundled)(mod, mod.exports);
  return mod.exports;
}

const { COURTS } = loadModule('data/courts.js');
const { OUTDOOR_COURTS } = loadModule('data/outdoor-courts.js');
const { MANUAL_COURTS } = loadModule('data/manual-courts.js');
const { SANBRUNO_COURTS } = loadModule('data/sanbruno-court.js');
const { POOLS, POOL_FEES } = loadModule('data/pools.js');
// SF's catalog is ActiveNet + the Rec & Park volunteer workparties, merged the
// same way the app merges them (data/sf-classes.js) so the prerendered /classes
// page lists exactly what the app does.
const { CLASS_CATEGORIES } = loadModule('data/classes.js');
const { SF_CLASSES } = loadModule('data/sf-classes.js');
const { DIRECTORY } = loadModule('data/court-directory.js');
const { RESERVATIONS } = loadModule('data/reservations.js');
const { SPORTS } = loadModule('lib/sports.js');
const { CITY_COURTS, CITY_CLASSES } = loadModule('data/cities/index.js');
const { PARK_HOURS: NYC_PARK_HOURS } = loadModule('data/cities/nyc/outdoor-courts.js');
const { NYC_POOLS, SEASON: NYC_POOL_SEASON } = loadModule('data/cities/nyc/pools.js');
const { LIGHTS: NYC_LIGHTS } = loadModule('data/cities/nyc/reservations.js');

// Same merge as lib/useCourts.js: bundled indoor list first, extras deduped by id.
const ids = new Set(COURTS.map((c) => c.id));
const SF_COURTS = COURTS.concat(
  [...MANUAL_COURTS, ...SANBRUNO_COURTS, ...OUTDOOR_COURTS].filter((c) => !ids.has(c.id))
);

// --- small formatting helpers ------------------------------------------------

const TODAY = new Date().toISOString().slice(0, 10);

// A class that has already finished is not on offer. See the classes section.
const isCurrentClass = (c) => !c.end || c.end >= TODAY;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Subregion name as it reads after "in" — the Bronx is the one that takes an
// article, and "basketball courts in the bronx" is how people search for it.
const inArea = (name) => (name === 'Bronx' ? 'the Bronx' : name);

const fmtTime = (min) => {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h = h24 % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')} ${ampm}` : `${h} ${ampm}`;
};

// How a city's first-come outdoor window reads on a landing page. Where the
// city closes at real dusk (NYC), printing a single clock time would be a lie
// for most of the year — dusk there swings ~4 hours between December and June —
// so say "to dusk" and name the floodlit exception when the court has one.
// `court` is optional: omitted for the whole-page label, passed for one pin.
function parkHoursPhrase(cfg, court) {
  const open = fmtTime(cfg.parkHours[0]);
  if (!cfg.duskClose) return `park hours ${open}–${fmtTime(cfg.parkHours[1])} daily`;
  const lit = court && cfg.lights && cfg.lights[court.id];
  if (!lit) return `${open} to dusk daily`;
  // Name WHICH sport has the lights. A park often floodlights its soccer pitch
  // and nothing else, so a bare "lit courts until 11 PM" would read as though
  // the basketball court on the same page stayed open too.
  const byTime = new Map();
  for (const [sport, end] of Object.entries(lit)) {
    if (!byTime.has(end)) byTime.set(end, []);
    byTime.get(end).push(sport);
  }
  const clauses = [...byTime.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([end, sports]) => `lit ${sports.sort().join(' & ')} until ${fmtTime(end)}`);
  return `${open} to dusk daily, ${clauses.join(', ')}`;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // display Mon..Sun

const fmtBlocks = (blocks) =>
  blocks.map((b) => `${fmtTime(b[0])}–${fmtTime(b[1])}${b[2] ? ` (${b[2]})` : ''}`).join(', ');

// Compress a dropins week into "Mon–Fri 8 AM–8 PM · Sat 9 AM–5 PM" style lines,
// grouping consecutive display days with identical blocks.
function weekSummary(week) {
  if (!week) return '';
  const sig = (d) => (week[d] || []).map((b) => b.join('/')).join('|');
  const groups = [];
  for (const d of DAY_ORDER) {
    if (!sig(d)) continue;
    const last = groups[groups.length - 1];
    if (last && last.sig === sig(d) && DAY_ORDER.indexOf(d) === DAY_ORDER.indexOf(last.days[last.days.length - 1]) + 1) {
      last.days.push(d);
    } else {
      groups.push({ sig: sig(d), days: [d] });
    }
  }
  return groups
    .map((g) => {
      const label =
        g.days.length > 2
          ? `${DAY_ABBR[g.days[0]]}–${DAY_ABBR[g.days[g.days.length - 1]]}`
          : g.days.map((d) => DAY_ABBR[d]).join(', ');
      return `${label} ${fmtBlocks(week[g.days[0]])}`;
    })
    .join(' · ');
}

// Full day-by-day rows for a detail page — the compressed weekSummary is right
// for a list of 90 courts, but a court's own page should show the whole week.
function dayRows(week) {
  if (!week) return [];
  return DAY_ORDER.filter((d) => week[d]?.length).map((d) => [DAY_ABBR[d], fmtBlocks(week[d])]);
}

// Union of every sport's drop-in blocks, merged — "when can I play here at all",
// which is what schema.org openingHoursSpecification means for a venue.
const LD_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function openingHours(c) {
  const spec = [];
  for (let d = 0; d < 7; d++) {
    const blocks = [];
    for (const s of SPORTS) for (const b of c.dropins?.[s.id]?.[d] || []) blocks.push([b[0], b[1]]);
    if (!blocks.length) continue;
    blocks.sort((a, b) => a[0] - b[0]);
    const merged = [blocks[0].slice()];
    for (const b of blocks.slice(1)) {
      const last = merged[merged.length - 1];
      if (b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
      else merged.push(b.slice());
    }
    const hhmm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    for (const [a, b] of merged) {
      spec.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: LD_DAYS[d], opens: hhmm(a), closes: hhmm(b) });
    }
  }
  return spec.length ? spec : undefined;
}

const MILES_PER_DEG = 69.09;
function milesBetween(a, b) {
  if (!a?.lat || !a?.lng || !b?.lat || !b?.lng) return null;
  const dLat = (a.lat - b.lat) * MILES_PER_DEG;
  const dLng = (a.lng - b.lng) * MILES_PER_DEG * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}
// "under" rather than "<": this string is interpolated straight into HTML, and
// a bare < opens a bogus tag that swallows the rest of the element.
const fmtMiles = (m) => (m < 0.1 ? 'under 0.1 mi' : `${m.toFixed(m < 10 ? 1 : 0)} mi`);

// "basketball, tennis and soccer" — a trailing comma list reads like an error.
const andList = (arr) =>
  arr.length < 2 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;

// Per-court facility facts (NYC's Socrata attrs). Cities without them render
// hours instead — see courtLi.
const UNIT = { baseball: ['diamond', 'diamonds'], soccer: ['field', 'fields'] };
const FACT_LABEL = {
  full: 'full court', half: 'half court', adult: 'adult diamond',
  regulation: 'regulation pitch', reservable: 'permit required',
};
function factsLine(c, sportId) {
  const f = c.facts?.[sportId];
  const bits = [];
  if (f) {
    if (f.n) {
      const [one, many] = UNIT[sportId] || ['court', 'courts'];
      bits.push(`${f.n} ${f.n === 1 ? one : many}`);
    }
    if (f.lit) bits.push('lights');
    for (const k of ['full', 'half', 'adult', 'regulation', 'reservable']) if (f[k]) bits.push(FACT_LABEL[k]);
    // Socrata surfaces arrive as "Synthetic - Multi", "Synthetic - Large" …
    // Keep the material, drop the sub-grade, dedupe: "natural/synthetic".
    if (f.surf?.length) {
      const mats = [...new Set(f.surf.map((s) => String(s).split(' - ')[0].trim().toLowerCase()).filter(Boolean))];
      if (mats.length) bits.push(mats.join('/'));
    }
  }
  if (c.accessible) bits.push('accessible');
  if (c.restrooms) bits.push('restrooms');
  if (c.water) bits.push('water');
  return bits.join(' · ');
}

// --- city configuration --------------------------------------------------------
//
// Everything city-specific lives here so a third city is a config entry plus its
// data module. `prefix` is '' for SF only — its paths are already indexed.

const CITY_CFG = [
  {
    id: 'sf',
    name: 'San Francisco',
    shortName: 'SF',
    prefix: '',
    region: 'CA',
    locality: () => 'San Francisco',
    courts: SF_COURTS,
    classes: SF_CLASSES,
    classSource: 'SF Rec & Parks',
    classesH1: 'Rec center classes in San Francisco',
    attribution: { name: 'SF Recreation & Parks', url: 'https://sfrecpark.org' },
    // Outdoor SF courts carry real scraped daylight hours, so they render like
    // indoor ones. NYC's are a synthetic park-hours window — see `parkHours`.
    parkHours: null,
    subregionLabel: 'neighborhood',
    golf: true,
    pools: {
      list: POOLS,
      // SF's copy is unchanged: /pools is already indexed under it.
      title: `Public Swimming Pools in San Francisco — schedules for all ${POOLS.length} SF pools`,
      description: `Lap swim, family swim, and lesson schedules for all ${POOLS.length} San Francisco public pools — Balboa, Coffman, Garfield, Hamilton, MLK, Mission, North Beach, Rossi, and Sava — updated from each pool's official seasonal schedule.`,
      h1: 'Public swimming pools in San Francisco',
      intro: `San Francisco has ${POOLS.length} public pools run by Rec &amp; Parks. Drop-in swims are cheap ($8 adults, $2 kids); each pool posts a seasonal schedule. The app shows today's sessions live — below is each pool with its programs and official schedule.`,
      // Every SF pool posts its own weekly grid, so every one has something to say.
      sharedOutdoorSchedule: false,
    },
  },
  {
    id: 'nyc',
    name: 'New York City',
    shortName: 'NYC',
    prefix: '/nyc',
    region: 'NY',
    locality: (c) => c.neighborhood || 'New York',
    courts: CITY_COURTS.nyc || [],
    classes: CITY_CLASSES.nyc || [],
    classSource: 'NYC Parks',
    classesH1: 'Free NYC Parks classes and programs',
    attribution: { name: 'NYC Parks', url: 'https://www.nycgovparks.org' },
    parkHours: NYC_PARK_HOURS,
    // NYC outdoor courts run "8 a.m. to dusk" per NYC Parks, not to a fixed
    // hour — see the dusk handling in data/cities/index.js.
    duskClose: true,
    lights: NYC_LIGHTS,
    subregionLabel: 'borough',
    golf: false,
    pools: {
      list: NYC_POOLS,
      season: NYC_POOL_SEASON,
      title: `Free Public Swimming Pools in NYC — outdoor and indoor pool schedules`,
      description: `Every free NYC Parks outdoor pool plus the indoor rec-center pools, with swim hours, addresses and pool sizes. Outdoor pools are free with no membership; the app shows which are open right now.`,
      h1: 'Public swimming pools in New York City',
      intro: `NYC Parks runs free outdoor pools all summer — no membership, no fee, no booking — plus indoor pools at its recreation centers. Outdoor pools swim 11 AM–7 PM daily with a 3–4 PM cleaning break; indoor pools keep their own weekly grid and need a rec center membership.`,
      // The 79 outdoor pools share ONE citywide schedule, so a page each would
      // be 79 near-identical documents. Only the swimming basins earn one.
      sharedOutdoorSchedule: true,
    },
  },
];

// Deep link into the SPA. The city param is what makes a NYC landing page open
// the app *on NYC* (lib/urlState.web.js → App.js); SF is the default and omits it.
function appUrl(cfg, params = {}) {
  const qs = new URLSearchParams();
  if (cfg.id !== 'sf') qs.set('city', cfg.id);
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

// --- which courts earn their own page ------------------------------------------
//
// A page per court is only worth publishing where there's something to say. SF
// courts carry real scraped hours (and often directory facts / reservation
// occupancy) and every NYC rec center has a real open-gym week, so those all
// qualify. NYC's first-come outdoor pins are a synthetic hours window, so they
// have to earn it on facilities: a genuine destination (more than one sport, or
// several courts) rather than a single unlit half-court. The ones that don't
// qualify lose nothing — they're still listed, with the same facts, on their
// borough page. Publishing ~320 near-identical single-court stubs is the
// doorway-page failure mode, and it can drag down the pages that do work.
const NYC_MIN_COURTS = 4;

const hasSport = (c, sportId) => {
  const week = c.dropins?.[sportId];
  return Array.isArray(week) && week.some((day) => day && day.length);
};
// Memoized: the nearby-courts pass asks this for every candidate of every
// detail page, which is ~500 × 700 lookups.
const _sportsAt = new Map();
const sportsAt = (c) => {
  let v = _sportsAt.get(c);
  if (!v) _sportsAt.set(c, (v = SPORTS.map((s) => s.id).filter((s) => hasSport(c, s))));
  return v;
};
const totalCourtsAt = (c) => Object.values(c.facts || {}).reduce((n, f) => n + (f.n || 0), 0);

function earnsPage(c, cfg) {
  if (!sportsAt(c).length) return false; // golf-only venues get /golf/<id> instead
  if (!cfg.parkHours || c.indoor) return true; // real schedule data
  return sportsAt(c).length >= 2 || totalCourtsAt(c) >= NYC_MIN_COURTS;
}

const courtPath = (c) => `/court/${c.id}`;
const COURT_PAGE_IDS = new Set();
for (const cfg of CITY_CFG) for (const c of cfg.courts) if (earnsPage(c, cfg)) COURT_PAGE_IDS.add(c.id);

// A court's areas: DataSF tags some SF courts with several comma-joined
// neighborhoods ("Glen Park, West of Twin Peaks") and the court belongs to each.
const areasOf = (c) => String(c.neighborhood || '').split(',').map((s) => s.trim()).filter(Boolean);

// Which areas earn a hub page. Resolved before any page is built so the sport
// and court pages can link the hubs — a page reachable only from sitemap.xml
// gets crawled, but nothing about the site says it matters.
const AREA_MIN = 3;
const AREA_HUBS = new Map(); // cfg.id -> Map(area -> { path, courts })
for (const cfg of CITY_CFG) {
  const areas = new Map();
  for (const c of cfg.courts) {
    if (!sportsAt(c).length) continue; // golf-only venues have their own pages
    for (const a of areasOf(c)) {
      if (!areas.has(a)) areas.set(a, []);
      areas.get(a).push(c);
    }
  }
  const keep = new Map();
  for (const [a, courts] of [...areas.entries()].sort((x, y) => y[1].length - x[1].length)) {
    if (courts.length >= AREA_MIN) keep.set(a, { path: `/${cfg.id}/${slug(a)}`, courts });
  }
  AREA_HUBS.set(cfg.id, keep);
}
const areaHubsFor = (c, cfg) =>
  areasOf(c).map((a) => [a, AREA_HUBS.get(cfg.id)?.get(a)]).filter(([, h]) => h);

// --- facilities: one rec center, two pins ---------------------------------------
//
// A rec center arrives as TWO courts at the same street address — the gym
// (indoor, with an open-gym week) and the courts out back (outdoor). Both earn
// a /court/ page, both are titled for the same facility, and both chase the
// same query: "Moscone Recreation Center — Basketball, Pickleball drop-in
// hours" and "Moscone Rec Center — Basketball, Pickleball, Tennis drop-in
// hours". Google picks one and files the other under "Duplicate, Google chose
// different canonical", so the facility's authority splits instead of stacking.
//
// So the pins are merged into ONE page covering the whole facility, which is
// also what someone searching the rec center's name wants — the gym schedule
// and the courts out back are the same trip. Both paths keep serving it (the
// second URL is already indexed, and the app deep-links to that court id) under
// a shared canonical pointing at the primary; only the canonical is listed in
// the sitemap and linked internally, so the duplicate is declared rather than
// hidden.
//
// The grouping key is address + "at least one member is indoor", and that
// second half is load-bearing: several genuinely distinct outdoor places share
// one mailing address (Golden Gate Park's sections, Beach 9 and Beach 17
// Playgrounds, Balboa Park and K.C. Jones Playground), and merging those would
// claim two parks are one place.
const addrKey = (c) => String(c.address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const FACILITY_OF = new Map(); // court id -> { primary, members }
for (const cfg of CITY_CFG) {
  const byAddr = new Map();
  for (const c of cfg.courts) {
    if (!COURT_PAGE_IDS.has(c.id)) continue;
    const k = addrKey(c);
    if (!k) continue;
    if (!byAddr.has(k)) byAddr.set(k, []);
    byAddr.get(k).push(c);
  }
  for (const members of byAddr.values()) {
    if (members.length < 2 || !members.some((c) => c.indoor)) continue;
    // The indoor pin leads: it carries the posted open-gym schedule, and its
    // name is the facility's formal one ("… Recreation Center" rather than
    // "… Rec Center"), which is what the page is now about.
    const primary = members.filter((c) => c.indoor).sort((a, b) => b.name.length - a.name.length)[0];
    const group = { primary, members: [primary, ...members.filter((c) => c !== primary)] };
    for (const c of members) FACILITY_OF.set(c.id, group);
  }
}
// Where a court's content actually lives — its own page, or the facility page
// that absorbed it. Every internal link and the sitemap go through this.
const canonicalCourt = (c) => FACILITY_OF.get(c.id)?.primary || c;
const canonicalCourtPath = (c) => courtPath(canonicalCourt(c));

// --- rec centers ----------------------------------------------------------------
//
// The indoor centers, which are the facilities people search by category
// ("recreation centers in san francisco", "nyc rec center open gym") and not
// just by name. Each already has a detail page; what was missing was a page
// about the category itself.
const REC_CENTERS = new Map(); // cfg.id -> court[]
for (const cfg of CITY_CFG) {
  REC_CENTERS.set(
    cfg.id,
    cfg.courts
      .filter((c) => c.indoor && sportsAt(c).length && canonicalCourt(c) === c)
      .sort((a, b) => a.name.localeCompare(b.name))
  );
}
const recCentersPath = (cfg) => `${cfg.prefix}/recreation-centers`;
const hasRecCenters = (cfg) => (REC_CENTERS.get(cfg.id) || []).length >= 3;

// --- shared page template -----------------------------------------------------

const ALL_PAGES = []; // every page, filled before any is rendered (footer links them)

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         line-height: 1.55; color: #1c2733; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #101720; } a { color: #6bb2ff; } }
  main { max-width: 760px; margin: 0 auto; padding: 16px 20px 48px; }
  header.site { border-bottom: 1px solid rgba(128,128,128,.25); }
  header.site .in { max-width: 760px; margin: 0 auto; padding: 14px 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header.site a.brand { font-weight: 700; text-decoration: none; color: inherit; font-size: 18px; }
  header.site .tag { opacity: .6; font-size: 14px; }
  header.site a.get { margin-left: auto; font-size: 14px; white-space: nowrap; }
  h1 { font-size: 26px; line-height: 1.25; margin: 18px 0 6px; }
  h2 { font-size: 19px; margin: 28px 0 8px; }
  .lede { margin: 0 0 14px; opacity: .85; }
  .ctas { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 6px 0 10px; }
  .cta { display: inline-block; background: #ff7a1a; color: #fff !important; font-weight: 700; text-decoration: none;
         padding: 10px 18px; border-radius: 999px; }
  .cta.alt { background: transparent; color: inherit !important; border: 1px solid rgba(128,128,128,.5); font-weight: 600; }
  ul.places { list-style: none; padding: 0; margin: 0; }
  ul.places li { padding: 12px 0; border-bottom: 1px solid rgba(128,128,128,.18); }
  ul.places .nm { font-weight: 700; }
  ul.places .meta { font-size: 14px; opacity: .8; }
  ul.places .hrs { font-size: 14px; margin-top: 2px; }
  ul.places a.map { font-size: 14px; }
  .more { font-size: 14px; margin: 6px 0 0; }
  footer { max-width: 760px; margin: 0 auto; padding: 20px; border-top: 1px solid rgba(128,128,128,.25);
           font-size: 14px; opacity: .85; }
  footer nav { margin-bottom: 8px; }
  footer nav a { margin-right: 10px; white-space: nowrap; }
  footer nav .lbl { opacity: .7; margin-right: 6px; }
`;

function navFor(cfg, currentPath) {
  const links = ALL_PAGES.filter((p) => p.cfg.id === cfg.id && p.path !== currentPath && !p.hideFromNav)
    .map((p) => `<a href="${p.path}">${esc(p.short)}</a>`)
    .join(' ');
  return `<nav><span class="lbl">${esc(cfg.name)}:</span><a href="${appUrl(cfg)}">Live map</a> ${links}</nav>`;
}

function pageHtml(page) {
  const { path: pagePath, title, description, h1, intro, cta, body, jsonLd, cfg, noindex } = page;
  // A page served at more than one path (a rec center's second pin) points its
  // canonical at the primary, so the duplicate consolidates instead of competing.
  const canonical = `${SITE}${page.canonicalPath || pagePath}`;
  const otherNav = CITY_CFG.filter((c) => c.id !== cfg.id && ALL_PAGES.some((p) => p.cfg.id === c.id))
    .map((c) => navFor(c, null))
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">`}
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico">
<style>${CSS}</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<header class="site"><div class="in"><a class="brand" href="/">🏀 ${SITE_NAME}</a><span class="tag">${esc(cfg.tagline || `Find your game in ${cfg.name}`)}</span><a class="get" href="${APP_STORE_URL}" rel="noopener">Get the iPhone app</a></div></header>
<main>
<h1>${esc(h1)}</h1>
<p class="lede">${intro}</p>
<div class="ctas"><a class="cta" href="${cta.href}">${esc(cta.label)} →</a><a class="cta alt" href="${APP_STORE_URL}" rel="noopener">Download for iPhone</a></div>
${body}
</main>
<footer>
${navFor(cfg, pagePath)}
${otherNav}
<p>Court, pool, and class data from <a href="${esc(cfg.attribution.url)}" rel="noopener">${esc(cfg.attribution.name)}</a> public sources — refreshed regularly. ${SITE_NAME} is a free community app and is not affiliated with ${esc(cfg.attribution.name)}.</p>
<p><a href="${APP_STORE_URL}" rel="noopener">iPhone app</a> · <a href="/privacy.html">Privacy</a> · <a href="/support.html">Support</a></p>
</footer>
</body>
</html>
`;
}

function writePage(page) {
  const dir = path.join(DIST, page.path.replace(/^\//, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), pageHtml(page));
}

// --- build the page list -------------------------------------------------------

const placeJsonLd = (c, sportLabel, cfg) => ({
  '@type': 'SportsActivityLocation',
  name: c.name,
  description: `Public ${sportLabel.toLowerCase()} in ${cfg.name}`,
  address: {
    '@type': 'PostalAddress',
    streetAddress: c.address || undefined,
    addressLocality: cfg.locality(c),
    addressRegion: cfg.region,
  },
  geo: c.lat && c.lng ? { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } : undefined,
  isAccessibleForFree: true,
  url: `${SITE}${appUrl(cfg, { sport: c.dropinSport || '', court: c.id })}`,
});

// Indoor courts (and all of SF's) show their real drop-in week; a city whose
// outdoor pins are a synthetic park-hours window shows facility facts instead —
// printing "Mon–Sun 8 AM–8 PM" on 620 first-come courts is noise, not a schedule.
// The court name links to its own page when it has one — that link is the only
// crawl path to the ~550 detail pages, so it has to ride the sport/area lists.
const courtLi = (c, sportId, cfg, extra = '') => {
  const useHours = c.indoor || !cfg.parkHours;
  const detail = useHours ? weekSummary(c.dropins?.[sportId]) : factsLine(c, sportId);
  const place = c.indoor ? 'Indoor' : 'Outdoor';
  const meta = [place, c.address, c.neighborhood].filter(Boolean).join(' · ');
  // Link the canonical path: where a rec center's two pins were merged, both
  // list entries point at the one facility page rather than at a duplicate.
  const detailPath = COURT_PAGE_IDS.has(c.id) ? canonicalCourtPath(c) : null;
  const named = detailPath
    ? `<a class="nm" href="${detailPath}">${esc(c.name)}</a>`
    : `<span class="nm">${esc(c.name)}</span>`;
  return `<li>
${named}${extra}
<div class="meta">${esc(meta)}</div>
${detail ? `<div class="hrs">${esc(detail)}</div>` : ''}
${detailPath ? `<a class="map" href="${detailPath}">Hours &amp; details</a> · ` : ''}<a class="map" href="${appUrl(cfg, { sport: sportId, court: c.id })}">Open in the map</a>
</li>`;
};

// A label/value table — facility facts, fees, a pool's basins.
const rows = (list) =>
  `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 0">${list
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;opacity:.7;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`)
    .join('')}</table>`;

const SPORT_BY_ID = new Map(SPORTS.map((s) => [s.id, s]));

const breadcrumb = (trail) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map(([name, url], i) => ({
    '@type': 'ListItem', position: i + 1, name, item: `${SITE}${url}`,
  })),
});

const pages = [];

const SPORT_PATHS = { pingpong: 'ping-pong' };
const SPORT_NOUN = {
  basketball: 'basketball courts', volleyball: 'volleyball courts & open gyms',
  pingpong: 'ping pong tables', badminton: 'badminton courts',
  pickleball: 'pickleball courts', tennis: 'tennis courts',
  soccer: 'soccer fields', baseball: 'baseball fields',
};

// A sport with more courts than this splits its outdoor list into subregion
// pages; below it the whole city fits on one readable page. A subregion needs at
// least SUBREGION_MIN courts to earn a page of its own — the rest stay listed on
// the parent, so we never emit a near-empty page just to have a URL.
const SPLIT_OVER = 60;
const SUBREGION_MIN = 10;

const sportPath = (cfg, sportId) => `${cfg.prefix}/${SPORT_PATHS[sportId] || sportId}`;

// --- city hub -------------------------------------------------------------------
//
// SF's hub is the app itself at "/" — its prefix is empty. Every other city's
// prefix (/nyc) had no page behind it while ALREADY being the first crumb of
// every breadcrumb trail on ~350 NYC pages, so each one declared a chain
// starting at a 404: Google drops a BreadcrumbList whose items don't resolve.
// It also earns its own term — "where to play in nyc" has no sport in it, so
// no sport page can answer it — and gives the sport, borough and class pages a
// single parent to hang off.
for (const cfg of CITY_CFG) {
  if (!cfg.prefix) continue;
  const bySport = SPORTS.map((s) => ({ s, list: cfg.courts.filter((c) => hasSport(c, s.id)) }))
    .filter((x) => x.list.length)
    .sort((a, b) => b.list.length - a.list.length);
  if (!bySport.length) continue;
  const centers = REC_CENTERS.get(cfg.id) || [];
  const hubs = [...AREA_HUBS.get(cfg.id)];
  const total = cfg.courts.filter((c) => sportsAt(c).length).length;

  pages.push({
    kind: 'index',
    cfg,
    path: cfg.prefix,
    short: `All of ${cfg.shortName}`,
    title: `Where to Play in ${cfg.name} — ${total} free public courts, fields & rec centers | ${SITE_NAME}`,
    description: `Every free public place to play in ${cfg.name}: ${bySport.slice(0, 5).map((x) => x.s.label.toLowerCase()).join(', ')} and more across ${total} parks and ${centers.length} recreation centers, with hours, court counts and a live map of what's open right now.`,
    h1: `Where to play in ${cfg.name}`,
    intro: `${total} free public courts, fields and ${esc(centers.length ? 'recreation centers' : 'facilities')} across ${esc(cfg.name)} — ${esc(cfg.attribution.name)} data, refreshed regularly. Pick a sport, browse by ${esc(cfg.subregionLabel)}, or open the live map to see what's open right now near you.`,
    cta: { href: appUrl(cfg), label: `Open the ${cfg.shortName} map` },
    body:
      `<h2>By sport</h2><ul class="places">${bySport
        .map(({ s, list }) => {
          const indoor = list.filter((c) => c.indoor).length;
          const noun = SPORT_NOUN[s.id] || `${s.label.toLowerCase()} courts`;
          return `<li><a class="nm" href="${sportPath(cfg, s.id)}">${esc(s.emoji)} ${esc(s.label)}</a>
<div class="meta">${list.length} ${esc(noun)}${indoor ? ` · ${indoor} indoor` : ''}</div></li>`;
        })
        .join('\n')}</ul>` +
      (hasRecCenters(cfg)
        ? `<h2>Recreation centers</h2><p class="meta">${centers.length} indoor centers with posted open-gym hours — ${centers.slice(0, 6).map((c) => esc(c.name)).join(' · ')}${centers.length > 6 ? ' · …' : ''}</p>
<p class="more"><a href="${recCentersPath(cfg)}">${esc(cfg.name)} recreation centers →</a></p>`
        : '') +
      (hubs.length
        ? `<h2>By ${esc(cfg.subregionLabel)}</h2><p class="more">${hubs
            .map(([a, h]) => `<a href="${h.path}">${esc(inArea(a))}</a>`)
            .join(' · ')}</p>`
        : '') +
      (() => {
        const current = (cfg.classes || []).filter(isCurrentClass).length;
        return current
          ? `<h2>Classes &amp; programs</h2><p class="meta">${current} ${esc(cfg.classSource)} classes and drop-in programs with live availability.</p>
<p class="more"><a href="${cfg.prefix}/classes">Browse ${esc(cfg.name)} classes →</a></p>`
          : '';
      })(),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `Where to play in ${cfg.name}`,
        url: `${SITE}${cfg.prefix}`,
        about: { '@type': 'City', name: cfg.name, address: { '@type': 'PostalAddress', addressRegion: cfg.region } },
      },
      breadcrumb([[cfg.name, cfg.prefix]]),
    ],
  });
}

// --- recreation centers ---------------------------------------------------------
//
// The category page for the facilities themselves. Every one of these centers
// already had a detail page that ranks for its own name; nothing was about
// "recreation centers in <city>" as a class of place, which is how someone
// searches who does not yet know which center they want.
for (const cfg of CITY_CFG) {
  if (!hasRecCenters(cfg)) continue;
  const centers = REC_CENTERS.get(cfg.id);
  const sportsOf = (c) => sportsAt(c).map((id) => SPORTS.find((s) => s.id === id).label);
  pages.push({
    kind: 'index',
    cfg,
    path: recCentersPath(cfg),
    short: 'Rec centers',
    title: `${cfg.name} Recreation Centers — ${centers.length} with free open gym hours | ${SITE_NAME}`,
    description: `${centers.length} public recreation centers in ${cfg.name} with free indoor open-gym and drop-in hours — basketball, volleyball, pickleball, badminton and ping pong — plus addresses, ${cfg.subregionLabel}s and a live map of what's open right now.`,
    h1: `Recreation centers in ${cfg.name}`,
    intro: `The ${centers.length} public recreation centers in ${esc(cfg.name)} that post free indoor open-gym or drop-in hours. Every one is free to walk into during the times below — no membership, no booking, first come first served. A center running only booked classes and leagues this season is not listed, because there is nothing to drop in on. Open the map to see which are open right now.`,
    cta: { href: appUrl(cfg), label: 'See what’s open right now' },
    body:
      `<ul class="places">${centers
        .map((c) => {
          const labels = sportsOf(c);
          // One sport's week, labelled with that sport: a court's sports each
          // have their own blocks, and printing one week under a list of four
          // would read as a single schedule covering all of them.
          const week = weekSummary(c.dropins?.[sportsAt(c)[0]]);
          return `<li>
<a class="nm" href="${canonicalCourtPath(c)}">${esc(c.name)}</a>
<div class="meta">${esc([c.address, c.neighborhood].filter(Boolean).join(' · '))}</div>
<div class="hrs">Open gym: ${esc(andList(labels).toLowerCase())}</div>
${week ? `<div class="hrs">${esc(labels[0])}: ${esc(week)}</div>` : ''}
<a class="map" href="${canonicalCourtPath(c)}">Full weekly schedule</a> · <a class="map" href="${appUrl(cfg, { sport: sportsAt(c)[0], court: c.id })}">Open in the map</a>
</li>`;
        })
        .join('\n')}</ul>` +
      `<h2>What "open gym" means</h2>
<p>Open gym (also called drop-in) is a block of time the center leaves unbooked for anyone to walk in and play. It is free at every ${esc(cfg.name)} center listed here, and it is first come, first served — no reservation, no membership card. The blocks move around when a center books a league or a class into the gym, which is why the hours above are re-scraped from ${esc(cfg.attribution.name)} regularly and the app shows the live picture.</p>` +
      (AREA_HUBS.get(cfg.id).size
        ? `<h2>Browse by ${esc(cfg.subregionLabel)}</h2><p class="more">${[...AREA_HUBS.get(cfg.id)]
            .map(([a, h]) => `<a href="${h.path}">${esc(inArea(a))}</a>`)
            .join(' · ')}</p>`
        : ''),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `Public recreation centers in ${cfg.name}`,
        numberOfItems: centers.length,
        itemListElement: centers.map((c, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            ...placeJsonLd({ ...c, dropinSport: sportsAt(c)[0] }, 'open gym', cfg),
            '@type': ['SportsActivityLocation', 'CivicStructure'],
            openingHoursSpecification: openingHours(c),
          },
        })),
      },
      breadcrumb([[cfg.name, cfg.prefix || '/'], ['Recreation centers', recCentersPath(cfg)]]),
    ],
  });
}

for (const cfg of CITY_CFG) {
  for (const s of SPORTS) {
    const courts = cfg.courts.filter((c) => hasSport(c, s.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (!courts.length) continue;
    const indoor = courts.filter((c) => c.indoor);
    const outdoor = courts.filter((c) => !c.indoor);
    const noun = SPORT_NOUN[s.id] || `${s.label.toLowerCase()} courts`;
    const nounHead = noun.includes('court') || noun.includes('field') || noun.includes('table') ? noun.split('&')[0].trim() : 'spots';
    const base = `${cfg.prefix}/${SPORT_PATHS[s.id] || s.id}`;

    const section = (label, list) =>
      list.length ? `<h2>${esc(label)}</h2><ul class="places">${list.map((c) => courtLi(c, s.id, cfg)).join('\n')}</ul>` : '';

    // Group the outdoor list by subregion when the city is too big for one page.
    const split = courts.length > SPLIT_OVER;
    const groups = new Map();
    if (split) {
      for (const c of outdoor) {
        const key = c.neighborhood || '';
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
    }
    const bigGroups = [...groups.entries()].filter(([, list]) => list.length >= SUBREGION_MIN).sort((a, b) => b[1].length - a[1].length);
    const inlineOutdoor = split
      ? outdoor.filter((c) => !bigGroups.some(([name]) => name === c.neighborhood))
      : outdoor;

    // Subregion pages (e.g. /nyc/basketball/queens) — the full list for one area.
    for (const [name, list] of bigGroups) {
      const subPath = `${base}/${slug(name)}`;
      pages.push({
        kind: 'sport-area',
        cfg,
        path: subPath,
        short: `${s.label} · ${name}`,
        hideFromNav: true,
        title: `${s.label} Courts in ${inArea(name)} — ${list.length} free public ${nounHead} | ${SITE_NAME}`,
        description: `All ${list.length} public ${noun} in ${inArea(name)}, ${cfg.name} — with addresses, court counts, lights and surfaces, on a free live map that shows what's open right now.`,
        h1: `${s.label} in ${inArea(name)}`,
        intro: `Every public ${esc(s.label.toLowerCase())} spot in ${esc(inArea(name))} — ${list.length} ${esc(noun)}, free and first come, first served during park hours. Open the map to see what's nearby and who's playing.`,
        cta: { href: appUrl(cfg, { sport: s.id }), label: `See ${inArea(name)} on the live map` },
        body:
          `<ul class="places">${list.sort((a, b) => a.name.localeCompare(b.name)).map((c) => courtLi(c, s.id, cfg)).join('\n')}</ul>` +
          `<p class="more"><a href="${base}">← All ${esc(s.label.toLowerCase())} in ${esc(cfg.name)}</a></p>`,
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `Public ${s.label.toLowerCase()} in ${inArea(name)}, ${cfg.name}`,
          numberOfItems: list.length,
          itemListElement: list.map((c, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            item: placeJsonLd({ ...c, dropinSport: s.id }, s.label, cfg),
          })),
        },
      });
    }

    // Parent city page. When split, it carries the indoor centers in full plus a
    // per-subregion summary that links out; otherwise it lists everything.
    const byArea = bigGroups.length
      ? `<h2>By ${esc(cfg.subregionLabel)}</h2>` +
        bigGroups
          .map(([name, list]) => {
            const sample = list.slice(0, 8).map((c) => esc(c.name)).join(' · ');
            return `<h3 style="font-size:16px;margin:16px 0 4px"><a href="${base}/${slug(name)}">${esc(name)} (${list.length})</a></h3>
<p class="meta">${sample}${list.length > 8 ? ' · …' : ''}</p>
<p class="more"><a href="${base}/${slug(name)}">All ${list.length} ${esc(noun)} in ${esc(inArea(name))} →</a></p>`;
          })
          .join('\n')
      : '';

    const outdoorLabel = cfg.parkHours
      ? `Outdoor courts (first come, first served, ${parkHoursPhrase(cfg)})`
      : 'Outdoor courts (first come, first served)';

    pages.push({
      kind: 'sport',
      cfg,
      path: base,
      short: s.label,
      title: `${s.label} in ${cfg.name} — ${courts.length} free public ${nounHead} | ${SITE_NAME}`,
      description: `Where to play ${s.label.toLowerCase()} in ${cfg.shortName}: all ${courts.length} public ${noun} with drop-in and open-gym hours, on a free live map. Data from ${cfg.attribution.name}, updated regularly.`,
      h1: `${s.label} in ${cfg.name}`,
      intro: `Every free public place to play ${esc(s.label.toLowerCase())} in ${esc(cfg.name)} — ${indoor.length ? `${indoor.length} indoor rec center${indoor.length === 1 ? '' : 's'} with scheduled drop-in times` : ''}${indoor.length && outdoor.length ? ' and ' : ''}${outdoor.length ? `${outdoor.length} outdoor first-come, first-served location${outdoor.length === 1 ? '' : 's'}` : ''}. See what's open right now on the live map, check in, and find people to play with.`,
      cta: { href: appUrl(cfg, { sport: s.id }), label: `See ${s.label.toLowerCase()} on the live map` },
      body:
        section('Indoor drop-in / open gym', indoor) + byArea + section(outdoorLabel, inlineOutdoor) +
        // Every area hub's inbound link comes from here.
        (AREA_HUBS.get(cfg.id).size
          ? `<h2>Browse by ${esc(cfg.subregionLabel)}</h2><p class="more">${[...AREA_HUBS.get(cfg.id)]
              .map(([a, h]) => `<a href="${h.path}">${esc(inArea(a))}</a>`)
              .join(' · ')}</p>`
          : ''),
      // Describe what this page actually renders — on a split page the bulk of
      // the courts live on the subregion pages and are marked up there.
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `Public ${s.label.toLowerCase()} in ${cfg.name}`,
        numberOfItems: indoor.length + inlineOutdoor.length,
        itemListElement: [...indoor, ...inlineOutdoor].map((c, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: placeJsonLd({ ...c, dropinSport: s.id }, s.label, cfg),
        })),
      },
    });
  }
}

const SF = CITY_CFG[0];

// Golf: the 6 SFRPD courses, with the curated course facts.
const golfCourses = SF.courts.filter((c) => c.golf);
if (golfCourses.length) {
  pages.push({
    kind: 'index',
    cfg: SF,
    path: '/golf',
    short: 'Golf',
    title: `Public Golf Courses in San Francisco — all ${golfCourses.length} SF Rec & Parks courses | ${SITE_NAME}`,
    description: `All ${golfCourses.length} public golf courses in San Francisco with holes, par, green fees, and tee-time booking links — from TPC Harding Park to the beginner-friendly Golden Gate Park 9.`,
    h1: 'Public golf courses in San Francisco',
    intro: `San Francisco Rec &amp; Parks runs ${golfCourses.length} public courses, from a championship 18 to walkable par-3 loops. Fees below are curated from each course's published rates.`,
    cta: { href: appUrl(SF, { sport: 'golf' }), label: 'See golf courses on the live map' },
    body: `<ul class="places">${golfCourses
      .map((c) => {
        const g = c.golf;
        const facts = [`${g.holes} holes`, `par ${g.par}`, g.yards ? `${g.yards} yds` : null, g.range ? 'driving range' : null, g.beginner ? 'beginner-friendly' : null].filter(Boolean).join(' · ');
        return `<li>
<a class="nm" href="/golf/${c.id.replace(/-golf$/, '')}">${esc(c.name)}</a>
<div class="meta">${esc([c.address, facts].filter(Boolean).join(' · '))}</div>
<div class="hrs">${esc(g.desc || '')}</div>
${(g.fees || []).map((f) => `<div class="hrs">💵 ${esc(f)}</div>`).join('')}
<a class="map" href="/golf/${c.id.replace(/-golf$/, '')}">Fees &amp; details</a> · ${g.bookUrl ? `<a class="map" href="${esc(g.bookUrl)}" rel="noopener">Book a tee time</a> · ` : ''}<a class="map" href="${appUrl(SF, { sport: 'golf', court: c.id })}">Open in the map</a>
</li>`;
      })
      .join('\n')}</ul>`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: 'Public golf courses in San Francisco',
      numberOfItems: golfCourses.length,
      itemListElement: golfCourses.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'GolfCourse', name: c.name, address: { '@type': 'PostalAddress', streetAddress: c.address, addressLocality: 'San Francisco', addressRegion: 'CA' }, geo: { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } },
      })),
    },
  });
}

// --- pools ----------------------------------------------------------------------
//
// A city's pools: one index, plus a page for each pool that has something of
// its own to say. Both cities' records are the same POOLS shape (see
// lib/poolCourts.js), so this generates for either.
const KIND_LABEL = { lap: 'lap swim', family: 'family swim', senior: 'senior swim', lessons: 'swim lessons', adult_lessons: 'adult lessons', parent_child: 'parent & child', exercise: 'water exercise', camp: 'day camp', rental: 'rentals', other: 'programs' };
const KIND_ORDER = ['lap', 'family', 'senior', 'exercise', 'parent_child', 'adult_lessons', 'lessons', 'camp', 'rental', 'other'];

// A site's basins (NYC records an Olympic pool and its wading pool as separate
// rows) are merged into one record by build-nyc-pools.js and listed in
// `basins`; SF has one basin per record and no such field.
const basinsOf = (p) => p.basins || (p.desc ? [p.desc] : []);
const poolPath = (cfg, id) => `${cfg.prefix}/pools/${id.replace(/^(nyc-)?pool-/, '')}`;
const poolsIndexPath = (cfg) => `${cfg.prefix}/pools`;

// A basin you can actually swim laps or lengths in, as opposed to a wading or
// mini pool for toddlers. NYC states the type in the pool's own description.
const SWIM_BASIN = /olympic|intermediate|diving/i;
const isSwimBasin = (desc) => SWIM_BASIN.test(desc || '');

// Which pools earn a page. Where every pool posts its own weekly grid (SF),
// they all do. Where the outdoor pools share one citywide schedule (NYC), a
// page each would be 79 documents differing only in address — so a wading-pool
// site stays listed on the index with the same facts, and the swimming basins
// get the page. Indoor pools always qualify: each has its own grid, or a notice
// saying why it is closed, which is the answer someone is looking for.
function poolEarnsPage(cfg, p) {
  if (!cfg.pools.sharedOutdoorSchedule) return true;
  if (p.indoor !== false) return true;
  if (!(p.sessions || []).flat().filter(Boolean).length) return false;
  return basinsOf(p).some(isSwimBasin);
}

const POOL_PAGE_IDS = new Map(); // cfg.id -> Set(pool id)
for (const cfg of CITY_CFG) {
  if (!cfg.pools) continue;
  POOL_PAGE_IDS.set(cfg.id, new Set(cfg.pools.list.filter((p) => poolEarnsPage(cfg, p)).map((p) => p.id)));
}

const poolSessionCount = (p) => (p.sessions || []).reduce((n, d) => n + (d?.length || 0), 0);

for (const cfg of CITY_CFG) {
  if (!cfg.pools) continue;
  const sites = [...cfg.pools.list].sort((a, b) => a.name.localeCompare(b.name));
  const pageIds = POOL_PAGE_IDS.get(cfg.id);
  const season = cfg.pools.season;
  const indoorSites = sites.filter((p) => p.indoor !== false);
  const outdoorSites = sites.filter((p) => p.indoor === false);

  // Index. The pool name links its page where it has one — the old SF index
  // linked only the PDF and the app, which left all 9 detail pages with no
  // inbound internal link at all.
  const poolLi = (p) => {
    const id = p.id;
    const sessions = poolSessionCount(p);
    const programs = (p.programs || []).map((k) => KIND_LABEL[k] || k).join(', ');
    const list = basinsOf(p);
    const basins = list.length > 1 ? `${list.length} pools` : (list[0] || '').split('·')[0].trim();
    const linked = pageIds.has(id)
      ? `<a class="nm" href="${poolPath(cfg, id)}">${esc(p.name)}</a>`
      : `<span class="nm">${esc(p.name)}</span>`;
    return `<li>
${linked}
<div class="meta">${esc([p.address, p.phone, basins].filter(Boolean).join(' · '))}</div>
<div class="hrs">${esc(p.notice || [p.season && `Season ${p.season}`, sessions && `${sessions} sessions/week`, programs].filter(Boolean).join(' · '))}</div>
${pageIds.has(id) ? `<a class="map" href="${poolPath(cfg, id)}">Schedule &amp; details</a> · ` : ''}${(p.scheduleUrls || []).map((u) => `<a class="map" href="${esc(u.url)}" rel="noopener">${esc(u.label || 'Official schedule (PDF)')}</a> · `).join('')}<a class="map" href="${appUrl(cfg, { sport: 'swimming', court: p.id })}">Open in the app</a>
</li>`;
  };

  const split = indoorSites.length && outdoorSites.length;
  pages.push({
    kind: 'index',
    cfg,
    path: poolsIndexPath(cfg),
    short: 'Pools',
    title: `${cfg.pools.title} | ${SITE_NAME}`,
    description: cfg.pools.description,
    h1: cfg.pools.h1,
    intro: `${cfg.pools.intro}${season && !season.open ? ` <strong>Outdoor pools are closed for the season</strong> (checked ${esc(season.checked)}).` : ''}`,
    cta: { href: appUrl(cfg, { sport: 'swimming' }), label: 'See today’s swim times' },
    body:
      (split
        ? `<h2>Outdoor pools (${outdoorSites.length}) — free, no membership</h2><ul class="places">${outdoorSites.map(poolLi).join('\n')}</ul>` +
          `<h2>Indoor pools (${indoorSites.length}) — at recreation centers</h2><ul class="places">${indoorSites.map(poolLi).join('\n')}</ul>`
        : `<ul class="places">${sites.map(poolLi).join('\n')}</ul>`) +
      (hasRecCenters(cfg)
        ? `<p class="more"><a href="${recCentersPath(cfg)}">${esc(cfg.name)} recreation centers</a></p>`
        : ''),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: `Public swimming pools in ${cfg.name}`,
        numberOfItems: sites.length,
        itemListElement: sites.map((p, i) => {
          return {
            '@type': 'ListItem',
            position: i + 1,
            item: {
              '@type': 'PublicSwimmingPool',
              name: p.name,
              address: { '@type': 'PostalAddress', streetAddress: p.address, addressLocality: cfg.locality(p), addressRegion: cfg.region },
              geo: p.lat && p.lng ? { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } : undefined,
              telephone: p.phone || undefined,
            },
          };
        }),
      },
      breadcrumb([[cfg.name, cfg.prefix || '/'], ['Pools', poolsIndexPath(cfg)]]),
    ],
  });

  // Detail pages. A pool's weekly grid by session kind is the whole reason
  // someone searches for it, and the city publishes it only as a PDF (SF) or
  // buried in a rec center's schedule table (NYC).
  for (const p of sites) {
    const id = p.id;
    if (!pageIds.has(id)) continue;
    // `indoor !== false`, matching lib/poolCourts.js: SF's records omit the
    // field and all 9 of its pools are indoor, so a bare truthiness test
    // called them free outdoor pools — they are indoor and $8.
    const indoor = p.indoor !== false;
    const path_ = poolPath(cfg, id);
    const kinds = [...new Set(p.sessions.flat().filter(Boolean).map((x) => x.kind))].sort(
      (a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99)
    );
    const bySeq = kinds.map((k) => {
      // Dedupe by start/end: a facility with separate warm- and cool-pool PDFs
      // (North Beach) can run the same session kind at the same time in both.
      const week = Array.from({ length: 7 }, (_, d) => {
        const seen = new Set();
        return (p.sessions[d] || [])
          .filter((x) => x.kind === k)
          .filter((x) => !seen.has(`${x.start}-${x.end}`) && seen.add(`${x.start}-${x.end}`))
          .map((x) => [x.start, x.end]);
      });
      return [k, dayRows(week)];
    }).filter(([, r]) => r.length);

    const nearPools = sites
      .filter((o) => o.id !== id && pageIds.has(o.id))
      .map((o) => ({ oid: o.id, o, d: milesBetween(p, o) }))
      .filter((x) => x.d != null)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);

    // Fees ride on the record where the city has its own (NYC's outdoor pools
    // are free, its indoor ones are a rec-center membership); SF's are city-wide.
    const fees = p.fees || POOL_FEES;
    const feeRows = (fees.groups || []).map((g) => [g.label, `${g.dropIn ? `$${g.dropIn} drop-in` : 'Free'}${(g.passes || []).length ? ` · ${g.passes.map(([l, v]) => `${l} ${v ? `$${v}` : 'free'}`).join(' · ')}` : ''}`]);

    const basinRows = basinsOf(p).map((d) => {
      const [type, size] = String(d).split('·').map((x) => x.trim());
      return [type || 'Pool', size || '—'];
    });

    pages.push({
      kind: 'pool',
      cfg,
      path: path_,
      short: p.name,
      hideFromNav: true,
      title: `${p.name} — ${indoor ? 'lap swim & schedule' : 'free outdoor pool & swim times'} | ${cfg.name} public pool | ${SITE_NAME}`,
      description: `${p.name}${p.address ? ` at ${p.address}` : ''}, ${cfg.name}: ${bySeq.length ? `the full weekly schedule — ${bySeq.map(([k]) => KIND_LABEL[k] || k).join(', ')} — plus ` : ''}${feeRows.length ? 'fees, ' : ''}season dates and the official schedule.`,
      h1: p.name,
      intro: `${esc(p.desc || `${p.name} is one of ${cfg.name}'s public pools.`)}${p.season ? ` Season ${esc(p.season)}.` : ''}${p.notice ? ` <strong>${esc(p.notice)}</strong>` : ''} The app shows today's sessions live.`,
      cta: { href: appUrl(cfg, { sport: 'swimming', court: p.id }), label: 'See today’s swim times' },
      body:
        (bySeq.length
          ? bySeq.map(([k, r]) => `<h2>${esc(KIND_LABEL[k] || k)}</h2>${rows(r)}`).join('\n')
          : `<h2>Schedule</h2><p class="hrs">${esc(p.notice || 'No sessions are currently published for this pool.')}</p>`) +
        `<h2>Location</h2>${rows([
          ['Address', p.address || '—'],
          p.phone ? ['Phone', p.phone] : null,
          ['Type', indoor ? 'Indoor' : 'Outdoor · seasonal · free'],
          p.season ? ['Season', p.season] : null,
          p.accessible ? ['Accessibility', 'Wheelchair accessible'] : null,
        ].filter(Boolean))}` +
        (basinRows.length > 1 ? `<h2>Pools at this site</h2>${rows(basinRows)}` : '') +
        (feeRows.length ? `<h2>Fees</h2>${rows(feeRows)}<p class="meta">${esc(fees.note || `City-wide pool rates, effective ${fees.effective || ''}.`)}</p>` : '') +
        (p.lat && p.lng ? `<p class="more"><a href="https://www.google.com/maps/dir/?api=1&amp;destination=${p.lat},${p.lng}" rel="noopener">Directions</a></p>` : '') +
        (p.scheduleUrls || []).map((u) => `<p class="more"><a href="${esc(u.url)}" rel="noopener">${esc(u.label || 'Official schedule (PDF)')}</a></p>`).join('') +
        (nearPools.length ? `<h2>Other pools nearby</h2><ul class="places">${nearPools.map(({ oid, o, d }) => `<li><a class="nm" href="${poolPath(cfg, oid)}">${esc(o.name)}</a> <span class="meta">${fmtMiles(d)} away</span><div class="meta">${esc(o.address || '')}</div></li>`).join('')}</ul>` : '') +
        `<p class="more"><a href="${poolsIndexPath(cfg)}">All ${esc(cfg.name)} public pools</a></p>`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'PublicSwimmingPool',
          name: p.name,
          description: p.desc || undefined,
          address: { '@type': 'PostalAddress', streetAddress: p.address, addressLocality: cfg.locality(p), addressRegion: cfg.region },
          geo: p.lat && p.lng ? { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } : undefined,
          telephone: p.phone || undefined,
          isAccessibleForFree: !indoor ? true : undefined,
        },
        breadcrumb([[cfg.name, cfg.prefix || '/'], ['Pools', poolsIndexPath(cfg)], [p.name, path_]]),
      ],
    });
  }
}

// --- classes --------------------------------------------------------------------
//
// A per-city index plus a page per category. The index alone could only ever
// rank for "sf rec classes"; "free yoga class san francisco" and "nyc parks
// senior programs" are category queries, and the catalog already holds the
// answer.
//
// A class that has already finished is dropped. NYC's feed is largely one-off
// events (`oneDay`), so an unfiltered list is mostly things that already
// happened — and a landing page advertising last month's events is worse than
// no page. It also makes a stale scrape visible instead of publishing it.
// Below this a category page is a handful of rows that the index already shows.
const CLASS_CAT_MIN = 12;
// Above this the page stops being readable; the app has the searchable catalog.
const CLASS_LIST_CAP = 150;
const classCatPath = (cfg, catId) => `${cfg.prefix}/classes/${catId}`;

const classLi = (c, cfg) => {
  const meta = [c.location, c.borough, c.when].filter(Boolean).join(' · ');
  const facts = [
    c.cost || null,
    c.ages || null,
    c.dropIn ? 'drop-in' : null,
    typeof c.spots === 'number' && c.spots > 0 ? `${c.spots} spots left` : null,
  ].filter(Boolean).join(' · ');
  return `<li>
<span class="nm">${esc(c.name)}</span>
<div class="meta">${esc(meta)}</div>
${facts ? `<div class="hrs">${esc(facts)}</div>` : ''}
${c.url ? `<a class="map" href="${esc(c.url)}" rel="noopener nofollow">Details &amp; registration</a> · ` : ''}<a class="map" href="${appUrl(cfg, { tab: 'classes' })}">Browse in the app</a>
</li>`;
};

const courseLd = (c, cfg) => ({
  '@type': 'Course',
  name: c.name,
  description: (c.desc || `${c.name} — a ${cfg.classSource} program in ${cfg.name}.`).slice(0, 400),
  provider: { '@type': 'Organization', name: cfg.classSource, url: cfg.attribution.url },
  ...(c.url ? { url: c.url } : {}),
  offers: {
    '@type': 'Offer',
    price: /free/i.test(c.cost || '') ? '0' : String(c.cost || '').replace(/[^0-9.]/g, '') || '0',
    priceCurrency: 'USD',
    category: /free/i.test(c.cost || '') ? 'Free' : 'Paid',
  },
});

const CLASS_CAT_PAGES = new Map(); // cfg.id -> [[cat, list]]
for (const cfg of CITY_CFG) {
  const list = (cfg.classes || []).filter(isCurrentClass);
  if (!cfg.classes?.length) continue;
  const byCat = new Map();
  for (const c of list) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const catPages = CLASS_CATEGORIES.filter((cat) => (byCat.get(cat.id) || []).length >= CLASS_CAT_MIN)
    .map((cat) => [cat, byCat.get(cat.id).sort((a, b) => a.name.localeCompare(b.name))]);
  CLASS_CAT_PAGES.set(cfg.id, catPages);

  const free = list.filter((c) => /free/i.test(c.cost || '')).length;
  const stale = cfg.classes.length - list.length;

  pages.push({
    kind: 'index',
    cfg,
    path: `${cfg.prefix}/classes`,
    short: 'Classes',
    title: `${cfg.classSource} Classes — ${list.length} drop-in classes & programs | ${SITE_NAME}`,
    description: `Browse ${list.length} ${cfg.name} ${cfg.classSource} classes and drop-in programs — fitness, dance, swim lessons, arts, sports and more — with prices, ages, and open spots, updated every 6 hours.`,
    h1: cfg.classesH1,
    intro: list.length
      ? `${list.length} classes and drop-in programs across ${esc(cfg.classSource)} facilities, with live availability, prices, and age ranges${free ? ` — ${free} of them free` : ''}. Browse the full searchable catalog in the app; here's what's on offer by category.`
      : `No ${esc(cfg.classSource)} programs are currently listed with dates in the future. The app shows the live catalog — this page fills back in as soon as the next session dates are published.`,
    cta: { href: appUrl(cfg, { tab: 'classes' }), label: 'Browse all classes' },
    body: CLASS_CATEGORIES.filter((cat) => byCat.get(cat.id)?.length)
      .map((cat) => {
        const items = byCat.get(cat.id);
        const names = [...new Set(items.map((c) => c.name))].slice(0, 8);
        // Category pages hang off these headings — their only inbound link.
        const linked = catPages.some(([k]) => k.id === cat.id)
          ? `<a href="${classCatPath(cfg, cat.id)}">${esc(cat.emoji)} ${esc(cat.label)} (${items.length})</a>`
          : `${esc(cat.emoji)} ${esc(cat.label)} (${items.length})`;
        return `<h2>${linked}</h2><p class="meta">${names.map(esc).join(' · ')}${items.length > names.length ? ' · …' : ''}</p>`;
      })
      .join('\n'),
    jsonLd: breadcrumb([[cfg.name, cfg.prefix || '/'], ['Classes', `${cfg.prefix}/classes`]]),
  });

  for (const [cat, items] of catPages) {
    const shown = items.slice(0, CLASS_LIST_CAP);
    const freeN = items.filter((c) => /free/i.test(c.cost || '')).length;
    const dropIn = items.filter((c) => c.dropIn).length;
    const label = cat.label.toLowerCase();
    pages.push({
      kind: 'class-cat',
      cfg,
      path: classCatPath(cfg, cat.id),
      short: `${cat.label} classes`,
      hideFromNav: true,
      title: `${cat.label} Classes in ${cfg.name} — ${items.length} ${cfg.classSource} programs | ${SITE_NAME}`,
      description: `${items.length} ${label} classes and programs run by ${cfg.classSource} in ${cfg.name}${freeN ? `, ${freeN} of them free` : ''} — schedules, prices, ages and open spots, refreshed every 6 hours.`,
      h1: `${cat.label} classes in ${cfg.name}`,
      intro: `${items.length} ${esc(label)} classes and programs across ${esc(cfg.classSource)} facilities${freeN ? ` — ${freeN} free` : ''}${dropIn ? `, ${dropIn} drop-in (no registration)` : ''}. Prices, ages and remaining spots below; the app has the searchable catalog and live availability.`,
      cta: { href: appUrl(cfg, { tab: 'classes' }), label: 'Browse these in the app' },
      body:
        `<ul class="places">${shown.map((c) => classLi(c, cfg)).join('\n')}</ul>` +
        (items.length > shown.length
          ? `<p class="more">${items.length - shown.length} more ${esc(label)} programs are in the app's searchable catalog.</p>`
          : '') +
        `<h2>Other ${esc(cfg.classSource)} categories</h2><p class="more">${catPages
          .filter(([k]) => k.id !== cat.id)
          .map(([k, l]) => `<a href="${classCatPath(cfg, k.id)}">${esc(k.label)} (${l.length})</a>`)
          .join(' · ')}</p>` +
        `<p class="more"><a href="${cfg.prefix}/classes">All ${esc(cfg.name)} classes</a></p>`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `${cat.label} classes in ${cfg.name}`,
          numberOfItems: shown.length,
          itemListElement: shown.map((c, i) => ({ '@type': 'ListItem', position: i + 1, item: courseLd(c, cfg) })),
        },
        breadcrumb([
          [cfg.name, cfg.prefix || '/'],
          ['Classes', `${cfg.prefix}/classes`],
          [cat.label, classCatPath(cfg, cat.id)],
        ]),
      ],
    });
  }
}

// --- detail pages: one per court, pool and golf course --------------------------
//
// The long tail. "moscone rec center open gym hours" and "hamilton pool lap
// swim schedule" are the queries these answer, and the answer is a fact we
// already hold — the sport indexes above can only ever rank for the head term.



// One page per sport at one court: the full week when there is a posted
// schedule, facility facts when the hours are a synthetic park window.
// `level` lets a facility page nest these under a per-pin heading.
function sportSection(c, id, cfg, level = 2) {
  const s = SPORT_BY_ID.get(id);
  const useHours = c.indoor || !cfg.parkHours;
  const week = dayRows(c.dropins?.[id]);
  const facts = factsLine(c, id);
  const dir = DIRECTORY[c.id]?.[id];
  const detail = useHours && week.length
    ? rows(week)
    : facts
      ? `<p class="hrs">${esc(facts)}</p>`
      : '';
  const dirLine = dir
    ? `<p class="hrs">${esc([
        dir.total ? `${dir.total} court${dir.total === 1 ? '' : 's'}` : null,
        dir.walkup ? `${dir.walkup} walk-up` : null,
        dir.reservable ? `${dir.reservable} reservable` : null,
        dir.lights ? 'lights' : null,
        dir.restrooms ? 'restrooms' : null,
      ].filter(Boolean).join(' · '))}</p>`
    : '';
  const pct = RESERVATIONS[c.id]?.[id]?.pct;
  const resLine = typeof pct === 'number'
    ? `<p class="hrs">Reservations on rec.us run about ${pct}% booked across the coming week — the app shows the live number for the time you're asking about.</p>`
    : '';
  const head = useHours && week.length ? `${s.emoji} ${s.label} drop-in hours` : `${s.emoji} ${s.label}`;
  const h = `h${level}`;
  const style = level === 3 ? ' style="font-size:16px;margin:14px 0 4px"' : '';
  return `<${h}${style}>${esc(head)}</${h}>${detail}${dirLine}${resLine}`;
}

// A rec center's indoor gym and its outdoor courts are two pins; on the merged
// page each keeps its own block so the posted gym schedule is never confused
// with the courts out back.
const PIN_HEAD = {
  indoor: 'Indoor open gym',
  outdoor: 'Outdoor courts',
};

for (const cfg of CITY_CFG) {
  for (const c of cfg.courts) {
    if (!COURT_PAGE_IDS.has(c.id)) continue;
    const facility = FACILITY_OF.get(c.id);
    // Non-primary members are emitted after the loop as a duplicate path of the
    // page built here, so their content is rendered exactly once.
    if (facility && facility.primary !== c) continue;
    const members = facility ? facility.members : [c];
    const isFacility = members.length > 1;

    // Union across the facility: the page is about the whole place.
    const sports = [...new Set(members.flatMap((m) => sportsAt(m)))];
    const labels = sports.map((id) => SPORT_BY_ID.get(id).label);
    const useHours = c.indoor || !cfg.parkHours;
    const areas = [...new Set(members.flatMap((m) => areasOf(m)))];
    const place = c.indoor ? 'indoor' : 'outdoor';
    // "Recreation center" as a category term, not just this center's name —
    // the phrase has to be on the page for the page to be about it.
    const isRecCenter = c.indoor && /recreation center|rec center|clubhouse/i.test(c.name);

    const sportSections = isFacility
      ? members
          .map((m) => {
            const mine = sportsAt(m);
            if (!mine.length) return '';
            const head = PIN_HEAD[m.indoor ? 'indoor' : 'outdoor'];
            const sub = m.name !== c.name ? ` <span class="meta">(${esc(m.name)})</span>` : '';
            return `<h2>${esc(head)}${sub}</h2>` + mine.map((id) => sportSection(m, id, cfg, 3)).join('\n');
          })
          .join('\n')
      : sports.map((id) => sportSection(c, id, cfg, 2)).join('\n');

    // Nearby: same-sport alternatives, which is the thing you actually want when
    // a court turns out to be closed or packed. Deduped by facility, so a rec
    // center's two pins can't both appear as separate "other places".
    const primary = sports[0];
    const mineIds = new Set(members.map((m) => m.id));
    const seenNear = new Set();
    const near = cfg.courts
      .filter((o) => !mineIds.has(o.id) && sportsAt(o).includes(primary))
      .map((o) => ({ o, d: milesBetween(c, o) }))
      .filter((x) => x.d != null)
      .sort((a, b) => a.d - b.d)
      .filter(({ o }) => {
        const k = canonicalCourt(o).id;
        return !seenNear.has(k) && seenNear.add(k);
      })
      .slice(0, 6);
    const nearSection = near.length
      ? `<h2>Other ${esc(SPORT_BY_ID.get(primary).label.toLowerCase())} nearby</h2><ul class="places">${near
          .map(({ o, d }) => courtLi(o, primary, cfg, ` <span class="meta">${fmtMiles(d)} away</span>`))
          .join('\n')}</ul>`
      : '';

    const has = (k) => members.some((m) => m[k]);
    const amenities = [has('accessible') ? 'wheelchair accessible' : null, has('restrooms') ? 'restrooms' : null, has('water') ? 'drinking water' : null].filter(Boolean);
    const typeLine = isFacility
      ? `Recreation center · indoor gym and outdoor courts · free drop-in`
      : `${place === 'indoor' ? 'Indoor rec center' : 'Outdoor'} · free drop-in`;
    const notes = [...new Set(members.map((m) => m.notes).filter(Boolean))];
    const info = rows([
      ['Address', c.address || '—'],
      areas.length ? [cfg.subregionLabel === 'borough' ? 'Borough' : 'Neighborhood', areas.join(', ')] : null,
      ['Type', typeLine],
      // No posted schedule to show, so name the window these courts are open in.
      !useHours && cfg.parkHours ? ['Park hours', parkHoursPhrase(cfg, c)] : null,
      amenities.length ? ['Amenities', amenities.join(', ')] : null,
      notes.length ? ['Notes', notes.join(' ')] : null,
    ].filter(Boolean));

    const trail = [
      [cfg.name, cfg.prefix || '/'],
      ...(isRecCenter && hasRecCenters(cfg) ? [['Recreation centers', recCentersPath(cfg)]] : []),
      [SPORT_BY_ID.get(primary).label, sportPath(cfg, primary)],
      [c.name, courtPath(c)],
    ];

    // Rec centers lead with the phrase people search — "open gym hours" — and
    // name the category, since the center's own name is already in the title.
    const title = isRecCenter
      ? `${c.name} — Open Gym Hours & Drop-In Schedule | ${cfg.shortName} Recreation Center`
      : `${c.name} — ${labels.slice(0, 3).join(', ')} drop-in hours | ${SITE_NAME}`;
    const description = isRecCenter
      ? `Free open gym at ${c.name}${c.address ? `, ${c.address}` : ''}, ${cfg.name}: the full weekly drop-in schedule for ${andList(labels.slice(0, 3)).toLowerCase()}${isFacility ? ', indoors and on the outdoor courts' : ''}, plus what's open right now and other rec centers nearby.`
      : `${c.name}${c.address ? ` at ${c.address}` : ''}, ${cfg.name}: free ${place} ${andList(labels.slice(0, 3)).toLowerCase()}${useHours ? ' with the full weekly drop-in schedule' : ' — courts, surfaces and amenities'}, plus what's open right now and other spots nearby.`;
    const intro = isRecCenter
      ? `A free public recreation center in ${esc(areas.length ? inArea(areas[0]) : cfg.name)}, ${esc(cfg.name)}, with posted ${isFacility ? 'open-gym and outdoor drop-in' : 'open-gym'} hours for ${esc(andList(labels).toLowerCase())}. Drop-in is free and first come, first served — no booking, no membership.${c.disclaimer ? ` ${esc(c.disclaimer)}` : ''} The app shows what's open right now and how busy it is.`
      : `Free public ${esc(andList(labels).toLowerCase())} ${esc(place === 'indoor' ? 'at this rec center' : 'at this park')}${areas.length ? ` in ${esc(inArea(areas[0]))}` : ''}, ${esc(cfg.name)}.${c.disclaimer ? ` ${esc(c.disclaimer)}` : ''} The app shows what's open right now, how busy it is, and who else is playing.`;

    // The facility's hours are the union of its pins' — "when can I play here
    // at all", which is what openingHoursSpecification means for a venue.
    const ldCourt = isFacility
      ? { ...c, dropins: Object.fromEntries(sports.map((id) => [id, members.map((m) => m.dropins?.[id]).find((w) => w?.some((d) => d?.length)) || []])) }
      : c;

    pages.push({
      kind: 'court',
      cfg,
      path: courtPath(c),
      // Every other member's path serves this same page under this canonical.
      aliasPaths: members.filter((m) => m !== c).map(courtPath),
      short: c.name,
      hideFromNav: true,
      title,
      description,
      h1: c.name,
      intro,
      cta: { href: appUrl(cfg, { sport: primary, court: c.id }), label: 'Open this court in the app' },
      body:
        sportSections +
        `<h2>Location &amp; facilities</h2>${info}` +
        (c.lat && c.lng
          ? `<p class="more"><a href="https://www.google.com/maps/dir/?api=1&amp;destination=${c.lat},${c.lng}" rel="noopener">Directions</a></p>`
          : '') +
        nearSection +
        `<p class="more">${[
          ...sports.map((id) => `<a href="${sportPath(cfg, id)}">All ${esc(SPORT_BY_ID.get(id).label.toLowerCase())} in ${esc(cfg.name)}</a>`),
          ...(isRecCenter && hasRecCenters(cfg) ? [`<a href="${recCentersPath(cfg)}">${esc(cfg.name)} recreation centers</a>`] : []),
          ...areaHubsFor(c, cfg).map(([a, h]) => `<a href="${h.path}">Where to play in ${esc(inArea(a))}</a>`),
        ].join(' · ')}</p>`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          ...placeJsonLd({ ...c, dropinSport: primary }, labels[0], cfg),
          '@type': isRecCenter ? ['SportsActivityLocation', 'CivicStructure'] : 'SportsActivityLocation',
          openingHoursSpecification: useHours ? openingHours(ldCourt) : undefined,
        },
        breadcrumb(trail),
      ],
    });
  }
}

// Golf: one page per course, carrying the curated fees and booking links.
for (const c of golfCourses) {
  const g = c.golf;
  const gPath = `/golf/${c.id.replace(/-golf$/, '')}`;
  pages.push({
    kind: 'golf',
    cfg: SF,
    path: gPath,
    short: c.name,
    hideFromNav: true,
    title: `${c.name} — green fees, tee times & course info | ${SITE_NAME}`,
    description: `${c.name}, San Francisco: ${g.holes} holes, par ${g.par}${g.yards ? `, ${g.yards} yards` : ''} — green fees, tee-time booking, and what to expect on the course.`,
    h1: c.name,
    intro: `${esc(g.desc || '')} ${esc(`${g.holes} holes, par ${g.par}${g.yards ? `, ${g.yards} yards` : ''}.`)} One of San Francisco Rec &amp; Parks' ${golfCourses.length} public courses.`,
    cta: { href: appUrl(SF, { sport: 'golf', court: c.id }), label: 'Open in the app' },
    body:
      `<h2>The course</h2>${rows([
        ['Holes', String(g.holes)], ['Par', String(g.par)],
        g.yards ? ['Yardage', `${g.yards} yds`] : null,
        g.range ? ['Driving range', 'yes'] : null,
        g.beginner ? ['Beginner-friendly', 'yes'] : null,
        ['Address', c.address || '—'],
      ].filter(Boolean))}` +
      ((g.fees || []).length
        ? `<h2>Green fees</h2><ul class="places">${g.fees.map((f) => `<li><div class="hrs">💵 ${esc(f)}</div></li>`).join('')}</ul><p class="meta">Rates are curated from the course's published card and change roughly annually — confirm when booking.</p>`
        : '') +
      `<p class="more">${[
        g.bookUrl ? `<a href="${esc(g.bookUrl)}" rel="noopener">Book a tee time</a>` : null,
        g.website ? `<a href="${esc(g.website)}" rel="noopener">Official site</a>` : null,
        c.lat && c.lng ? `<a href="https://www.google.com/maps/dir/?api=1&amp;destination=${c.lat},${c.lng}" rel="noopener">Directions</a>` : null,
      ].filter(Boolean).join(' · ')}</p>` +
      `<p class="more"><a href="/golf">All ${golfCourses.length} San Francisco public golf courses</a></p>`,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'GolfCourse',
        name: c.name,
        description: g.desc || undefined,
        address: { '@type': 'PostalAddress', streetAddress: c.address, addressLocality: 'San Francisco', addressRegion: 'CA' },
        geo: c.lat && c.lng ? { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } : undefined,
      },
      breadcrumb([['San Francisco', '/'], ['Golf', '/golf'], [c.name, gPath]]),
    ],
  });
}

// --- area hubs: everything to play in one neighborhood / borough ----------------
//
// Cross-cuts the sport indexes. "what's in golden gate park" and "things to play
// in the mission" are area questions, not sport questions, and a multi-sport
// page answers them without splitting into thin neighborhood×sport permutations.
// A borough hub would otherwise relist all 200 of Brooklyn's basketball courts
// under every sport heading. Show a sample and hand off to the page that owns
// the full list (the sport×subregion page when there is one).
const AREA_SPORT_CAP = 12;
const EXISTING_PATHS = new Set(pages.map((p) => p.path));

for (const cfg of CITY_CFG) {
  for (const [area, { path: areaPath, courts: list }] of AREA_HUBS.get(cfg.id)) {
    const bySport = SPORTS.map((s) => [s, list.filter((c) => hasSport(c, s.id))]).filter(([, l]) => l.length);
    if (!bySport.length) continue;
    const sportBits = bySport.map(([s, l]) => `${l.length} ${s.label.toLowerCase()}`).join(', ');
    // Sections are resolved up front so the JSON-LD can describe exactly the
    // courts this page renders rather than the whole area.
    const sections = bySport.map(([s, l]) => {
      const sorted = l.slice().sort((a, b) => a.name.localeCompare(b.name));
      const subPath = `${sportPath(cfg, s.id)}/${slug(area)}`;
      return { s, total: l.length, shown: sorted.slice(0, AREA_SPORT_CAP), rest: EXISTING_PATHS.has(subPath) ? subPath : sportPath(cfg, s.id) };
    });
    const rendered = [...new Map(sections.flatMap((x) => x.shown.map((c) => [c.id, c]))).values()];
    pages.push({
      kind: 'area',
      cfg,
      path: areaPath,
      short: area,
      hideFromNav: true,
      title: `Where to Play in ${inArea(area)} — ${list.length} free courts & fields | ${SITE_NAME}`,
      description: `Every free public court and field in ${inArea(area)}, ${cfg.name} — ${sportBits} — with drop-in hours and what's open right now.`,
      h1: `Where to play in ${inArea(area)}`,
      intro: `${list.length} free public courts and fields in ${esc(inArea(area))}, ${esc(cfg.name)} — ${esc(sportBits)}. Drop-in hours below; the app shows what's open right now and how busy it is.`,
      cta: { href: appUrl(cfg), label: `Open the ${inArea(area)} map` },
      body:
        sections
          .map(({ s, total, shown, rest }) =>
            `<h2>${esc(s.emoji)} ${esc(s.label)} (${total})</h2><ul class="places">${shown
              .map((c) => courtLi(c, s.id, cfg))
              .join('\n')}</ul>${
              total > shown.length
                ? `<p class="more"><a href="${rest}">All ${total} ${esc(s.label.toLowerCase())} spots in ${esc(inArea(area))} →</a></p>`
                : ''
            }`
          )
          .join('\n') +
        `<p class="more">${bySport.map(([s]) => `<a href="${sportPath(cfg, s.id)}">All ${esc(s.label.toLowerCase())} in ${esc(cfg.name)}</a>`).join(' · ')}</p>`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `Free public courts and fields in ${inArea(area)}, ${cfg.name}`,
          numberOfItems: rendered.length,
          itemListElement: rendered.map((c, i) => ({
            '@type': 'ListItem', position: i + 1, item: placeJsonLd({ ...c, dropinSport: sportsAt(c)[0] }, SPORT_BY_ID.get(sportsAt(c)[0]).label, cfg),
          })),
        },
        breadcrumb([[cfg.name, cfg.prefix || '/'], [area, areaPath]]),
      ],
    });
  }
}

// Footer nav references every page, so collect them all before rendering any.
ALL_PAGES.push(...pages);
for (const p of pages) {
  writePage(p);
  // A merged rec center also answers at its other pin's URL — already indexed,
  // and the app deep-links to that court id — with the canonical pointing here.
  for (const alias of p.aliasPaths || []) {
    writePage({ ...p, path: alias, canonicalPath: p.path, aliasPaths: [] });
  }
}

// --- 404 -------------------------------------------------------------------------
//
// vercel.json deliberately has NO catch-all rewrite to /index.html. The app
// routes entirely on query params (lib/urlState.web.js: tab/sport/fav/court/
// add/city), so it only ever loads at "/" — a catch-all bought nothing and made
// every unknown path answer 200 with the app shell. That is a soft 404: Google
// flags them, and with ~800 generated URLs whose entities come and go (a rec
// center whose open-gym schedule empties out loses its page on the next scrape)
// stale links must 404 honestly instead of resolving to a decoy. Vercel serves
// this file, with a real 404 status, for anything that doesn't match a file.
const indexPages = ALL_PAGES.filter((p) => p.kind === 'sport' || p.kind === 'index');
fs.writeFileSync(
  path.join(DIST, '404.html'),
  pageHtml({
    cfg: SF,
    path: '/404',
    noindex: true,
    title: `Page not found | ${SITE_NAME}`,
    description: 'That page is not here. Browse every free public court, pool, and rec class in San Francisco and New York City.',
    h1: "That page isn't here",
    intro:
      'The link may be mistyped — or the spot may have closed, or dropped off the city\'s published schedule since the page was made. Everything below still works, and the live map always shows what\'s open right now.',
    cta: { href: '/', label: 'Open the live map' },
    body: CITY_CFG.map((c) => {
      const mine = indexPages.filter((p) => p.cfg.id === c.id);
      if (!mine.length) return '';
      return `<h2>${esc(c.name)}</h2><p class="more">${mine
        .map((p) => `<a href="${p.path}">${esc(p.short)}</a>`)
        .join(' · ')}</p>`;
    }).join('\n'),
  })
);

// --- patch dist/index.html (the SPA shell) -------------------------------------

const HOME_TITLE = 'RECreate — Basketball, Pickleball & Tennis Courts, Pools & Rec Classes in SF and NYC';
const HOME_DESC =
  'Free live map of every public place to play in San Francisco and New York City: basketball, pickleball, tennis, volleyball, soccer and more, plus pool schedules and rec classes. See what’s open now, check in, and find your game.';

// The injected block is fenced by markers and stripped before re-injecting, so
// running this pass twice over one export is a no-op rather than appending a
// second canonical/og:url/JSON-LD. A CI build exports fresh and patches once, so
// this only bites locally — but two conflicting canonicals mean Google ignores
// both, which is not a failure worth risking to save four lines.
const MARK = ['<!-- recreate:seo -->', '<!-- /recreate:seo -->'];
let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
html = html.replace(new RegExp(`${MARK[0]}[\\s\\S]*?${MARK[1]}`, 'g'), '');
const headTags = `
<title>${esc(HOME_TITLE)}</title>
<meta name="description" content="${esc(HOME_DESC)}">
<link rel="canonical" href="${SITE}/">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${SITE}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(HOME_TITLE)}">
<meta property="og:description" content="${esc(HOME_DESC)}">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: SITE_NAME,
  url: `${SITE}/`,
  description: HOME_DESC,
  applicationCategory: 'SportsApplication',
  operatingSystem: 'Web, iOS',
  installUrl: APP_STORE_URL,
  sameAs: [APP_STORE_URL],
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
})}</script>`;
html = html.replace(/<title>.*?<\/title>/s, '').replace('</head>', `${MARK[0]}${headTags}\n${MARK[1]}\n</head>`);
if (!/<html[^>]*\slang=/.test(html)) html = html.replace(/<html/, '<html lang="en"');
fs.writeFileSync(path.join(DIST, 'index.html'), html);

// --- og image, sitemap, robots ---------------------------------------------------

// The share card is a purpose-built 1200x630 (assets/og-card.html renders it —
// see that file to regenerate). The app icon used to fill this slot, but it is
// square: every share surface center-cropped it, and Twitter/Slack rendered a
// small thumbnail rather than the wide card. Fail loudly if it's missing —
// silently shipping no og:image is worse than a broken build.
const ogSrc = path.join(ROOT, 'assets', 'og.png');
if (!fs.existsSync(ogSrc)) {
  console.error('✗ assets/og.png missing — regenerate it from assets/og-card.html');
  process.exit(1);
}
fs.copyFileSync(ogSrc, path.join(DIST, 'og.png'));

// --- sitemap, with a lastmod that means something --------------------------------
//
// Every URL used to carry the build date. The refresh crons commit several
// times a day, so the sitemap claimed all ~800 pages changed today, every day —
// and a lastmod that is always "now" is a lastmod Google learns to ignore,
// which costs exactly the crawl priority the field exists to buy.
//
// So each page is hashed on its own content (title, description, body, JSON-LD
// — not the footer nav, which changes on every page whenever any page is added)
// and its date is carried forward from the last build unless the hash moved.
// The manifest lives beside the pages it describes and is fetched back from the
// live site on the next build: a Vercel build cannot commit to the repo, and
// this is the same live→fallback shape the data scrapers use.
//
// If that fetch fails we have no dates, only hashes — so the sitemap ships with
// NO lastmod at all rather than stamping everything with today. Omitting the
// field is what Google asks for when you can't maintain it accurately; the
// alternative would re-tell the exact lie this replaces.
const MANIFEST = 'seo-lastmod.json';
const today = TODAY;
const contentHash = (p) =>
  crypto
    .createHash('sha1')
    .update(JSON.stringify([p.title, p.description, p.h1, p.intro, p.body, p.jsonLd || null]))
    .digest('hex')
    .slice(0, 16);

async function loadPrevManifest() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(`${SITE}/${MANIFEST}`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object' || !json.pages) throw new Error('unrecognised shape');
    return json.pages;
  } catch (err) {
    console.warn(`⚠ ${MANIFEST}: no previous manifest (${err.message}) — sitemap ships without lastmod`);
    return null;
  }
}

(async () => {
  const prev = await loadPrevManifest();
  const manifest = {};
  let changed = 0;
  for (const p of pages) {
    const hash = contentHash(p);
    const was = prev?.[p.path];
    // A page whose hash matches keeps the date it already had; a new or edited
    // one is dated today, which is the one moment we actually know it changed.
    const lastmod = was && was.hash === hash ? was.lastmod : today;
    if (!was || was.hash !== hash) changed++;
    manifest[p.path] = { hash, lastmod };
  }
  // The SPA shell. Its indexable content is the head this script patches in.
  const homeHash = crypto.createHash('sha1').update(HOME_TITLE + HOME_DESC).digest('hex').slice(0, 16);
  manifest['/'] = {
    hash: homeHash,
    lastmod: prev?.['/']?.hash === homeHash ? prev['/'].lastmod : today,
  };

  const urls = ['/', ...pages.map((p) => p.path)];
  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => {
        const lastmod = prev ? `<lastmod>${manifest[u].lastmod}</lastmod>` : '';
        return `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc>${lastmod}</url>`;
      })
      .join('\n')}\n</urlset>\n`
  );
  fs.writeFileSync(
    path.join(DIST, MANIFEST),
    `${JSON.stringify({ generated: today, pages: manifest })}\n`
  );
  fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

  console.log(`✓ index.html <head> patched (App Store id ${APP_STORE_ID})`);
  for (const cfg of CITY_CFG) {
    const mine = pages.filter((p) => p.cfg.id === cfg.id);
    const tally = mine.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
    console.log(`✓ ${cfg.name}: ${mine.length} pages (${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')})`);
  }
  const aliases = pages.reduce((n, p) => n + (p.aliasPaths?.length || 0), 0);
  if (aliases) console.log(`✓ ${aliases} merged facility path${aliases === 1 ? '' : 's'} served under a shared canonical`);
  console.log(
    prev
      ? `✓ sitemap.xml (${urls.length} urls, ${changed} with a new lastmod) + ${MANIFEST} + robots.txt + og.png`
      : `✓ sitemap.xml (${urls.length} urls, no lastmod) + ${MANIFEST} + robots.txt + og.png`
  );
})();
