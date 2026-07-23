#!/usr/bin/env node
/*
 * Build data/cities/nyc/classes.js — free NYC Parks programs & classes.
 * Run: npm run build:nyc-classes
 *
 * Source: the NYC Parks events RSS feed (nycgovparks.org/xml/events_300_rss.xml),
 * the machine-readable version of nycgovparks.org/events — a rolling ~14-day
 * window of all public programming (Shape Up NYC fitness classes, rec-center
 * programs, sport clinics, lap swim, arts, concerts…), with per-item times,
 * park names, categories, coordinates, and registration links. The stale
 * Socrata events dataset (fudw-fgrp, last updated 2021) is NOT used.
 *
 * A recurring program appears as one item per date; items are collapsed into
 * one card per (title, location, time) with a day-of-week `when` label, like
 * the SF ActiveNet drop-in series. Records match data/classes.js's shape so
 * ClassesScreen / ClassDetail / recommendations render them unchanged:
 * no-registration events reuse the SF `noOnlineReg` "free — just show up"
 * flow; events with a registration link get it as their `url`.
 *
 * SF-parity enrichment beyond the feed:
 *   • desc/title HTML is stripped to plain text (the feed embeds <p>/<strong>).
 *   • ages/minAge/maxAge parsed from the title+description ("ages 6 to 17",
 *     "8 and older", "under 5"), with Seniors/Best-for-Kids category fallbacks.
 *   • cost + registration status come from each event's nycgovparks.org page
 *     (<h3>Cost</h3> and "Registration is closed"): costs are cached by event
 *     URL (nyc-classes-cost-cache.json, pruned to the live window) so only new
 *     events cost a fetch; registration status is re-checked every run for
 *     registration events and maps "closed" onto spots:0 (the app's Full
 *     indicator). NYC publishes no capacity numbers, so open registration
 *     stays "availability unknown" rather than a claim.
 *   • titles are pre-translated zh/es via the shared helper (own cache,
 *     ANTHROPIC_API_KEY optional — degrades to English).
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (scripts/cities/nyc-classes-cache.json), with a gate that aborts (keeping
 * the existing data file) if too few items parse. The feed re-issues daily;
 * the classes cron (6h) keeps the rolling window fresh.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { slug, loadCache, saveCache } = require('./lib/courts-common');
const { applyTranslations } = require('./lib/translate-titles');

const FEED = 'https://www.nycgovparks.org/xml/events_300_rss.xml';
// nycgovparks.org 403s non-browser user agents.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-classes-cache.json');
const COST_CACHE_FILE = path.join(__dirname, 'cities', 'nyc-classes-cost-cache.json');
const I18N_CACHE_FILE = path.join(__dirname, 'cities', 'nyc-classes-i18n-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'cities', 'nyc', 'classes.js');

// Abort (keep last-good data) if fewer than this many feed items parse.
const MIN_ITEMS_OK = 100;
// Event-page enrichment budget per run (~500 distinct pages in a typical window;
// the cap is a runaway guard, not a target).
const MAX_PAGE_FETCHES = 700;
const PAGE_CONCURRENCY = 5;

// NYC Parks category strings -> the app's class categories (data/classes.js
// CLASS_CATEGORIES ids). First match wins, so more specific buckets first;
// everything else (Games, Nature, Volunteer, Education, Tours…) lands in
// 'social'.
const CATEGORY_MAP = [
  ['aquatics', /swim|aquatic/i],
  ['sports', /sports|pickleball|tennis|basketball|soccer|volleyball|baseball|track|golf|skate|hockey|martial|boxing|archery/i],
  ['dance', /dance/i],
  ['fitness', /fitness|shape up|exercise|yoga|pilates|zumba|wellness|tai chi|hik(e|ing)|running|walking|biking/i],
  ['music', /music|concert/i],
  ['photo', /photo/i],
  ['arts', /arts? ?& ?crafts|\bart\b|film|movie|theater|theatre/i],
  ['camps', /\bcamp\b/i],
  ['youth', /best for kids|kids|youth|teen/i],
];

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`));
  return m ? m[1].trim() : '';
};

// Feed/event-page fragments embed HTML (<p>, <strong>, <br/>) and entities —
// flatten to plain text with paragraph breaks for the app's Text components.
function stripHtml(s) {
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#8220;|&ldquo;|&#8221;|&rdquo;/gi, '"')
    .replace(/&apos;|&#39;|&#8216;|&lsquo;|&#8217;|&rsquo;/gi, "'")
    .replace(/&#8211;|&ndash;|&#8212;|&mdash;/gi, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// "7:00 am" -> minutes from midnight; '' -> null.
function toMin(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}

const fmtClock = (min) => {
  const h24 = Math.floor(min / 60);
  const h = h24 % 12 || 12;
  const mm = String(min % 60).padStart(2, '0');
  return `${h}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`;
};

function categoryFor(categories) {
  for (const [id, re] of CATEGORY_MAP) if (re.test(categories)) return id;
  return 'social';
}

// Age bounds from free text ("ages 6 to 17", "ages 8-14", "8 and older",
// "under 5"), with category fallbacks. Labels follow SF's style ("6-17 yrs",
// "18 yrs +") so the age filter chips work identically.
function parseAges(text, categories) {
  let m = text.match(/ages?\s+(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})/i);
  if (m && Number(m[1]) < Number(m[2])) {
    return { ages: `${m[1]}-${m[2]} yrs`, minAge: Number(m[1]), maxAge: Number(m[2]) };
  }
  m = text.match(/ages?\s+(\d{1,2})\s*\+/i) ||
    text.match(/\b(\d{1,2})\s*(?:years?(?:\s+old)?)?\s+(?:and|or)\s+(?:older|up|above)/i);
  if (m) return { ages: `${m[1]} yrs +`, minAge: Number(m[1]) };
  m = text.match(/\bunder\s+(\d{1,2})\b/i);
  if (m) return { ages: `Under ${m[1]}`, minAge: 0, maxAge: Number(m[1]) - 1 };
  if (/seniors/i.test(categories)) return { ages: 'Seniors (55+)', minAge: 55 };
  if (/best for kids/i.test(categories)) return { ages: 'Best for kids', minAge: 0 };
  return { ages: '', minAge: 0 };
}

function parseItems(xml) {
  const items = [];
  for (const block of xml.split('<item>').slice(1)) {
    const title = stripHtml(tag(block, 'title'));
    const startdate = tag(block, 'event:startdate');
    const start = toMin(tag(block, 'event:starttime'));
    if (!title || !startdate || start == null) continue;
    // The feed keeps cancelled instances (title-prefixed) — drop them; a
    // cancelled date simply falls out of its series' day pattern.
    if (/^\s*(cancel?led|postponed)\b/i.test(title)) continue;
    const coords = tag(block, 'event:coordinates').match(/(-?[\d.]+),\s*(-?[\d.]+)/);
    items.push({
      title,
      date: startdate,
      start,
      end: toMin(tag(block, 'event:endtime')),
      location: stripHtml(tag(block, 'event:location') || tag(block, 'event:parknames')),
      categories: tag(block, 'event:categories'),
      desc: stripHtml(tag(block, 'description')),
      instructor: stripHtml(tag(block, 'instructor')),
      regUrl: tag(block, 'registration_url'),
      url: tag(block, 'link').replace(/^http:/, 'https:'),
      lat: coords ? Number(Number(coords[1]).toFixed(6)) : null,
      lng: coords ? Number(Number(coords[2]).toFixed(6)) : null,
    });
  }
  return items;
}

// ---- Event-page enrichment: cost + registration status ----------------------
// Each event's nycgovparks.org page carries "<h3>Cost</h3><p>Free</p>" and a
// "<p class="registration-details">Registration is closed.</p>" status. Cost is
// stable → cached by URL; registration status flips over time → re-checked
// every run for registration events.
async function fetchEventPage(url) {
  const res = await fetchT(url, { headers: { 'User-Agent': UA } }, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const costM = html.match(/<h3>Cost<\/h3>\s*<p>([\s\S]*?)<\/p>/i);
  const regM = html.match(/class="registration-details"[^>]*>([\s\S]*?)<\/p>/i);
  return {
    cost: costM ? stripHtml(costM[1]) : '',
    regClosed: regM ? /closed/i.test(stripHtml(regM[1])) : false,
  };
}

async function enrichFromPages(seriesList) {
  let costCache = {};
  try {
    costCache = JSON.parse(fs.readFileSync(COST_CACHE_FILE, 'utf8'));
  } catch {}

  // Fetch every distinct event page each run (registration status flips over
  // time, so it can't be cached; series sharing a page share one fetch). The
  // cost cache is the fallback for pages that fail this run.
  const urls = [...new Set(seriesList.map((s) => s.url).filter(Boolean))].slice(0, MAX_PAGE_FETCHES);
  const pageByUrl = {};
  let failed = 0;
  const queue = [...urls];
  const workers = Array.from({ length: PAGE_CONCURRENCY }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      try {
        pageByUrl[url] = await fetchEventPage(url);
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);

  for (const [url, page] of Object.entries(pageByUrl)) {
    if (page.cost) costCache[url] = page.cost;
  }
  for (const s of seriesList) {
    const page = pageByUrl[s.url];
    s.pageCost = (page && page.cost) || costCache[s.url] || '';
    s.regClosed = !!(page && page.regClosed);
  }

  // Prune the cache to the live window so it never grows unbounded.
  const liveUrls = new Set(seriesList.map((s) => s.url));
  costCache = Object.fromEntries(Object.entries(costCache).filter(([u]) => liveUrls.has(u)));
  fs.writeFileSync(COST_CACHE_FILE, JSON.stringify(costCache, null, 2) + '\n');
  console.log(
    `  ✓ event pages: ${Object.keys(pageByUrl).length}/${urls.length} fetched (${failed} failed), ` +
      `${Object.keys(costCache).length} costs cached`
  );
}

// Collapse one-item-per-date recurrences into a single card per
// (title, location, time), labeled with its days of the week.
function groupSeries(items) {
  const bySeries = new Map();
  for (const it of items) {
    const key = `${it.title}|${it.location}|${it.start}|${it.end}`;
    let s = bySeries.get(key);
    if (!s) {
      s = { ...it, dates: [] };
      bySeries.set(key, s);
    }
    if (!s.dates.includes(it.date)) s.dates.push(it.date);
    if (!s.regUrl && it.regUrl) s.regUrl = it.regUrl;
  }
  return [...bySeries.values()];
}

function buildClasses(seriesList) {
  return seriesList
    .map((s) => {
      s.dates.sort();
      const dows = [...new Set(s.dates.map((d) => new Date(d + 'T12:00:00').getDay()))].sort();
      const dayLabel = dows.length >= 6 ? 'Daily' : dows.map((d) => DOW_SHORT[d]).join(' & ');
      const time = s.end != null ? `${fmtClock(s.start)} - ${fmtClock(s.end)}` : fmtClock(s.start);
      // Registration exists when the feed has a link OR the event page shows a
      // (closed) registration section — some staff-run programs publish no
      // registration_url in the feed but still aren't walk-ins.
      const noReg = !s.regUrl && !s.regClosed;
      const age = parseAges(`${s.title} ${s.desc}`, s.categories);
      return {
        id: `nycp-${slug(`${s.title}-${s.location}`)}-${s.start}`,
        source: 'nycparks', // ClassDetail switches its register/note strings on this
        name: s.title,
        category: categoryFor(s.categories),
        location: s.location,
        when: `${dayLabel} · ${time}`,
        dropIn: noReg,
        noOnlineReg: noReg, // reuses the SF "free — just show up" card flow
        cost: s.pageCost || (noReg ? 'Free' : 'See event page'),
        ages: age.ages,
        minAge: age.minAge,
        ...(age.maxAge != null && { maxAge: age.maxAge }),
        // Closed registration maps onto the app's Full indicator (spots 0);
        // open registration has no published capacity — availability unknown.
        spots: s.regClosed ? 0 : noReg ? 0 : null,
        unlimited: noReg,
        start: s.dates[0],
        end: s.dates[s.dates.length - 1],
        oneDay: s.dates.length === 1,
        ...(s.instructor && { instructor: s.instructor }),
        desc: s.desc || '',
        ...(s.lat != null && { lat: s.lat, lng: s.lng }),
        url: s.regUrl || s.url,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

function render(classes, generatedAt, source) {
  return `// AUTO-GENERATED by scripts/build-nyc-classes.js — do not edit by hand.
// Regenerate with: npm run build:nyc-classes
// Generated: ${generatedAt}
//
// Free NYC Parks programs & classes from the nycgovparks.org events feed
// (rolling ~14-day window; the classes cron keeps it fresh), enriched with
// cost/registration status from each event's page. One card per recurring
// (title, location, time) series; same record shape as data/classes.js.
// source = ${JSON.stringify(source)} ("live" | "cache").

export const GENERATED_AT = ${JSON.stringify(generatedAt)};

export const NYC_CLASSES = [
${classes.map((c) => `  ${JSON.stringify(c)},`).join('\n')}
];

export default NYC_CLASSES;
`;
}

async function main() {
  console.log('Fetching NYC Parks events feed…');
  let classes;
  let source;
  try {
    const res = await fetchT(FEED, { headers: { 'User-Agent': UA } }, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The feed declares iso-8859-1 — decode as latin1, not utf-8, or curly
    // quotes/accents in titles turn to mojibake.
    const xml = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const items = parseItems(xml);
    if (items.length < MIN_ITEMS_OK) {
      throw new Error(`only ${items.length} feed items (min ${MIN_ITEMS_OK}) — feed may have changed`);
    }
    const seriesList = groupSeries(items);
    await enrichFromPages(seriesList);
    classes = buildClasses(seriesList);
    source = 'live';
    saveCache(CACHE_FILE, { classes, fetchedAt: new Date().toISOString() });
    const counts = {};
    for (const c of classes) counts[c.category] = (counts[c.category] || 0) + 1;
    console.log(
      `  ✓ ${items.length} events → ${classes.length} cards — ` +
        Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') +
        ' (live)'
    );
  } catch (e) {
    const cache = loadCache(CACHE_FILE);
    if (!cache || !Array.isArray(cache.classes)) {
      throw new Error(`fetch failed (${e.message}) and no cache available — ${OUT_FILE} left unchanged`);
    }
    classes = cache.classes;
    source = 'cache';
    console.log(`  ↺ fetch failed (${e.message}); using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  // Pre-translate titles zh/es (shared helper; cached, key-optional).
  await applyTranslations(classes, {
    cacheFile: I18N_CACHE_FILE,
    contextLine: 'New York City Parks free program and event titles',
  });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, render(classes, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${classes.length} NYC classes to data/cities/nyc/classes.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
