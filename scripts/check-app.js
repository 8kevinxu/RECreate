// CI sanity check (npm run check) — not a test suite. Three cheap gates that
// catch the realistic failure modes of this repo: a bad merge that breaks a
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

// --- 4. Generated data modules load and are non-trivially populated ---------
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
  ['data/pools.js', 'POOLS', 5],
  ['data/manual-courts.js', 'MANUAL_COURTS', 1],
  ['data/sanbruno-court.js', 'SANBRUNO_COURTS', 1],
  ['data/reservations.js', 'RESERVATIONS', 1],
  ['data/court-directory.js', 'DIRECTORY', 1],
];

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
    const v = mod.exports[name];
    const size = Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : -1;
    if (size < floor) fail(`data: ${file} ${name} has ${size} entries (floor ${floor})`);
    else ok(`data: ${file} ${name} = ${size} entries`);
  } catch (e) {
    fail(`data: ${file} failed to load — ${e.message}`);
  }
}

if (failed) {
  console.error('\ncheck failed');
  process.exit(1);
}
console.log('\nall checks passed');
