#!/usr/bin/env node
/*
 * Build data/cities/nyc/directory.js — the qualitative facility facts NYC's GIS
 * data doesn't carry. Run with:  npm run build:nyc-directory
 *
 * Source: NYC Parks' own `bigapps` directories. These are listed on NYC Open
 * Data as link-type datasets, so the Socrata /resource/<id>.json API answers
 * "no row or column access to non-tabular tables" — you have to fetch the
 * nycgovparks.org URL directly, which is why they're easy to miss:
 *   DPR_Tennis_001          78 tennis facilities (surface, indoor/outdoor,
 *                           phone, court count, a prose Info blurb)
 *   DPR_Basketball_001     577 · DPR_Handball_001 547  (counts only)
 *   DPR_RecreationCenter_001  54 rec centers with per-weekday Building_Hours
 *
 * Prop_ID in these feeds IS the Socrata `gispropnum` our outdoor pins carry as
 * `key`, so the join is exact — 90-97% of rows land on a pin, the rest being
 * indoor-only sites we have no outdoor pin for.
 *
 * WHAT THIS SHIPS, and what it deliberately doesn't:
 *
 * Counts are NOT shipped. Socrata (one row per physical court, GIS-derived)
 * and this directory (hand-maintained) disagree on ~20% of parks — tennis 51/64
 * agree, handball 366/452, basketball 86/122 — and neither is obviously right.
 * Publishing a second number would just make the card contradict itself, so
 * Socrata stays canonical and the disagreements are LOGGED for review instead.
 *
 * What is shipped is what Socrata genuinely lacks. For TENNIS:
 *   surf   the real playing surface (Hard / Clay / Fast Dry / Har-Tru), where
 *          Socrata only says "Asphalt". Tennis players care a lot about this.
 *   phone  the facility's number (62 of 78 have one)
 *   info   NYC Parks' own prose about the site — bubble seasons, lessons, which
 *          courts a permit covers (33 of 78)
 *
 * Only Indoor_Outdoor='Outdoor' rows merge onto a pin. Several parks (Crotona,
 * Randall's Island) have an indoor bubble AND outdoor courts under one Prop_ID;
 * attaching the bubble's clay surface to the outdoor park pin would be wrong.
 *
 * For PICKLEBALL, two more passes (see each below): NYC Parks' own
 * /facilities/pickleball page, which is the one place an official source may
 * ADD a sport to a pin because GIS misses two thirds of the city's pickleball;
 * and nycpickleball.com, community colour that may never add anything.
 *
 * Resilience mirrors the other builds: live -> last-good cache -> abort keeping
 * the existing data file.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { loadCache, saveCache } = require('./lib/courts-common');

const BASE = 'https://www.nycgovparks.org/bigapps';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

const OUT_DIR = path.join(__dirname, '..', 'data', 'cities', 'nyc');
const OUT_FILE = path.join(OUT_DIR, 'directory.js');
const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-directory-cache.json');
const COURTS_FILE = path.join(OUT_DIR, 'outdoor-courts.js');
const INDOOR_FILE = path.join(OUT_DIR, 'indoor-courts.js');

// Abort (keep last-good data) below this many enriched courts.
const MIN_ENTRIES_OK = 30;

async function getJson(file) {
  const res = await fetchT(`${BASE}/${file}.json`, { headers: HEADERS }, 30000);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
  return res.json();
}

// nycgovparks answers a heavy caller with an empty 200 rather than an error, so
// a short body is a challenge page, not content. Back off and retry.
const HTML_BACKOFF_MS = [0, 5000, 20000];
async function getText(url) {
  let last;
  for (let i = 0; i < HTML_BACKOFF_MS.length; i++) {
    if (i) await new Promise((r) => setTimeout(r, HTML_BACKOFF_MS[i]));
    try {
      const res = await fetchT(url, { headers: HEADERS }, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const html = await res.text();
      if (html.length > 5000) return html;
      last = new Error(`short response (${html.length}b) — WAF challenge?`);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// The feeds carry HTML entities and inline markup in their prose fields.
const ENTITIES = { amp: '&', ndash: '–', mdash: '—', nbsp: ' ', quot: '"', apos: "'", lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ') // links to the facility's own site — the text still reads
    .replace(/&(\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

// Park key -> our court id, off the generated outdoor pins (same anchor the
// reservation build uses).
function loadPins() {
  const src = fs.readFileSync(COURTS_FILE, 'utf8');
  const byKey = new Map();
  const byName = new Map(); // "normalized name|borough" -> pin, for page sources with no key
  for (const m of src.matchAll(
    /id: "([^"]+)",\s*\n\s*key: "([^"]+)",\s*\n\s*name: "((?:[^"\\]|\\.)*)",\s*\n\s*address: "(?:[^"\\]|\\.)*",\s*\n\s*neighborhood: "([^"]*)"/g
  )) {
    const pin = { id: m[1], key: m[2], name: m[3].replace(/\\"/g, '"') };
    byKey.set(m[2], pin);
    byName.set(`${normPark(pin.name)}|${m[4]}`, pin);
  }
  return { byKey, byName };
}

// Per-sport court counts already published in the generated pins, for the
// cross-check below.
function loadFacts() {
  const src = fs.readFileSync(COURTS_FILE, 'utf8');
  const byKey = new Map();
  for (const m of src.matchAll(/key: "([^"]+)",[\s\S]{0,600}?facts: (\{.*?\}),\n/g)) {
    try {
      byKey.set(m[1], JSON.parse(m[2]));
    } catch {
      /* a record whose facts span oddly — skip, this is only a cross-check */
    }
  }
  return byKey;
}

// Socrata vs. this directory, summed per park. Logged, never shipped: two
// numbers on one card would just contradict each other.
function crossCheckCounts(rows, field, sport, facts, byKey) {
  const summed = new Map();
  for (const r of rows) {
    const n = parseInt(r[field], 10);
    if (Number.isFinite(n)) summed.set(r.Prop_ID, (summed.get(r.Prop_ID) || 0) + n);
  }
  let agree = 0;
  const off = [];
  for (const [key, n] of summed) {
    const f = facts.get(key)?.[sport];
    if (!f) continue;
    if (n === f.n) agree++;
    else off.push(`${byKey.get(key)?.name || key}: directory ${n} vs GIS ${f.n}`);
  }
  const total = agree + off.length;
  console.log(
    `  ${sport}: court counts agree on ${agree}/${total} parks` +
      (off.length ? ` — ${off.length} differ (GIS stays canonical)` : '')
  );
  for (const line of off.slice(0, 5)) console.log(`      ${line}`);
  if (off.length > 5) console.log(`      … and ${off.length - 5} more`);
  return { agree, differ: off.length };
}

// Rec-center building hours, cross-checked against our scraped indoor centers.
// NOT merged: the HTML scrape carries per-program open-gym blocks this feed has
// no notion of, and a building-hours span would quietly overwrite them.
function crossCheckRecCenters(rows) {
  let withHours = 0;
  for (const r of rows) {
    const h = r.Building_Hours || {};
    if (Object.values(h).some((d) => d && d.startTime)) withHours++;
  }
  let scraped = 0;
  try {
    scraped = (fs.readFileSync(INDOOR_FILE, 'utf8').match(/\n {2}\{\n/g) || []).length;
  } catch {
    /* indoor file absent — fine, this line is informational */
  }
  console.log(
    `  rec centers: ${rows.length} in the directory, ${withHours} with building hours; ` +
      `we scrape ${scraped} with open-gym programs (not merged — see the header)`
  );
}

/* Pickleball is the one sport where the GIS dataset is badly incomplete, and
 * NYC Parks' own /facilities/pickleball page is the fix. GIS flags pickleball at
 * 9 of the 24 locations NYC Parks lists (72 courts) — mostly because pickleball
 * is lined onto existing tennis and handball slabs, which the GIS layer records
 * as tennis or handball and never re-flags. A player looking for pickleball was
 * seeing about a third of the city's courts.
 *
 * This is an OFFICIAL NYC Parks page, not a community one, so unlike the
 * enrichment below it may add a sport to a pin: entries carry `add: true`, and
 * data/cities/index.js unions those into the pin's sports so the courts get
 * hours, markers, filters and permit occupancy like any other.
 */

// Park names differ in small ways between sources ("Rockaway Beach and
// Boardwalk" vs "Rockaway Beach Boardwalk"), so drop the joining words before
// comparing. Borough is part of the key — NYC repeats playground names.
const normPark = (s) =>
  String(s || '').toLowerCase().replace(/\b(and|the|at|of)\b/g, '').replace(/[^a-z0-9]+/g, '');

function parsePickleballPage(html) {
  const out = [];
  const parts = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/<h3>(Bronx|Brooklyn|Manhattan|Queens|Staten Island)<\/h3>/);
  for (let i = 1; i < parts.length; i += 2) {
    const boro = parts[i];
    for (const blk of parts[i + 1].split('<div style="margin-bottom: 15px;"><div>').slice(1)) {
      const nm = blk.match(/<a href='\/parks\/[^']+'>([^<]+)<\/a>/);
      if (!nm) continue;
      const courts = blk.match(/# of Courts<\/strong>:&nbsp;(\d+)/);
      out.push({
        name: clean(nm[1]),
        boro,
        courts: courts ? Number(courts[1]) : null,
        accessible: /Accessible<\/strong>:&nbsp;Yes/i.test(blk),
      });
    }
  }
  return out;
}

// Attach official pickleball counts, flagging `add` where GIS doesn't know the
// sport is played there. `facts` is the GIS per-sport map, used only to tell
// "already known" from "newly added" for the log.
function applyPickleball(out, rows, byKeyByName, facts) {
  let added = 0;
  let known = 0;
  const misses = [];
  for (const r of rows) {
    const pin = byKeyByName.get(`${normPark(r.name)}|${r.boro}`);
    if (!pin) {
      misses.push(`${r.name} (${r.boro}, ${r.courts} courts)`);
      continue;
    }
    const gisHas = !!facts.get(pin.key)?.pickleball;
    if (gisHas) known++;
    else added++;
    const e = (out[pin.id] ||= {});
    e.pickleball = {
      ...(e.pickleball || {}),
      ...(r.courts ? { n: r.courts } : {}),
      ...(r.accessible ? { accessible: true } : {}),
      // Only set when GIS doesn't already offer the sport here — this is what
      // lets the expansion add it to the pin.
      ...(gisHas ? {} : { add: true }),
    };
  }
  console.log(
    `  pickleball: ${rows.length} official locations — ${known} already in GIS, ${added} added, ${misses.length} unmatched`
  );
  // A park with no GIS athletic facility at all has no pin to attach to; say so
  // rather than silently dropping courts that officially exist.
  for (const m of misses) console.log(`      no pin: ${m}`);
  return { added, known, misses: misses.length };
}

/* --- Community layer: nycpickleball.com ------------------------------------
 * The NYC counterpart to pickleballsf.com, and the same trust tier: ADVISORY
 * COLOR, NEVER SCHEDULE TRUTH. It may not add a sport to a pin and its times
 * never reach `dropins` — organized open play is players agreeing to show up,
 * not a posted schedule, and rendering it as hours would put someone at an
 * empty court believing the city said it was open.
 *
 * What it uniquely knows, and no official source publishes:
 *   nets      whether nets are provided or you must Bring Your Own. Decisive:
 *             turning up to a BYON court without a net means you don't play.
 *   openPlay  when players actually gather, in their words, shown as
 *             community-reported rather than as hours.
 *   community the Slack channel or TeamReach code that organizes the venue —
 *             how you actually find a game there.
 *
 * The guide also lists venues NYC Parks doesn't (Roosevelt Island, Pier 2,
 * school yards). Those are logged, not published: a community report is enough
 * to colour a court we already know about, not enough to assert one exists.
 */
const PB_GUIDE_URL = 'https://www.nycpickleball.com/the-guide';

// Venue names carry a neighborhood and a facility suffix the park name doesn't
// ("Leif Ericson Tennis Courts, Sunset Park"), so compare on the park part.
const normVenue = (s) =>
  normPark(
    String(s || '')
      .split(',')[0]
      .replace(/\b(pickleball|tennis|handball)\b/gi, '')
      .replace(/\bcourts?\b/gi, '')
  );

function parseGuide(html) {
  const out = [];
  // Squarespace: venue name is a `sqsrte-large` paragraph, and the facts follow
  // as <p><strong>Courts:</strong> …</p> until the next venue.
  const blocks = html.split(/<p[^>]*class="[^"]*sqsrte-large[^"]*"[^>]*>/);
  for (const blk of blocks.slice(1)) {
    const name = clean(blk.slice(0, blk.indexOf('</p>')));
    if (!name || name.length > 90) continue;
    const body = blk.slice(blk.indexOf('</p>'));
    const field = (label) => {
      const m = new RegExp(`<strong>\\s*${label}[^<]*</strong>([\\s\\S]*?)</p>`, 'i').exec(body);
      return m ? clean(m[1]) : '';
    };
    const courts = field('Courts');
    if (!courts) continue; // a heading or blurb, not a venue entry
    const openPlay = field('Open\\s*Play');
    // Prefer the channel from the anchor that actually points at their Slack.
    // A bare "#..." scan picks up Squarespace's own block ids — that shipped
    // "#block-d512c2966ec5101fb277 on Slack" onto a court card once.
    // Anchor-based first (that's the real Slack link); a bare "#..." scan over
    // RAW html picks up Squarespace's own block ids, which once shipped
    // "#block-d512c2966ec5101fb277 on Slack" onto a court card.
    const text = clean(body);
    const slack =
      (body.match(/<a[^>]+href="[^"]*slack[^"]*"[^>]*>\s*(#[^<\s]+)/i) || [])[1] ||
      (text.match(/#(?!block-)[a-z][a-z0-9_-]{3,}/i) || [])[0] ||
      '';
    // "TeamReach code: X", "Team Reach code : X", "TeamReach group code X".
    // Matched on the CLEANED text: the markup often reads
    // "<strong>TeamReach code</strong>: MPPBA", so on raw html the tag sits
    // between "code" and its colon and the pattern silently misses.
    const teamReach = (text.match(/team\s*reach\s*(?:group\s*)?code\s*:?\s*([A-Za-z0-9]+)/i) || [])[1] || '';
    out.push({ name, courts, openPlay, slack, teamReach });
  }
  return out;
}

// "…portable nets needed (BYON)" vs "…dedicated courts with nets".
function netsFrom(text) {
  if (/\bBYON\b|bring your own|portable nets? needed/i.test(text)) return 'byon';
  if (/with (permanent |dedicated )?nets|nets provided|dedicated nets/i.test(text)) return 'provided';
  return null;
}

async function pickleballCommunityEnrich(out, byName, facts) {
  let html;
  try {
    html = await getText(PB_GUIDE_URL);
  } catch (e) {
    console.log(`  ⚠ nycpickleball.com failed (${e.message}) — no community colour this run`);
    return;
  }
  const venues = parseGuide(html);
  let matched = 0;
  const unlisted = [];
  for (const v of venues) {
    const key = normVenue(v.name);
    // Borough isn't reliably on each entry, so match on the park name across
    // boroughs and take it only when exactly one pin answers to it.
    const hits = [...byName.entries()].filter(([k]) => {
      const parkName = k.split('|')[0];
      return parkName === key || (key.length > 6 && parkName.includes(key));
    });
    const pin = hits.length === 1 ? hits[0][1] : null;
    // Attach only where pickleball is already established — by the official
    // page (a directory entry) or by GIS. Community reports colour a court we
    // know about; they never assert one into existence.
    const known = pin && (out[pin.id]?.pickleball || facts.get(pin.key)?.pickleball);
    if (!known) {
      unlisted.push(`${v.name}${hits.length > 1 ? ' (ambiguous name)' : ''}`);
      continue;
    }
    const entry = ((out[pin.id] ||= {}).pickleball ||= {});
    matched++;
    const nets = netsFrom(v.courts);
    if (nets) entry.nets = nets;
    // Community-reported gathering times. Text only — deliberately not parsed
    // into blocks, so it can never be mistaken for a posted schedule. The
    // group code is stripped here because it renders on its own line below;
    // left in, the card read "…Team Reach code: UESPickleball" immediately
    // above "Games are organized here via TeamReach UESPickleball".
    const play = String(v.openPlay || '')
      .replace(/\s*(?:join\s*)?#[a-z0-9_-]+[^.]*\.?\s*$/i, '')
      .replace(/\s*team\s*reach\s*(?:group\s*)?code\s*:?\s*[A-Za-z0-9]+\.?\s*$/i, '')
      .trim();
    // Some entries are nothing BUT the group code ("Organize play sessions in
    // the TeamReach group code NYCPMJJW") — stripping it leaves a dangling
    // fragment, so drop the line rather than print half a sentence. The code
    // itself still shows on its own line.
    // The dangling-word test does the real work; the length floor only catches
    // leftovers like "Join". "Daily, starts at 9 AM" is short but complete.
    const dangling = /\b(in|the|via|at|on|with|through|using|code)\s*$/i.test(play) || play.length < 12;
    if (play && !dangling) entry.openPlay = play.slice(0, 300);
    const contact = [v.teamReach ? `TeamReach ${v.teamReach}` : '', v.slack ? `${v.slack} on Slack` : '']
      .filter(Boolean)
      .join(' · ');
    if (contact) entry.community = contact;
  }
  console.log(`  community (nycpickleball.com): ${venues.length} venues parsed, ${matched} matched to a pin`);
  if (unlisted.length) {
    console.log(`      ${unlisted.length} not published (community-only or ambiguous — advisory sources don't create courts):`);
    for (const u of unlisted.slice(0, 8)) console.log(`        · ${u}`);
    if (unlisted.length > 8) console.log(`        … and ${unlisted.length - 8} more`);
  }
}

function buildTennis(rows, byKey) {
  const out = {};
  let skippedIndoor = 0;
  let unmatched = 0;
  for (const r of rows) {
    // Indoor bubbles share a Prop_ID with the outdoor courts at the same park;
    // their surface and phone describe a different facility.
    if (String(r.Indoor_Outdoor || '').toLowerCase() !== 'outdoor') {
      skippedIndoor++;
      continue;
    }
    const pin = byKey.get(r.Prop_ID);
    if (!pin) {
      unmatched++;
      continue;
    }
    const e = (out[pin.id] ||= { tennis: {} }).tennis;
    const surf = clean(r.Tennis_Type);
    if (surf) e.surf = [...new Set([...(e.surf || []), surf])];
    const phone = clean(r.Phone);
    if (phone && !e.phone) e.phone = phone;
    const info = clean(r.Info);
    // A park with two outdoor rows (Riverside's clay and hard courts) gets both
    // blurbs; keep the longer one rather than concatenating two overlapping
    // descriptions of the same park.
    if (info && info.length > (e.info?.length || 0)) e.info = info;
  }
  for (const id of Object.keys(out)) {
    if (!Object.keys(out[id].tennis).length) delete out[id];
  }
  console.log(
    `  tennis: ${Object.keys(out).length} pins enriched ` +
      `(${skippedIndoor} indoor rows skipped, ${unmatched} with no outdoor pin)`
  );
  return out;
}

async function main() {
  console.log('Building NYC court directory from NYC Parks bigapps feeds…');
  const { byKey, byName } = loadPins();
  if (!byKey.size) throw new Error(`no park keys in ${COURTS_FILE} — run "npm run build:nyc" first`);
  console.log(`  ${byKey.size} park pins with a join key`);

  let directory;
  let source;
  try {
    const [tennis, basketball, handball, recCenters] = await Promise.all([
      getJson('DPR_Tennis_001'),
      getJson('DPR_Basketball_001'),
      getJson('DPR_Handball_001'),
      getJson('DPR_RecreationCenter_001'),
    ]);

    directory = buildTennis(tennis, byKey);

    const facts = loadFacts();

    // Official pickleball locations — the one place the GIS layer is badly
    // incomplete, and the only pass here allowed to ADD a sport to a pin.
    try {
      const pbRows = parsePickleballPage(await getText(`${BASE.replace('/bigapps', '')}/facilities/pickleball`));
      if (pbRows.length < 10) throw new Error(`only ${pbRows.length} locations parsed — page shape may have changed`);
      applyPickleball(directory, pbRows, byName, facts);
    } catch (e) {
      console.log(`  ⚠ pickleball page failed (${e.message}) — GIS pickleball coverage only this run`);
    }

    // Community colour LAST, so it can only ever decorate what the official
    // sources established.
    await pickleballCommunityEnrich(directory, byName, facts);

    crossCheckCounts(tennis, 'Courts', 'tennis', facts, byKey);
    crossCheckCounts(basketball, 'Num_of_Courts', 'basketball', facts, byKey);
    crossCheckCounts(handball, 'Num_of_Courts', 'handball', facts, byKey);
    crossCheckRecCenters(recCenters);

    if (Object.keys(directory).length < MIN_ENTRIES_OK) {
      throw new Error(
        `only ${Object.keys(directory).length} enriched pins (min ${MIN_ENTRIES_OK}) — feed shape may have changed`
      );
    }
    source = 'live';
    saveCache(CACHE_FILE, { directory, fetchedAt: new Date().toISOString() });
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !cache.directory) {
      throw new Error(`fetch failed (${e.message}) and no cache — ${OUT_FILE} left unchanged`);
    }
    directory = cache.directory;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, render(directory, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${Object.keys(directory).length} courts to data/cities/nyc/directory.js (${source})`);
}

function render(directory, generatedAt, source) {
  const body = Object.keys(directory)
    .sort()
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory[id])},`)
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-nyc-directory.js — do not edit by hand.
// Regenerate with: npm run build:nyc-directory
// Generated: ${generatedAt} (${source})
//
// Qualitative facility facts from NYC Parks' own directories, for the things
// the GIS dataset doesn't carry. Court id -> { sport: { surf, phone, info } }:
//   surf   real playing surface(s) — "Hard", "Clay", "Fast Dry", "Har-Tru".
//          Socrata only says "Asphalt" for the same courts.
//   phone  the facility's public number
//   info   NYC Parks' own prose: bubble seasons, lessons, which courts a
//          permit covers
//
// Court COUNTS are deliberately absent: this directory and the GIS dataset
// disagree on ~20% of parks and neither is clearly right, so the GIS count
// stays canonical and the build only logs the differences.
//
// Merged onto each pin's \`facts[sport]\` by data/cities/index.js — NOT onto
// \`directory\`, which is SF-shaped and whose presence hides the NYC facts row.

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const NYC_DIRECTORY = {
${body}
};

export default NYC_DIRECTORY;
`;
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
