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
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (scripts/cities/nyc-classes-cache.json), with a gate that aborts (keeping
 * the existing data file) if too few items parse. The feed re-issues daily;
 * the classes cron (6h) keeps the rolling window fresh.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { slug, loadCache, saveCache } = require('./lib/courts-common');

const FEED = 'https://www.nycgovparks.org/xml/events_300_rss.xml';
// nycgovparks.org 403s non-browser user agents.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CACHE_FILE = path.join(__dirname, 'cities', 'nyc-classes-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'cities', 'nyc', 'classes.js');

// Abort (keep last-good data) if fewer than this many feed items parse.
const MIN_ITEMS_OK = 100;

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

function parseItems(xml) {
  const items = [];
  for (const block of xml.split('<item>').slice(1)) {
    const title = tag(block, 'title');
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
      location: tag(block, 'event:location') || tag(block, 'event:parknames'),
      categories: tag(block, 'event:categories'),
      desc: tag(block, 'description'),
      instructor: tag(block, 'instructor'),
      regUrl: tag(block, 'registration_url'),
      url: tag(block, 'link').replace(/^http:/, 'https:'),
      lat: coords ? Number(Number(coords[1]).toFixed(6)) : null,
      lng: coords ? Number(Number(coords[2]).toFixed(6)) : null,
    });
  }
  return items;
}

// Collapse one-item-per-date recurrences into a single card per
// (title, location, time), labeled with its days of the week.
function buildClasses(items) {
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

  return [...bySeries.values()]
    .map((s) => {
      s.dates.sort();
      const dows = [...new Set(s.dates.map((d) => new Date(d + 'T12:00:00').getDay()))].sort();
      const dayLabel = dows.length >= 6 ? 'Daily' : dows.map((d) => DOW_SHORT[d]).join(' & ');
      const time = s.end != null ? `${fmtClock(s.start)} - ${fmtClock(s.end)}` : fmtClock(s.start);
      const noReg = !s.regUrl;
      return {
        id: `nycp-${slug(`${s.title}-${s.location}`)}-${s.start}`,
        source: 'nycparks', // ClassDetail switches its register/note strings on this
        name: s.title,
        category: categoryFor(s.categories),
        location: s.location,
        when: `${dayLabel} · ${time}`,
        dropIn: noReg,
        noOnlineReg: noReg, // reuses the SF "free — just show up" card flow
        cost: noReg ? 'Free' : 'See event page',
        ages: '',
        minAge: 0,
        // Drop-ins are uncapped; registration events' capacity is unknown
        // (spots null renders no space indicator rather than a claim).
        spots: noReg ? 0 : null,
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
// (rolling ~14-day window; the classes cron keeps it fresh). One card per
// recurring (title, location, time) series; same record shape as
// data/classes.js. source = ${JSON.stringify(source)} ("live" | "cache").

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
    const items = parseItems(await res.text());
    if (items.length < MIN_ITEMS_OK) {
      throw new Error(`only ${items.length} feed items (min ${MIN_ITEMS_OK}) — feed may have changed`);
    }
    classes = buildClasses(items);
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

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, render(classes, new Date().toISOString(), source));
  console.log(`\n✅ Wrote ${classes.length} NYC classes to data/cities/nyc/classes.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
