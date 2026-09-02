// CI sanity check (npm run check) — not a test suite. A handful of cheap gates
// that catch the realistic failure modes of this repo: a bad merge that breaks a
// file's syntax, a language drifting out of key parity in lib/i18n.js, and a
// scraper/refresh committing gutted generated data. Runs in a few seconds;
// wired into .github/workflows/ci.yml on every push.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
let failed = false;
const fail = (msg) => {
  failed = true;
  console.error('✗ ' + msg);
};
const ok = (msg) => console.log('✓ ' + msg);
// Non-fatal: something is drifting but the tree is still shippable, and failing
// here would block unrelated work on a problem no PR introduced.
const warn = (msg) => console.warn('⚠ ' + msg);

// --- 1. Every app .js file parses (esbuild, jsx loader) ---------------------

const collect = (dir) =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(dir, f));

const files = [
  'App.js',
  'index.js',
  'metro.config.js',
  ...collect('components'),
  ...collect('lib'),
  ...collect('data'),
  ...collect('scripts'),
  // collect() is not recursive — list the per-city subdirectories explicitly.
  ...collect('data/cities'),
  ...collect('data/cities/nyc'),
  ...collect('scripts/lib'),
  ...collect('scripts/cities'),
];

try {
  esbuild.buildSync({
    entryPoints: files.map((f) => path.join(ROOT, f)),
    loader: { '.js': 'jsx' },
    write: false,
    outdir: 'unused', // required by the API even with write: false
    logLevel: 'silent',
  });
  ok(`syntax: ${files.length} files parse`);
} catch (e) {
  for (const err of e.errors ?? [{ text: e.message }]) {
    const loc = err.location ? `${err.location.file}:${err.location.line}` : '';
    fail(`syntax: ${loc} ${err.text}`);
  }
}

// --- 2. i18n: en/zh/es key parity in lib/i18n.js ----------------------------
// The STRINGS dict is one object literal per language; extract each language's
// top-level keys by brace-matching (the file is JSX, so we can't require it).

const i18nSrc = fs.readFileSync(path.join(ROOT, 'lib/i18n.js'), 'utf8');
const langKeys = {};
for (const lang of ['en', 'zh', 'es']) {
  const start = i18nSrc.indexOf(`  ${lang}: {`);
  if (start < 0) {
    fail(`i18n: no "${lang}" block found`);
    continue;
  }
  let depth = 0;
  let i = i18nSrc.indexOf('{', start);
  const open = i;
  for (; i < i18nSrc.length; i++) {
    if (i18nSrc[i] === '{') depth++;
    else if (i18nSrc[i] === '}' && --depth === 0) break;
  }
  const body = i18nSrc.slice(open, i + 1);
  langKeys[lang] = new Set([...body.matchAll(/^\s{4}'?([\w.\-]+)'?:/gm)].map((m) => m[1]));
}
if (langKeys.en && langKeys.zh && langKeys.es) {
  let parity = true;
  for (const [a, b] of [
    ['en', 'zh'],
    ['en', 'es'],
    ['zh', 'en'],
    ['es', 'en'],
  ]) {
    const missing = [...langKeys[a]].filter((k) => !langKeys[b].has(k));
    if (missing.length) {
      parity = false;
      fail(`i18n: in ${a} but not ${b}: ${missing.join(', ')}`);
    }
  }
  if (parity) ok(`i18n: en/zh/es at full parity (${langKeys.en.size} keys each)`);
}

// --- 3. Enabling the assistant means disclosing it in the privacy policy -----
// Turning the assistant on sends two things off the device that otherwise never
// leave it: the user's typed question, and their coordinates. They are covered
// very differently, and conflating them produces the wrong gate.
//
// **Questions** go to the model provider, a third party that retains what it is
// sent. That is disclosable regardless of how the service behaves, so it is what
// this check enforces.
//
// **Coordinates** are used to compute a distance and dropped — never stored,
// logged, or forwarded (the model is sent `miles_from_user`, never a latitude).
// Apple's definition of collecting excludes data held no longer "than what is
// necessary to service the transmitted request in real time", so the label's
// "Location: Not Collected" survives. That exemption is a property of the
// *service*, not of this build config, so it is enforced where it can actually
// be observed: `chatbot/tests/test_agent.py` fails if coordinates ever reach the
// model, a log line, or the response. Do not re-add a Location declaration here
// without first breaking that invariant on purpose.
//
// Keyed off eas.json rather than process.env: a developer running the service
// locally has the var set all day, and a check that failed for them gets deleted.

{
  const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const profiles = Object.entries(easJson.build || {}).filter(
    ([, profile]) => profile?.env?.EXPO_PUBLIC_ASSISTANT_URL,
  );
  const policy = fs.readFileSync(path.join(ROOT, 'public/privacy.html'), 'utf8');
  const disclosed = /assistant/i.test(policy);

  if (profiles.length && !disclosed) {
    fail(
      `privacy: eas.json profile(s) ${profiles.map(([n]) => n).join(', ')} enable the ` +
        'assistant, which sends users’ questions to a model provider, but ' +
        'public/privacy.html never mentions it. See docs/privacy-nutrition-label.md.',
    );
  } else if (profiles.length) {
    ok(`privacy: assistant enabled in ${profiles.length} profile(s), disclosed in the policy`);
  } else {
    ok('privacy: assistant not enabled in any build profile');
  }
}

// --- 4. The basemap attribution stays visible -------------------------------
// CARTO's free basemap key (EXPO_PUBLIC_CARTO_KEY) is granted in exchange for
// exactly one thing: "CARTO and OpenStreetMap attribution must stay on your
// maps." This gate is here because that is a licence condition rather than a
// runtime bug, so nothing else in the repo notices when it breaks — the map
// still works, the tiles still arrive unwatermarked, and the first real signal
// would be CARTO revoking the key.
//
// The failure mode is not hypothetical: both map files spent months passing an
// `attribution` string while setting `attributionControl: false`, i.e.
// rendering it nowhere, and it is exactly what a well-meaning "clean up the map
// chrome" change lands back in. Hiding it via CSS is the same violation by
// another route, so ATTRIB_CSS is checked too.
//
// Text inspection, not rendering: one map is Leaflet in a WebView and the other
// Leaflet in a DOM, and standing either up in CI to count pixels costs far more
// than this is worth. It therefore only catches the obvious ways to remove the
// credit, which are the ways it has actually been removed.

{
  const basemap = fs.readFileSync(path.join(ROOT, 'lib/basemap.js'), 'utf8');
  let bad = false;

  // Scoped to the assignment so a passing mention in the file's comments (there
  // are several) can't satisfy the check on its own.
  // Terminate on a semicolon that ends a line: the attribution text contains
  // "&copy;", whose own semicolon truncates a plain non-greedy /;/ match.
  const attrib = (basemap.match(/export const TILE_ATTRIB\s*=([\s\S]*?);[ \t]*\n/) || [])[1] || '';
  const missing = ['OpenStreetMap', 'CARTO'].filter((c) => !attrib.includes(c));
  if (missing.length) {
    bad = true;
    fail(
      `basemap: lib/basemap.js TILE_ATTRIB no longer credits ${missing.join(' + ')}. ` +
        'Both are required by the CARTO free-tier terms.',
    );
  }

  // Matched to the closing backtick, not a semicolon — every CSS declaration
  // inside the template literal ends in one.
  const css = (basemap.match(/export const ATTRIB_CSS\s*=\s*`([\s\S]*?)`/) || [])[1] || '';
  const hidden = /display:\s*none|visibility:\s*hidden|opacity:\s*0(?![.\d])/.exec(css);
  if (hidden) {
    bad = true;
    fail(
      `basemap: ATTRIB_CSS hides the attribution ("${hidden[0]}"). Styling it small ` +
        'is fine; making it invisible is the same licence violation as removing it.',
    );
  }

  for (const rel of ['components/CourtMap.js', 'components/CourtMap.web.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/attributionControl:\s*false/.test(src)) {
      bad = true;
      fail(`basemap: ${rel} sets attributionControl: false — the credit renders nowhere.`);
    } else if (!/attributionControl:\s*true/.test(src)) {
      bad = true;
      fail(`basemap: ${rel} no longer turns the attribution control on.`);
    }
    // Anchored to the tileLayer option, not a bare mention: the import at the
    // top of the file keeps satisfying a substring test long after the call
    // site has been changed to a hardcoded string. Matches both shapes — the
    // web map's `attribution: TILE_ATTRIB` and the native map's
    // `attribution: ${JSON.stringify(TILE_ATTRIB)}` inside its WebView HTML.
    if (!/attribution:\s*(\$\{[^}]*)?TILE_ATTRIB/.test(src)) {
      bad = true;
      fail(
        `basemap: ${rel} does not pass TILE_ATTRIB to its tile layer — a hardcoded ` +
          'attribution here is how the two maps drift apart.',
      );
    }
  }

  if (!bad) ok('basemap: OpenStreetMap + CARTO attribution rendered by both maps');
}

// --- 5. Generated data modules load and are non-trivially populated ---------
// Floors are ~half of current size — loose enough for seasonal shrink, tight
// enough to catch a scrape that published near-empty data. (The build scripts
// have their own live→cache→curated gates; this catches what slips through,
// e.g. a bad merge or a hand edit of a generated file.)

const DATA_FLOORS = [
  ['data/courts.js', 'COURTS', 10],
  ['data/outdoor-courts.js', 'OUTDOOR_COURTS', 50],
  ['data/cities/nyc/outdoor-courts.js', 'OUTDOOR_COURTS', 350],
  ['data/cities/nyc/indoor-courts.js', 'NYC_INDOOR_COURTS', 12],
  // NYC classes are a rolling ~14-day events window — floor loose for seasonal shrink.
  ['data/cities/nyc/classes.js', 'NYC_CLASSES', 100],
  ['data/classes.js', 'CLASSES', 100],
  // SF volunteer workparties. Loose floor: the calendar genuinely thins out, and
  // its seasonal non-gardening programs only exist in Oct–Dec.
  ['data/volunteer.js', 'VOLUNTEER', 8],
  ['data/pools.js', 'POOLS', 5],
  ['data/manual-courts.js', 'MANUAL_COURTS', 1],
  ['data/sanbruno-court.js', 'SANBRUNO_COURTS', 1],
  ['data/reservations.js', 'RESERVATIONS', 1],
  ['data/court-directory.js', 'DIRECTORY', 1],
  // NYC permits + tennis reservations. Loose: how many parks carry a permit
  // swings hard with the season (leagues in summer, near-empty in February).
  ['data/cities/nyc/reservations.js', 'NYC_RESERVATIONS', 40],
  // Tennis-only enrichment from NYC Parks' own directory (78 facilities, of
  // which the outdoor ones that match a pin land here).
  ['data/cities/nyc/directory.js', 'NYC_DIRECTORY', 25],
  // 79 outdoor + 13 indoor. Floor is a gutted-scrape guard, not a seasonal one:
  // out of season the outdoor pools still ship, just with no sessions.
  ['data/cities/nyc/pools.js', 'NYC_POOLS', 50],
];

const loaded = {}; // file -> module exports, reused by the price gate below

for (const [file, name, floor] of DATA_FLOORS) {
  try {
    const bundled = esbuild.buildSync({
      entryPoints: [path.join(ROOT, file)],
      bundle: true,
      format: 'cjs',
      write: false,
      logLevel: 'silent',
    }).outputFiles[0].text;
    const mod = { exports: {} };
    new Function('module', 'exports', bundled)(mod, mod.exports);
    loaded[file] = mod.exports;
    const v = mod.exports[name];
    const size = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : -1;
    if (size < floor) fail(`data: ${file} ${name} has ${size} entries (floor ${floor})`);
    else ok(`data: ${file} ${name} = ${size} entries`);
  } catch (e) {
    fail(`data: ${file} failed to load — ${e.message}`);
  }
}

// The hostable occupancy payload the app refetches at runtime
// (EXPO_PUBLIC_RESERVATIONS_URL) must stay in lockstep with the bundled module.
// They are written by the same build, so a mismatch means one of them didn't get
// committed — and the failure is invisible at runtime: the app would keep
// serving whichever snapshot it has until its absolute-dated slots expire.
{
  const file = 'data/reservations.json';
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const mod = loaded['data/reservations.js'] || {};
    const jsIds = Object.keys(mod.RESERVATIONS || {});
    const jsonIds = Object.keys(payload.reservations || {});
    if (!jsonIds.length) fail(`data: ${file} has no reservations`);
    else if (payload.generatedAt !== mod.GENERATED_AT)
      fail(`data: ${file} generatedAt ${payload.generatedAt} != module ${mod.GENERATED_AT} — rebuild/commit both`);
    else if (jsonIds.length !== jsIds.length)
      fail(`data: ${file} has ${jsonIds.length} courts, module has ${jsIds.length} — rebuild/commit both`);
    else ok(`data: ${file} matches data/reservations.js (${jsonIds.length} courts)`);
    // Occupancy expires ~7 days after the build that produced it (absolute-dated
    // slots), and the cron refreshes every 3h — so a snapshot more than a day old
    // means the refresh has stopped, roughly a week before anyone would notice
    // the app go quiet. A warning, not a failure: the tree is still shippable and
    // no PR caused it.
    const ageH = (Date.now() - Date.parse(payload.generatedAt)) / 3.6e6;
    if (Number.isFinite(ageH) && ageH > 24)
      warn(`data: ${file} is ${Math.round(ageH)}h old — is refresh-reservations.yml still running?`);
  } catch (e) {
    fail(`data: ${file} missing or unreadable — ${e.message}`);
  }
}

// --- 6. Class fees actually got resolved ------------------------------------
// Neither catalog gets a price from its listing. Both seed a placeholder label
// and fill it from a second request — ActiveNet's estimateprice endpoint, and
// each NYC event page's <h3>Cost</h3>. Those passes fail SILENTLY: the
// placeholder simply survives into the app, where "See site" on a card reads
// like an upstream fact rather than a scrape that gave up. That is exactly how
// one unread shape of the ActiveNet response (a flat `simple_fee`, whose amount
// lives outside the tier array) left 112 of 915 SF classes unpriced, and how a
// dropped page fetch priced 12 free NYC programs as unknown.
//
// A ceiling, not a floor: a few genuinely unpublished fees are normal, and a
// descriptive cost scraped from the source ("Pay what you can.") is a real
// value, not a placeholder — so this matches the placeholder labels themselves.

const PLACEHOLDER_COST = /^(see site|see event page|—|-)?$/i;
const MAX_UNPRICED_PCT = 5;

for (const [file, name] of [
  ['data/classes.js', 'CLASSES'],
  ['data/cities/nyc/classes.js', 'NYC_CLASSES'],
]) {
  const list = loaded[file]?.[name];
  if (!Array.isArray(list) || !list.length) continue; // already failed the floor gate
  const unpriced = list.filter((c) => PLACEHOLDER_COST.test(String(c.cost ?? '').trim()));
  const pct = (unpriced.length / list.length) * 100;
  const detail = `${unpriced.length}/${list.length} (${pct.toFixed(1)}%)`;
  if (pct > MAX_UNPRICED_PCT) {
    fail(
      `price: ${file} has ${detail} classes still on a placeholder fee — the fee ` +
        `resolution pass is failing (ceiling ${MAX_UNPRICED_PCT}%). e.g. ` +
        unpriced.slice(0, 3).map((c) => `${c.id} "${c.cost}"`).join(', '),
    );
  } else {
    ok(`price: ${file} ${detail} unpriced (ceiling ${MAX_UNPRICED_PCT}%)`);
  }
}

// --- 7. The generated SEO pages hold together -------------------------------
//
// ~850 landing pages are the site's acquisition channel, and every invariant
// they depend on — one clear intent per page, a canonical that resolves, no
// orphans, no thin stubs, breadcrumbs whose crumbs exist — fails silently:
// nothing notices when one breaks, because the pages keep building and keep
// serving while the ranking quietly goes.
//
// SEO_AUDIT=1 builds and renders the whole page set in memory from the same
// bundled data/ modules the real build uses, asserts over the rendered HTML,
// and writes nothing — so this needs no `expo export` and costs a few seconds.
// scripts/postbuild-web.js runs the identical assertions on the real build.
const { spawnSync } = require('child_process');

const seo = spawnSync(process.execPath, [path.join(ROOT, 'scripts/postbuild-web.js')], {
  env: { ...process.env, SEO_AUDIT: '1' },
  encoding: 'utf8',
});
for (const line of String(seo.stderr || '').split('\n')) {
  if (line.startsWith('⚠')) warn(line.slice(2));
  else if (line.startsWith('✗')) fail(line.slice(2));
  else if (line.trim()) console.error(line);
}
if (seo.status === 0) {
  const summary = String(seo.stdout || '').split('\n').filter((l) => l.startsWith('✓ seo:')).pop();
  ok(summary ? summary.slice(2) : 'seo: pages pass');
} else if (!seo.stderr) {
  // A crash with no findings is a broken generator, not a clean page set.
  fail(`seo: the page audit exited ${seo.status ?? 'on a signal'} without reporting findings`);
}

if (failed) {
  console.error('\ncheck failed');
  process.exit(1);
}
console.log('\nall checks passed');
