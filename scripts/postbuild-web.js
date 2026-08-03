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
const SITE = 'https://recreate-sf.vercel.app';
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
const { POOLS } = loadModule('data/pools.js');
const { CLASSES, CLASS_CATEGORIES } = loadModule('data/classes.js');
const { SPORTS } = loadModule('lib/sports.js');
const { CITY_COURTS, CITY_CLASSES } = loadModule('data/cities/index.js');
const { PARK_HOURS: NYC_PARK_HOURS } = loadModule('data/cities/nyc/outdoor-courts.js');

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
    if (f.surf?.length) bits.push(f.surf.join('/').toLowerCase());
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
    classes: CLASSES,
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

const hasSport = (c, sportId) => {
  const week = c.dropins?.[sportId];
  return Array.isArray(week) && week.some((day) => day && day.length);
};

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
const courtLi = (c, sportId, cfg) => {
  const useHours = c.indoor || !cfg.parkHours;
  const detail = useHours ? weekSummary(c.dropins?.[sportId]) : factsLine(c, sportId);
  const place = c.indoor ? 'Indoor' : 'Outdoor';
  const meta = [place, c.address, c.neighborhood].filter(Boolean).join(' · ');
  return `<li>
<span class="nm">${esc(c.name)}</span>
<div class="meta">${esc(meta)}</div>
${detail ? `<div class="hrs">${esc(detail)}</div>` : ''}
<a class="map" href="${appUrl(cfg, { sport: sportId, court: c.id })}">Open in the map</a>
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
      ? `Outdoor courts (first come, first served${cfg.parkHours ? `, park hours ${fmtTime(cfg.parkHours[0])}–${fmtTime(cfg.parkHours[1])}` : ''})`
      : 'Outdoor courts (first come, first served)';

    pages.push({
      cfg,
      path: base,
      short: s.label,
      title: `${s.label} in ${cfg.name} — ${courts.length} free public ${nounHead} | ${SITE_NAME}`,
      description: `Where to play ${s.label.toLowerCase()} in ${cfg.shortName}: all ${courts.length} public ${noun} with drop-in and open-gym hours, on a free live map. Data from ${cfg.attribution.name}, updated regularly.`,
      h1: `${s.label} in ${cfg.name}`,
      intro: `Every free public place to play ${esc(s.label.toLowerCase())} in ${esc(cfg.name)} — ${indoor.length ? `${indoor.length} indoor rec center${indoor.length === 1 ? '' : 's'} with scheduled drop-in times` : ''}${indoor.length && outdoor.length ? ' and ' : ''}${outdoor.length ? `${outdoor.length} outdoor first-come, first-served location${outdoor.length === 1 ? '' : 's'}` : ''}. See what's open right now on the live map, check in, and find people to play with.`,
      cta: { href: appUrl(cfg, { sport: s.id }), label: `See ${s.label.toLowerCase()} on the live map` },
      body: section('Indoor drop-in / open gym', indoor) + byArea + section(outdoorLabel, inlineOutdoor),
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
<span class="nm">${esc(c.name)}</span>
<div class="meta">${esc([c.address, facts].filter(Boolean).join(' · '))}</div>
<div class="hrs">${esc(g.desc || '')}</div>
${(g.fees || []).map((f) => `<div class="hrs">💵 ${esc(f)}</div>`).join('')}
${g.bookUrl ? `<a class="map" href="${esc(g.bookUrl)}" rel="noopener">Book a tee time</a> · ` : ''}<a class="map" href="${appUrl(SF, { sport: 'golf', court: c.id })}">Open in the map</a>
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

// Footer nav references every page, so collect them all before rendering any.
ALL_PAGES.push(...pages);
for (const p of pages) writePage(p);

// --- patch dist/index.html (the SPA shell) -------------------------------------

const HOME_TITLE = 'RECreate — Basketball, Pickleball & Tennis Courts, Pools & Rec Classes in SF and NYC';
const HOME_DESC =
  'Free live map of every public place to play in San Francisco and New York City: basketball, pickleball, tennis, volleyball, soccer and more, plus pool schedules and rec classes. See what’s open now, check in, and find your game.';

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
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
html = html.replace(/<title>.*?<\/title>/s, '').replace('</head>', `${headTags}\n</head>`);
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
  console.log(`✓ ${cfg.name}: ${mine.length} pages — ${mine.map((p) => p.path).join(' ')}`);
}
console.log(`✓ sitemap.xml (${urls.length} urls) + robots.txt + og.png`);
