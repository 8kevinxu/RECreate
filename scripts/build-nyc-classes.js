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
// Full descriptions (from registration pages) are stable → cached by URL so
// only new events cost a fetch. PerfectMind spots/status are volatile and
// re-fetched every run (not cached).
const DESC_CACHE_FILE = path.join(__dirname, 'cities', 'nyc-classes-desc-cache.json');
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
  // Fitness no longer claims hiking/walking — those read as outdoors (below).
  ['fitness', /fitness|shape up|exercise|yoga|pilates|zumba|wellness|tai chi|running|jogging|biking|cycling|strength|weightlift|calisthenic|bootcamp|aerobic|cardio/i],
  // Nature vs Learn is tiered so ambiguous words ("tour", "walk") don't
  // outrank clear signals: STRONG nature (birding, canoe, wildlife) →
  // STRONG learn (history, lecture, workshop) → a bare "tour" → weak outdoors
  // (hike, trail, ranger, waterfront). So "Birding by Canoe Excursion" is
  // Nature, "Historic Walking Tour" is Learn, "Harbor Walking Tour" is Learn,
  // "Nature Walk" is Nature.
  ['nature', /nature|wildlife|\bbird|canoe|kayak|\bfish|marsh|wetland|garden|nurser|forest|bioblitz|camping|ecolog|greenwatch|habitat|shorebird/i],
  ['learn', /history|historic|lecture|\btalks?\b|education|workshop|reservoir|aqueduct/i],
  ['learn', /\btours?\b/i],
  ['nature', /\bhik|\btrail|waterfront|\branger|excursion|adventure course|walking|\bwalk\b|outdoor/i],
  ['film', /\bfilms?\b|movie|cinema|screening/i],
  ['music', /music|concert/i],
  ['photo', /photo/i],
  ['arts', /arts? ?& ?crafts|\bart\b|theater|theatre/i],
  ['camps', /\bcamp\b/i],
  ['youth', /best for kids|kids|youth|teen/i],
];

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// NYC park-id prefix → borough (matches the outdoor/indoor courts' neighborhood
// field, so the app's borough filter applies uniformly across courts + classes).
const BOROUGH = { X: 'Bronx', B: 'Brooklyn', M: 'Manhattan', Q: 'Queens', R: 'Staten Island' };

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

// Cross-cutting THEMES layered on top of the primary category as tags, so an
// event keeps its natural category and also appears under each theme filter:
//   philanthropy — volunteer / stewardship (cleanups, tree care, restoration).
//   accessible   — adaptive / inclusive / sensory-friendly programming.
//   performances — live shows (concerts, theater, comedy) — a concert stays
//                  primary 'music' but also surfaces under Performances.
const PHILANTHROPY_RE =
  /volunteer|steward|clean.?up|restoration|it'?s my park|conservan|\bwaste\b|litter|\btrash\b|tree care|forest|habitat|ecolog|community (service|work)/i;
const ACCESSIBLE_RE = /accessible activit|adaptive|inclusive|sensory.?friendly|wheelchair/i;
const PERFORMANCES_RE = /concert|theat(er|re)|performance|comedy|opera|symphony|orchestra|cabaret/i;

// An event's NYC categories (pipe-separated, e.g. "Concerts | Art | Gardening")
// map to one PRIMARY app category (most-specific first match) plus secondary
// TAGS — every other app category it matches, plus the cross-cutting themes —
// so a multi-theme event surfaces under each. Returns { category, tags }.
function categoriesFor(categories) {
  const matched = [];
  for (const [id, re] of CATEGORY_MAP) if (re.test(categories) && !matched.includes(id)) matched.push(id);
  const category = matched[0] || 'social';
  const tags = matched.slice(1);
  const addTag = (id, cond) => {
    if (cond && id !== category && !tags.includes(id)) tags.push(id);
  };
  addTag('philanthropy', PHILANTHROPY_RE.test(categories));
  addTag('accessible', ACCESSIBLE_RE.test(categories));
  addTag('performances', PERFORMANCES_RE.test(categories));
  return { category, tags };
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
    // Borough from the (non-CDATA) park-id prefix; blank when absent (→ shows
    // under any borough filter rather than being wrongly hidden).
    const parkid = (block.match(/<event:parkids>([^<]*)<\/event:parkids>/) || [])[1] || '';
    items.push({
      title,
      borough: BOROUGH[parkid.trim()[0]] || '',
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

// ---- Registration-page enrichment: openings, ages, full description ---------
// Most registration events (415/559) book on nycparks.perfectmind.com, whose
// landing page embeds per-occurrence JSON: SpotsLeft (real openings — the RSS
// has none), age restrictions, the registration deadline, and the full class
// description. Everything else (bronxriver, eventbrite, nyrr…) gets its full
// description recovered by anchoring on the RSS snippet's opening text.

const grab = (s, re) => {
  const m = String(s).match(re);
  return m ? m[1] : '';
};
const unescapeJson = (s) =>
  String(s).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\//g, '/').replace(/\\\\/g, '\\');

function parsePerfectMind(html, occurrenceDate) {
  // Each occurrence object spans SpotsLeft/DisplayableRestrictions/… (near its
  // start) through the class description to "OccurrenceDate" (near its end), so
  // the two can be far apart. Pair each OccurrenceDate with the SpotsLeft that
  // most recently precedes it, giving a date → occurrence-window map.
  const spotHits = [...html.matchAll(/"SpotsLeft":(\d+)/g)];
  const occHits = [...html.matchAll(/"OccurrenceDate":"(\d{8})"/g)];
  const dates = [...new Set(occHits.map((m) => m[1]))].sort();

  const windowFor = (occ) => {
    const oh = occ ? occHits.find((m) => m[1] === occ) : occHits[0];
    const end = oh ? oh.index + 30 : 0;
    // SpotsLeft nearest before this occurrence's OccurrenceDate.
    let start = 0;
    for (const sh of spotHits) if (sh.index < (oh ? oh.index : Infinity)) start = sh.index;
    // Lead in ~400 chars so DisplayableRestrictions (just before SpotsLeft) is
    // inside the window.
    return { win: html.slice(Math.max(0, start - 400), end), sh: spotHits.filter((s) => s.index <= (oh ? oh.index : Infinity)).pop() };
  };

  // Prefer the requested date; else the first (soonest) occurrence on the page.
  const { win, sh } = windowFor(dates.includes(occurrenceDate) ? occurrenceDate : dates[0]);
  return {
    spots: sh ? Number(sh[1]) : null,
    closed: /"IsRegistrationClosed":true/.test(win),
    ages: unescapeJson(grab(win, /"DisplayableRestrictions":"((?:[^"\\]|\\.)*)"/)),
    deadline: unescapeJson(grab(win, /"FormattedRegistrationInfo":"((?:[^"\\]|\\.)*)"/)),
    // Class description (class-level, appears once near the top).
    desc: unescapeJson(grab(html, /"Details":"((?:[^"\\]|\\.)*)"/)),
    dates, // all occurrence dates → recurring schedule / scope
  };
}

// Recover the full description from an arbitrary registration page by locating
// the RSS snippet's opening text and taking the contiguous block that follows.
function extractFullDesc(html, rssDesc) {
  const text = stripHtml(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
  const flat = text.replace(/\s+/g, ' ');
  const anchor = (rssDesc || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  if (anchor.length >= 20) {
    const at = flat.indexOf(anchor);
    if (at >= 0) {
      let block = flat.slice(at, at + 2000).trim();
      // Trim a dangling partial sentence at the end.
      const lastStop = block.lastIndexOf('. ');
      if (lastStop > 400) block = block.slice(0, lastStop + 1);
      if (block.length > (rssDesc || '').length + 40) return block;
    }
  }
  // Fallback: a long og:description / meta description.
  const og =
    grab(html, /<meta property="og:description" content="([^"]{80,})"/i) ||
    grab(html, /<meta name="description" content="([^"]{80,})"/i);
  return og.length > (rssDesc || '').length + 40 ? stripHtml(og) : '';
}

async function enrichFromReg(seriesList) {
  let descCache = {};
  try {
    descCache = JSON.parse(fs.readFileSync(DESC_CACHE_FILE, 'utf8'));
  } catch {}

  // PerfectMind pages carry live spots → re-fetch every run. Other reg pages
  // only give a (stable) description → fetch once, then serve from cache.
  const isPM = (u) => /perfectmind\.com/i.test(u) && /classId=/.test(u) && /occurrenceDate=/.test(u);
  const jobs = [];
  for (const s of seriesList) {
    if (!s.regUrl) continue;
    if (isPM(s.regUrl)) jobs.push(s);
    else if (!descCache[s.regUrl]) jobs.push(s);
  }

  let pm = 0;
  let desc = 0;
  let failed = 0;
  const queue = jobs.slice(0, MAX_PAGE_FETCHES);
  const workers = Array.from({ length: PAGE_CONCURRENCY }, async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      try {
        const res = await fetchT(s.regUrl, { headers: { 'User-Agent': UA } }, 15000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        if (isPM(s.regUrl)) {
          const occ = grab(s.regUrl, /occurrenceDate=(\d{8})/);
          const info = parsePerfectMind(html, occ);
          s.pm = info;
          if (info.desc) descCache[s.regUrl] = info.desc;
          pm++;
        } else {
          const full = extractFullDesc(html, s.desc);
          if (full) {
            descCache[s.regUrl] = full;
            desc++;
          }
        }
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);

  // Attach cached full descriptions.
  for (const s of seriesList) {
    if (s.regUrl && descCache[s.regUrl]) s.fullDesc = descCache[s.regUrl];
  }

  // Prune desc cache to the live registration URLs.
  const live = new Set(seriesList.map((s) => s.regUrl).filter(Boolean));
  descCache = Object.fromEntries(Object.entries(descCache).filter(([u]) => live.has(u)));
  fs.writeFileSync(DESC_CACHE_FILE, JSON.stringify(descCache, null, 2) + '\n');
  console.log(`  ✓ reg pages: ${pm} PerfectMind (spots/ages), ${desc} full descriptions (${failed} failed), ${Object.keys(descCache).length} cached`);
}

// Human "N sessions · Jul 30 – Oct 29" scope from a class's occurrence dates
// (PerfectMind's full list, else the feed's rolling-window dates). null for a
// single session.
function sessionScope(dates) {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) return null;
  const fmt = (d) => {
    const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T12:00:00`);
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getMonth()]} ${dt.getDate()}`;
  };
  return { count: uniq.length, first: fmt(uniq[0]), last: fmt(uniq[uniq.length - 1]) };
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
      const { category, tags } = categoriesFor(s.categories);
      const pm = s.pm; // PerfectMind enrichment (spots/ages/deadline/dates), when present
      // Ages: PerfectMind's stated restriction wins; else parse title/description.
      const pmAge = pm && pm.ages ? parseAges(`ages ${pm.ages}`, '') : null;
      const age = pmAge && pmAge.ages ? pmAge : parseAges(`${s.title} ${s.desc}`, s.categories);
      // Spots: PerfectMind's real SpotsLeft; else closed→0, walk-in→0 (unlimited),
      // open-but-unknown→null (no published capacity).
      const closed = pm ? pm.closed : s.regClosed;
      const spots = pm && pm.spots != null ? pm.spots : closed ? 0 : noReg ? 0 : null;
      const scope = sessionScope(pm && pm.dates && pm.dates.length ? pm.dates : s.dates.map((d) => d.replace(/-/g, '')));
      return {
        id: `nycp-${slug(`${s.title}-${s.location}`)}-${s.start}`,
        source: 'nycparks', // ClassDetail switches its register/note strings on this
        name: s.title,
        category,
        ...(tags.length && { tags }),
        ...(s.borough && { borough: s.borough }),
        location: s.location,
        when: `${dayLabel} · ${time}`,
        dropIn: noReg,
        noOnlineReg: noReg, // reuses the SF "free — just show up" card flow
        cost: s.pageCost || (noReg ? 'Free' : 'See event page'),
        ages: age.ages,
        minAge: age.minAge,
        ...(age.maxAge != null && { maxAge: age.maxAge }),
        spots,
        unlimited: noReg,
        ...(scope && { sessions: scope }),
        ...(pm && pm.deadline && { regDeadline: pm.deadline }),
        start: s.dates[0],
        end: s.dates[s.dates.length - 1],
        oneDay: s.dates.length === 1 && (!pm || pm.dates.length <= 1),
        ...(s.instructor && { instructor: s.instructor }),
        // Full description from the registration page (PerfectMind Details or
        // the anchored extraction), falling back to the RSS snippet.
        desc: (s.fullDesc && s.fullDesc.length > (s.desc || '').length ? s.fullDesc : s.desc) || '',
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
    await enrichFromReg(seriesList);
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
