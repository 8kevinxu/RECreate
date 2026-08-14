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
const { LIGHTS: NYC_LIGHTS } = loadModule('data/cities/nyc/reservations.js');

// Same merge as lib/useCourts.js: bundled indoor list first, extras deduped by id.
const ids = new Set(COURTS.map((c) => c.id));
const SF_COURTS = COURTS.concat(
  [...MANUAL_COURTS, ...SANBRUNO_COURTS, ...OUTDOOR_COURTS].filter((c) => !ids.has(c.id))
);

// --- small formatting helpers ------------------------------------------------

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
    pools: true,
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
    pools: false,
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
  const { path: pagePath, title, description, h1, intro, cta, body, jsonLd, cfg } = page;
  const canonical = `${SITE}${pagePath}`;
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
<link rel="canonical" href="${canonical}">
<meta name="apple-itunes-app" content="app-id=${APP_STORE_ID}, app-argument=${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary">
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
  const named = COURT_PAGE_IDS.has(c.id)
    ? `<a class="nm" href="${courtPath(c)}">${esc(c.name)}</a>`
    : `<span class="nm">${esc(c.name)}</span>`;
  return `<li>
${named}${extra}
<div class="meta">${esc(meta)}</div>
${detail ? `<div class="hrs">${esc(detail)}</div>` : ''}
${COURT_PAGE_IDS.has(c.id) ? `<a class="map" href="${courtPath(c)}">Hours &amp; details</a> · ` : ''}<a class="map" href="${appUrl(cfg, { sport: sportId, court: c.id })}">Open in the map</a>
</li>`;
};

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

// Pools: the 9 public pools with seasons, programs, and schedule-PDF links.
const KIND_LABEL = { lap: 'lap swim', family: 'family swim', senior: 'senior swim', lessons: 'swim lessons', adult_lessons: 'adult lessons', parent_child: 'parent & child', exercise: 'water exercise', camp: 'day camp', rental: 'rentals', other: 'programs' };
pages.push({
  kind: 'index',
  cfg: SF,
  path: '/pools',
  short: 'Pools',
  title: `Public Swimming Pools in San Francisco — schedules for all ${POOLS.length} SF pools | ${SITE_NAME}`,
  description: `Lap swim, family swim, and lesson schedules for all ${POOLS.length} San Francisco public pools — Balboa, Coffman, Garfield, Hamilton, MLK, Mission, North Beach, Rossi, and Sava — updated from each pool's official seasonal schedule.`,
  h1: 'Public swimming pools in San Francisco',
  intro: `San Francisco has ${POOLS.length} public pools run by Rec &amp; Parks. Drop-in swims are cheap ($8 adults, $2 kids); each pool posts a seasonal schedule. The app shows today's sessions live — below is each pool with its programs and official schedule.`,
  cta: { href: appUrl(SF, { sport: 'swimming' }), label: 'See today’s swim times' },
  body: `<ul class="places">${POOLS.map((p) => {
    const sessions = p.sessions.reduce((n, day) => n + (day?.length || 0), 0);
    const programs = (p.programs || []).map((k) => KIND_LABEL[k] || k).join(', ');
    return `<li>
<span class="nm">${esc(p.name)}</span>
<div class="meta">${esc([p.address, p.phone].filter(Boolean).join(' · '))}</div>
<div class="hrs">Season ${esc(p.season || '')} · ${sessions} sessions/week: ${esc(programs)}</div>
${(p.scheduleUrls || []).map((u) => `<a class="map" href="${esc(u.url)}" rel="noopener">Official schedule (PDF)</a>`).join(' · ')} · <a class="map" href="${appUrl(SF, { sport: 'swimming', court: p.id })}">Open in the app</a>
</li>`;
  }).join('\n')}</ul>`,
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Public swimming pools in San Francisco',
    numberOfItems: POOLS.length,
    itemListElement: POOLS.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'PublicSwimmingPool', name: p.name, address: { '@type': 'PostalAddress', streetAddress: p.address, addressLocality: 'San Francisco', addressRegion: 'CA' }, geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng }, telephone: p.phone || undefined },
    })),
  },
});

// Classes: per-city category index with sample titles (the full catalog is in-app).
for (const cfg of CITY_CFG) {
  const list = cfg.classes;
  if (!list?.length) continue;
  const byCat = new Map();
  for (const c of list) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const free = list.filter((c) => /free/i.test(c.cost || '')).length;
  pages.push({
    kind: 'index',
    cfg,
    path: `${cfg.prefix}/classes`,
    short: 'Classes',
    title: `${cfg.classSource} Classes — ${list.length} drop-in classes & programs | ${SITE_NAME}`,
    description: `Browse ${list.length} ${cfg.name} ${cfg.classSource} classes and drop-in programs — fitness, dance, swim lessons, arts, sports and more — with prices, ages, and open spots, updated every 6 hours.`,
    h1: cfg.classesH1,
    intro: `${list.length} classes and drop-in programs across ${esc(cfg.classSource)} facilities, with live availability, prices, and age ranges${free ? ` — ${free} of them free` : ''}. Browse the full searchable catalog in the app; here's what's on offer by category.`,
    cta: { href: appUrl(cfg, { tab: 'classes' }), label: 'Browse all classes' },
    body: CLASS_CATEGORIES.filter((cat) => byCat.get(cat.id)?.length)
      .map((cat) => {
        const items = byCat.get(cat.id);
        const names = [...new Set(items.map((c) => c.name))].slice(0, 8);
        return `<h2>${esc(cat.emoji)} ${esc(cat.label)} (${items.length})</h2><p class="meta">${names.map(esc).join(' · ')}${items.length > names.length ? ' · …' : ''}</p>`;
      })
      .join('\n'),
  });
}

// --- detail pages: one per court, pool and golf course --------------------------
//
// The long tail. "moscone rec center open gym hours" and "hamilton pool lap
// swim schedule" are the queries these answer, and the answer is a fact we
// already hold — the sport indexes above can only ever rank for the head term.

const SPORT_BY_ID = new Map(SPORTS.map((s) => [s.id, s]));
const sportPagePath = (cfg, sportId) => `${cfg.prefix}/${SPORT_PATHS[sportId] || sportId}`;

const breadcrumb = (trail) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: trail.map(([name, url], i) => ({
    '@type': 'ListItem', position: i + 1, name, item: `${SITE}${url}`,
  })),
});

const rows = (list) =>
  `<table style="border-collapse:collapse;font-size:14px;margin:4px 0 0">${list
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;opacity:.7;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`)
    .join('')}</table>`;

for (const cfg of CITY_CFG) {
  const byId = new Map(cfg.courts.map((c) => [c.id, c]));
  for (const c of cfg.courts) {
    if (!COURT_PAGE_IDS.has(c.id)) continue;
    const sports = sportsAt(c);
    const labels = sports.map((id) => SPORT_BY_ID.get(id).label);
    const useHours = c.indoor || !cfg.parkHours;
    const areas = areasOf(c);
    const place = c.indoor ? 'indoor' : 'outdoor';

    // Per-sport: the full week for real schedules, facility facts otherwise.
    const sportSections = sports
      .map((id) => {
        const s = SPORT_BY_ID.get(id);
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
        return `<h2>${esc(head)}</h2>${detail}${dirLine}${resLine}`;
      })
      .join('\n');

    // Nearby: same-sport alternatives, which is the thing you actually want when
    // a court turns out to be closed or packed.
    const primary = sports[0];
    const near = cfg.courts
      .filter((o) => o.id !== c.id && sportsAt(o).includes(primary))
      .map((o) => ({ o, d: milesBetween(c, o) }))
      .filter((x) => x.d != null)
      .sort((a, b) => a.d - b.d)
      .slice(0, 6);
    const nearSection = near.length
      ? `<h2>Other ${esc(SPORT_BY_ID.get(primary).label.toLowerCase())} nearby</h2><ul class="places">${near
          .map(({ o, d }) => courtLi(o, primary, cfg, ` <span class="meta">${fmtMiles(d)} away</span>`))
          .join('\n')}</ul>`
      : '';

    const amenities = [c.accessible ? 'wheelchair accessible' : null, c.restrooms ? 'restrooms' : null, c.water ? 'drinking water' : null].filter(Boolean);
    const info = rows([
      ['Address', c.address || '—'],
      areas.length ? [cfg.subregionLabel === 'borough' ? 'Borough' : 'Neighborhood', areas.join(', ')] : null,
      ['Type', `${place === 'indoor' ? 'Indoor rec center' : 'Outdoor'} · free drop-in`],
      // No posted schedule to show, so name the window these courts are open in.
      !useHours && cfg.parkHours ? ['Park hours', parkHoursPhrase(cfg, c)] : null,
      amenities.length ? ['Amenities', amenities.join(', ')] : null,
      c.notes ? ['Notes', c.notes] : null,
    ].filter(Boolean));

    const trail = [
      [cfg.name, cfg.prefix || '/'],
      [SPORT_BY_ID.get(primary).label, sportPagePath(cfg, primary)],
      [c.name, courtPath(c)],
    ];

    pages.push({
      kind: 'court',
      cfg,
      path: courtPath(c),
      short: c.name,
      hideFromNav: true,
      title: `${c.name} — ${labels.slice(0, 3).join(', ')} drop-in hours | ${SITE_NAME}`,
      description: `${c.name}${c.address ? ` at ${c.address}` : ''}, ${cfg.name}: free ${place} ${andList(labels.slice(0, 3)).toLowerCase()}${useHours ? ' with the full weekly drop-in schedule' : ' — courts, surfaces and amenities'}, plus what's open right now and other spots nearby.`,
      h1: c.name,
      intro: `Free public ${esc(andList(labels).toLowerCase())} ${esc(place === 'indoor' ? 'at this rec center' : 'at this park')}${areas.length ? ` in ${esc(inArea(areas[0]))}` : ''}, ${esc(cfg.name)}.${c.disclaimer ? ` ${esc(c.disclaimer)}` : ''} The app shows what's open right now, how busy it is, and who else is playing.`,
      cta: { href: appUrl(cfg, { sport: primary, court: c.id }), label: 'Open this court in the app' },
      body:
        sportSections +
        `<h2>Location &amp; facilities</h2>${info}` +
        (c.lat && c.lng
          ? `<p class="more"><a href="https://www.google.com/maps/dir/?api=1&amp;destination=${c.lat},${c.lng}" rel="noopener">Directions</a></p>`
          : '') +
        nearSection +
        `<p class="more">${[
          ...sports.map((id) => `<a href="${sportPagePath(cfg, id)}">All ${esc(SPORT_BY_ID.get(id).label.toLowerCase())} in ${esc(cfg.name)}</a>`),
          ...areaHubsFor(c, cfg).map(([a, h]) => `<a href="${h.path}">Where to play in ${esc(inArea(a))}</a>`),
        ].join(' · ')}</p>`,
      jsonLd: [
        {
          '@context': 'https://schema.org',
          ...placeJsonLd({ ...c, dropinSport: primary }, labels[0], cfg),
          openingHoursSpecification: useHours ? openingHours(c) : undefined,
        },
        breadcrumb(trail),
      ],
    });
  }
}

// Pools: one page each. A pool's weekly grid by session kind is the whole
// reason someone searches for it, and the city publishes it only as a PDF.
// Public-swim sessions first — those are what someone searching a pool's name
// wants; lessons, camps and rentals are the ones they can't just show up for.
const KIND_ORDER = ['lap', 'family', 'senior', 'exercise', 'parent_child', 'adult_lessons', 'lessons', 'camp', 'rental', 'other'];
for (const p of POOLS) {
  const kinds = [...new Set(p.sessions.flat().filter(Boolean).map((s) => s.kind))].sort(
    (a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99)
  );
  const bySeq = kinds.map((k) => {
    // Dedupe by start/end: a facility with separate warm- and cool-pool PDFs
    // (North Beach) can run the same session kind at the same time in both.
    const week = Array.from({ length: 7 }, (_, d) => {
      const seen = new Set();
      return (p.sessions[d] || [])
        .filter((s) => s.kind === k)
        .filter((s) => !seen.has(`${s.start}-${s.end}`) && seen.add(`${s.start}-${s.end}`))
        .map((s) => [s.start, s.end]);
    });
    return [k, dayRows(week)];
  }).filter(([, r]) => r.length);
  const nearPools = POOLS.filter((o) => o.id !== p.id).map((o) => ({ o, d: milesBetween(p, o) })).filter((x) => x.d != null).sort((a, b) => a.d - b.d).slice(0, 3);
  const feeRows = (POOL_FEES.groups || []).map((g) => [g.label, `$${g.dropIn} drop-in${(g.passes || []).length ? ` · ${g.passes.map(([l, v]) => `${l} $${v}`).join(' · ')}` : ''}`]);
  pages.push({
    kind: 'pool',
    cfg: SF,
    path: `/pools/${p.id.replace(/^pool-/, '')}`,
    short: p.name,
    hideFromNav: true,
    title: `${p.name} — lap swim & schedule | San Francisco public pool | ${SITE_NAME}`,
    description: `${p.name}${p.address ? ` at ${p.address}` : ''}: the full weekly schedule — ${bySeq.map(([k]) => KIND_LABEL[k] || k).join(', ')} — plus drop-in fees, season dates, and the official SF Rec & Parks schedule PDF.`,
    h1: p.name,
    intro: `${esc(p.desc || `${p.name} is one of San Francisco's ${POOLS.length} public pools.`)} Season ${esc(p.season || '')}. Drop-in swims are $8 for adults and $2 for kids; the schedule below comes from the pool's own posted PDF.`,
    cta: { href: appUrl(SF, { sport: 'swimming', court: p.id }), label: 'See today’s swim times' },
    body:
      bySeq.map(([k, r]) => `<h2>${esc(KIND_LABEL[k] || k)}</h2>${rows(r)}`).join('\n') +
      `<h2>Location</h2>${rows([['Address', p.address || '—'], p.phone ? ['Phone', p.phone] : null, ['Season', p.season || '—']].filter(Boolean))}` +
      (feeRows.length ? `<h2>Fees</h2>${rows(feeRows)}<p class="meta">City-wide pool rates, effective ${esc(POOL_FEES.effective || '')}.</p>` : '') +
      (p.lat && p.lng ? `<p class="more"><a href="https://www.google.com/maps/dir/?api=1&amp;destination=${p.lat},${p.lng}" rel="noopener">Directions</a></p>` : '') +
      (p.scheduleUrls || []).map((u) => `<p class="more"><a href="${esc(u.url)}" rel="noopener">Official schedule (PDF)</a></p>`).join('') +
      (nearPools.length ? `<h2>Other pools nearby</h2><ul class="places">${nearPools.map(({ o, d }) => `<li><a class="nm" href="/pools/${o.id.replace(/^pool-/, '')}">${esc(o.name)}</a> <span class="meta">${fmtMiles(d)} away</span><div class="meta">${esc(o.address || '')}</div></li>`).join('')}</ul>` : '') +
      `<p class="more"><a href="/pools">All ${POOLS.length} San Francisco public pools</a></p>`,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'PublicSwimmingPool',
        name: p.name,
        description: p.desc || undefined,
        address: { '@type': 'PostalAddress', streetAddress: p.address, addressLocality: 'San Francisco', addressRegion: 'CA' },
        geo: p.lat && p.lng ? { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } : undefined,
        telephone: p.phone || undefined,
      },
      breadcrumb([['San Francisco', '/'], ['Pools', '/pools'], [p.name, `/pools/${p.id.replace(/^pool-/, '')}`]]),
    ],
  });
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
      const subPath = `${sportPagePath(cfg, s.id)}/${slug(area)}`;
      return { s, total: l.length, shown: sorted.slice(0, AREA_SPORT_CAP), rest: EXISTING_PATHS.has(subPath) ? subPath : sportPagePath(cfg, s.id) };
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
        `<p class="more">${bySport.map(([s]) => `<a href="${sportPagePath(cfg, s.id)}">All ${esc(s.label.toLowerCase())} in ${esc(cfg.name)}</a>`).join(' · ')}</p>`,
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
for (const p of pages) writePage(p);

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
<meta name="twitter:card" content="summary">
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

const icon = path.join(ROOT, 'assets', 'icon.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(DIST, 'og.png'));

const today = new Date().toISOString().slice(0, 10);
const urls = ['/', ...pages.map((p) => p.path)];
fs.writeFileSync(
  path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')}\n</urlset>\n`
);
fs.writeFileSync(path.join(DIST, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);

console.log(`✓ index.html <head> patched (App Store id ${APP_STORE_ID})`);
for (const cfg of CITY_CFG) {
  const mine = pages.filter((p) => p.cfg.id === cfg.id);
  const tally = mine.reduce((m, p) => ((m[p.kind] = (m[p.kind] || 0) + 1), m), {});
  console.log(`✓ ${cfg.name}: ${mine.length} pages (${Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ')})`);
}
console.log(`✓ sitemap.xml (${urls.length} urls) + robots.txt + og.png`);
