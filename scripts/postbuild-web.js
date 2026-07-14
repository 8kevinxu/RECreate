// SEO post-build pass for the web export (npm run build:web) — runs AFTER
// `npx expo export --platform web` and rewrites/augments `dist/` in place:
//
//   1. Injects real <head> metadata into dist/index.html (title, description,
//      canonical, OpenGraph/Twitter cards, JSON-LD) — the raw Expo export ships
//      an empty-bodied SPA shell that gives crawlers nothing to index.
//   2. Emits static, crawlable landing pages from the bundled data —
//      /basketball, /pickleball, /tennis, …, /golf, /pools, /classes — each a
//      real HTML document (h1, court list with addresses + drop-in hours,
//      SportsActivityLocation JSON-LD) linking into the app via the URL-state
//      params (lib/urlState.web.js). Both hosts serve real files before the
//      SPA rewrite, so these coexist with the app untouched.
//   3. Emits sitemap.xml + robots.txt and copies the app icon to /og.png.
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
const { SPORTS, GOLF } = loadModule('lib/sports.js');

// Same merge as lib/useCourts.js: bundled indoor list first, extras deduped by id.
const ids = new Set(COURTS.map((c) => c.id));
const ALL_COURTS = COURTS.concat(
  [...MANUAL_COURTS, ...SANBRUNO_COURTS, ...OUTDOOR_COURTS].filter((c) => !ids.has(c.id))
);

// --- small formatting helpers ------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

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

// --- shared page template -----------------------------------------------------

const NAV_PAGES = []; // filled as pages are defined; footer links every page

const CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         line-height: 1.55; color: #1c2733; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #101720; } a { color: #6bb2ff; } }
  main { max-width: 760px; margin: 0 auto; padding: 16px 20px 48px; }
  header.site { border-bottom: 1px solid rgba(128,128,128,.25); }
  header.site .in { max-width: 760px; margin: 0 auto; padding: 14px 20px; display: flex; gap: 12px; align-items: center; }
  header.site a { font-weight: 700; text-decoration: none; color: inherit; font-size: 18px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 18px 0 6px; }
  h2 { font-size: 19px; margin: 28px 0 8px; }
  .lede { margin: 0 0 14px; opacity: .85; }
  .cta { display: inline-block; background: #ff7a1a; color: #fff !important; font-weight: 700; text-decoration: none;
         padding: 10px 18px; border-radius: 999px; margin: 6px 0 10px; }
  ul.places { list-style: none; padding: 0; margin: 0; }
  ul.places li { padding: 12px 0; border-bottom: 1px solid rgba(128,128,128,.18); }
  ul.places .nm { font-weight: 700; }
  ul.places .meta { font-size: 14px; opacity: .8; }
  ul.places .hrs { font-size: 14px; margin-top: 2px; }
  ul.places a.map { font-size: 14px; }
  footer { max-width: 760px; margin: 0 auto; padding: 20px; border-top: 1px solid rgba(128,128,128,.25);
           font-size: 14px; opacity: .85; }
  footer nav a { margin-right: 10px; white-space: nowrap; }
`;

function pageHtml({ path: pagePath, title, description, h1, intro, cta, body, jsonLd }) {
  const canonical = `${SITE}${pagePath}`;
  const nav = NAV_PAGES.map((p) => `<a href="${p.path}">${esc(p.short)}</a>`).join(' ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
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
<header class="site"><div class="in"><a href="/">🏀 ${SITE_NAME}</a><span style="opacity:.6;font-size:14px">Find your game in San Francisco</span></div></header>
<main>
<h1>${esc(h1)}</h1>
<p class="lede">${intro}</p>
<a class="cta" href="${cta.href}">${esc(cta.label)} →</a>
${body}
</main>
<footer>
<nav><a href="/">Live map</a> ${nav}</nav>
<p>Court, pool, and class data from <a href="https://sfrecpark.org" rel="noopener">SF Recreation &amp; Parks</a> public sources — refreshed weekly. ${SITE_NAME} is a free community app and is not affiliated with SF Rec &amp; Parks.</p>
<p><a href="/privacy.html">Privacy</a> · <a href="/support.html">Support</a></p>
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

const placeJsonLd = (c, sportLabel) => ({
  '@type': 'SportsActivityLocation',
  name: c.name,
  description: `Public ${sportLabel.toLowerCase()} in San Francisco`,
  address: {
    '@type': 'PostalAddress',
    streetAddress: c.address || undefined,
    addressLocality: 'San Francisco',
    addressRegion: 'CA',
  },
  geo: c.lat && c.lng ? { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng } : undefined,
  isAccessibleForFree: true,
  url: `${SITE}/?sport=${encodeURIComponent(c.dropinSport || '')}&court=${encodeURIComponent(c.id)}`,
});

const courtLi = (c, sportId) => {
  const hours = weekSummary(c.dropins?.[sportId]);
  const place = c.indoor ? 'Indoor' : 'Outdoor';
  const meta = [place, c.address, c.neighborhood].filter(Boolean).join(' · ');
  return `<li>
<span class="nm">${esc(c.name)}</span>
<div class="meta">${esc(meta)}</div>
${hours ? `<div class="hrs">${esc(hours)}</div>` : ''}
<a class="map" href="/?sport=${encodeURIComponent(sportId)}&court=${encodeURIComponent(c.id)}">Open in the map</a>
</li>`;
};

const pages = [];

// One landing page per playable sport: indoor open-gym section + outdoor section.
const SPORT_PATHS = { pingpong: '/ping-pong' };
const SPORT_NOUN = {
  basketball: 'basketball courts', volleyball: 'volleyball courts & open gyms',
  pingpong: 'ping pong tables', badminton: 'badminton courts',
  pickleball: 'pickleball courts', tennis: 'tennis courts',
  soccer: 'soccer fields', baseball: 'baseball fields',
};

for (const s of SPORTS) {
  const courts = ALL_COURTS.filter((c) => hasSport(c, s.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (!courts.length) continue;
  const indoor = courts.filter((c) => c.indoor);
  const outdoor = courts.filter((c) => !c.indoor);
  const noun = SPORT_NOUN[s.id] || `${s.label.toLowerCase()} courts`;
  const pagePath = SPORT_PATHS[s.id] || `/${s.id}`;

  const section = (label, list) =>
    list.length ? `<h2>${esc(label)}</h2><ul class="places">${list.map((c) => courtLi(c, s.id)).join('\n')}</ul>` : '';

  pages.push({
    path: pagePath,
    short: s.label,
    title: `${s.label} in San Francisco — ${courts.length} free public ${noun.includes('court') || noun.includes('field') || noun.includes('table') ? noun.split('&')[0].trim() : 'spots'} | ${SITE_NAME}`,
    description: `Where to play ${s.label.toLowerCase()} in SF: all ${courts.length} public ${noun} with drop-in and open-gym hours, on a free live map. Data from SF Rec & Parks, updated weekly.`,
    h1: `${s.label} in San Francisco`,
    intro: `Every free public place to play ${esc(s.label.toLowerCase())} in San Francisco — ${indoor.length ? `${indoor.length} indoor rec centers with scheduled drop-in times` : ''}${indoor.length && outdoor.length ? ' and ' : ''}${outdoor.length ? `${outdoor.length} outdoor first-come, first-served locations` : ''}. See what's open right now on the live map, check in, and find people to play with.`,
    cta: { href: `/?sport=${s.id}`, label: `See ${s.label.toLowerCase()} on the live map` },
    body: section('Indoor drop-in / open gym', indoor) + section('Outdoor courts (first come, first served)', outdoor),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `Public ${s.label.toLowerCase()} in San Francisco`,
      numberOfItems: courts.length,
      itemListElement: courts.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: placeJsonLd({ ...c, dropinSport: s.id }, s.label),
      })),
    },
  });
}

// Golf: the 6 SFRPD courses, with the curated course facts.
const golfCourses = ALL_COURTS.filter((c) => c.golf);
if (golfCourses.length) {
  pages.push({
    path: '/golf',
    short: 'Golf',
    title: `Public Golf Courses in San Francisco — all ${golfCourses.length} SF Rec & Parks courses | ${SITE_NAME}`,
    description: `All ${golfCourses.length} public golf courses in San Francisco with holes, par, green fees, and tee-time booking links — from TPC Harding Park to the beginner-friendly Golden Gate Park 9.`,
    h1: 'Public golf courses in San Francisco',
    intro: `San Francisco Rec &amp; Parks runs ${golfCourses.length} public courses, from a championship 18 to walkable par-3 loops. Fees below are curated from each course's published rates.`,
    cta: { href: '/?sport=golf', label: 'See golf courses on the live map' },
    body: `<ul class="places">${golfCourses
      .map((c) => {
        const g = c.golf;
        const facts = [`${g.holes} holes`, `par ${g.par}`, g.yards ? `${g.yards} yds` : null, g.range ? 'driving range' : null, g.beginner ? 'beginner-friendly' : null].filter(Boolean).join(' · ');
        return `<li>
<span class="nm">${esc(c.name)}</span>
<div class="meta">${esc([c.address, facts].filter(Boolean).join(' · '))}</div>
<div class="hrs">${esc(g.desc || '')}</div>
${(g.fees || []).map((f) => `<div class="hrs">💵 ${esc(f)}</div>`).join('')}
${g.bookUrl ? `<a class="map" href="${esc(g.bookUrl)}" rel="noopener">Book a tee time</a> · ` : ''}<a class="map" href="/?sport=golf&court=${encodeURIComponent(c.id)}">Open in the map</a>
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
  path: '/pools',
  short: 'Pools',
  title: `Public Swimming Pools in San Francisco — schedules for all ${POOLS.length} SF pools | ${SITE_NAME}`,
  description: `Lap swim, family swim, and lesson schedules for all ${POOLS.length} San Francisco public pools — Balboa, Coffman, Garfield, Hamilton, MLK, Mission, North Beach, Rossi, and Sava — updated from each pool's official seasonal schedule.`,
  h1: 'Public swimming pools in San Francisco',
  intro: `San Francisco has ${POOLS.length} public pools run by Rec &amp; Parks. Drop-in swims are cheap ($8 adults, $2 kids); each pool posts a seasonal schedule. The app shows today's sessions live — below is each pool with its programs and official schedule.`,
  cta: { href: '/?tab=pools', label: 'See today’s swim times' },
  body: `<ul class="places">${POOLS.map((p) => {
    const sessions = p.sessions.reduce((n, day) => n + (day?.length || 0), 0);
    const programs = (p.programs || []).map((k) => KIND_LABEL[k] || k).join(', ');
    return `<li>
<span class="nm">${esc(p.name)}</span>
<div class="meta">${esc([p.address, p.phone].filter(Boolean).join(' · '))}</div>
<div class="hrs">Season ${esc(p.season || '')} · ${sessions} sessions/week: ${esc(programs)}</div>
${(p.scheduleUrls || []).map((u) => `<a class="map" href="${esc(u.url)}" rel="noopener">Official schedule (PDF)</a>`).join(' · ')} · <a class="map" href="/?tab=pools">Open in the app</a>
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

// Classes: category index with sample class titles (the full catalog lives in-app).
const byCat = new Map();
for (const c of CLASSES) {
  if (!byCat.has(c.category)) byCat.set(c.category, []);
  byCat.get(c.category).push(c);
}
pages.push({
  path: '/classes',
  short: 'Classes',
  title: `SF Rec & Parks Classes — ${CLASSES.length} drop-in classes & programs | ${SITE_NAME}`,
  description: `Browse ${CLASSES.length} San Francisco Rec & Parks classes and drop-in programs — fitness, dance, swim lessons, arts, sports and more — with prices, ages, and open spots, updated every 6 hours.`,
  h1: 'Rec center classes in San Francisco',
  intro: `${CLASSES.length} classes and drop-in programs across SF Rec &amp; Parks facilities, with live availability, prices, and age ranges. Browse the full searchable catalog in the app; here's what's on offer by category.`,
  cta: { href: '/?tab=classes', label: 'Browse all classes' },
  body: CLASS_CATEGORIES.filter((cat) => byCat.get(cat.id)?.length)
    .map((cat) => {
      const list = byCat.get(cat.id);
      const names = [...new Set(list.map((c) => c.name))].slice(0, 8);
      return `<h2>${esc(cat.emoji)} ${esc(cat.label)} (${list.length})</h2><p class="meta">${names.map(esc).join(' · ')}${list.length > names.length ? ' · …' : ''}</p>`;
    })
    .join('\n'),
});

// Footer nav references every page, so define the list before rendering any.
NAV_PAGES.push(...pages.map((p) => ({ path: p.path, short: p.short })));
for (const p of pages) writePage(p);

// --- patch dist/index.html (the SPA shell) -------------------------------------

const HOME_TITLE = 'RECreate — SF Basketball, Pickleball & Tennis Courts, Pools & Rec Classes';
const HOME_DESC =
  'Free live map of every public place to play in San Francisco: basketball, pickleball, tennis, volleyball, soccer and more, plus pool schedules and rec classes. See what’s open now, check in, and find your game.';

let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const headTags = `
<title>${esc(HOME_TITLE)}</title>
<meta name="description" content="${esc(HOME_DESC)}">
<link rel="canonical" href="${SITE}/">
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

console.log(`✓ index.html <head> patched`);
console.log(`✓ ${pages.length} landing pages: ${pages.map((p) => p.path).join(' ')}`);
console.log(`✓ sitemap.xml (${urls.length} urls) + robots.txt + og.png`);
