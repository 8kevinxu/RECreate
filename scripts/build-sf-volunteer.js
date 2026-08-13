#!/usr/bin/env node
/*
 * Build data/volunteer.js — SF Rec & Park volunteer opportunities (habitat
 * restoration, horticultural maintenance, park stewardship), scraped from their
 * public volunteer calendar. Run with:  npm run build:volunteer
 *
 * The calendar at https://sfrpd.my.salesforce-sites.com/SFRPDCalendar renders
 * NOTHING server-side: the page is a 3KB Visualforce shell that boots a Lightning
 * Out component, so there is no HTML to parse and nothing for a crawler to see.
 * The data comes from a public Apex controller behind Salesforce's Aura endpoint:
 *
 *   POST /aura?aura.ApexAction.execute=1
 *   message = { actions: [{ descriptor: aura://ApexActionController/ACTION$execute,
 *                           params: { classname: 'SFRPCalendar', method, params } }] }
 *
 * `getFilterJobs` is the useful one — every shift with its park, address, duration
 * and live "volunteers still needed" count. No auth: the site is a public
 * Salesforce Site, and the endpoint answers even with a junk `fwuid`, which is why
 * we don't have to scrape a framework nonce out of the page first. We only ever
 * call READ methods; the controller also exposes `insertVoulnteerInfor` (sic), the
 * signup write path, which this build must never touch.
 *
 * RECORD SHAPE: these become entries in the app's class catalog (see
 * data/sf-classes.js), so they match data/classes.js's shape exactly. They carry
 * `source: 'sfrpd-volunteer'` to mark them as NOT from ActiveNet — ClassesScreen's
 * live-delist check must skip them or every one disappears on native.
 *
 * SHIFTS vs JOBS: the feed is an archive, not a calendar — ~87% of its rows are
 * shifts that already happened, going back to 2020, and each recurring workparty
 * emits one row per date. We keep upcoming shifts only and collapse them to one
 * card per job (the same thing build-classes.js does with ActiveNet drop-in
 * series), which turns ~1,700 rows into ~37 entries.
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (sf-volunteer-cache.json); a fetch failure keeps the existing data file.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');
const { applyTranslations } = require('./lib/translate-titles');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SITE = 'https://sfrpd.my.salesforce-sites.com';
const AURA = `${SITE}/aura?r=1&aura.ApexAction.execute=1`;
const CALENDAR_URL = `${SITE}/SFRPDCalendar`;
const CACHE_FILE = path.join(__dirname, 'sf-volunteer-cache.json');
const I18N_CACHE_FILE = path.join(__dirname, 'sf-volunteer-i18n-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'volunteer.js');
const TZ = 'America/Los_Angeles';

// Abort (keep last-good) below this many jobs. ~37 is the steady state; the floor
// is loose because the calendar genuinely thins out — the seasonal non-gardening
// programs (Scaregrove, the Randall Museum Halloween day, holiday craft fairs)
// only exist in October–December.
const MIN_OK = 8;

// How far ahead a shift counts. The feed pads recurring series with placeholder
// instances dated as far out as 2030 — 132 of the 223 upcoming rows sit in 2027+
// and add ZERO jobs not already present in the next 90 days, so a horizon keeps
// "end" honest instead of claiming a workparty runs through 2030.
const HORIZON_DAYS = 180;

// --- Aura -------------------------------------------------------------------

// A read call on the public SFRPCalendar controller. `fwuid` is deliberately junk:
// the real one changes every Salesforce release and the endpoint doesn't check it
// for this app, so pinning a scraped nonce would just add a thing that breaks.
async function apex(method, params = {}) {
  const message = {
    actions: [
      {
        id: '1;a',
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: { namespace: '', classname: 'SFRPCalendar', method, params, cacheable: false, isContinuation: false },
      },
    ],
  };
  const context = { mode: 'PROD', fwuid: 'XXXXXXXXXXXXXXXX', app: 'c:SFRPInforApp', loaded: {}, dn: [], globals: {}, uad: false };
  const body = new URLSearchParams({
    message: JSON.stringify(message),
    'aura.context': JSON.stringify(context),
    'aura.pageURI': '/SFRPDCalendar',
    'aura.token': 'null',
  });

  const res = await fetchT(
    AURA,
    {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    45000
  );
  if (!res.ok) throw new Error(`aura ${method}: HTTP ${res.status}`);
  const json = await res.json();
  const action = json?.actions?.[0];
  if (!action) throw new Error(`aura ${method}: no action in response`);
  if (action.state !== 'SUCCESS') {
    // The controller's own getselectOptions() throws a NullPointerException in
    // production; surface whatever Apex said rather than a bare "failed".
    const msg = action.error?.[0]?.message || action.state;
    throw new Error(`aura ${method}: ${msg}`);
  }
  return action.returnValue?.returnValue ?? [];
}

// --- Text -------------------------------------------------------------------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…',
};

// Rich-text (Salesforce stores these as HTML) -> plain text, keeping paragraph
// breaks. Block tags become newlines so a multi-paragraph blurb doesn't collapse
// into one run-on sentence in the card.
function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/​|﻿/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// SFRPD pastes a red "we are experiencing technical difficulties" apology at the
// TOP of most job descriptions, so it would lead every card in the app with an
// apology for someone else's site. Drop the apology sentence but keep the
// instruction that follows it — "RSVP by selecting 'Group Sign Up' even when you
// are not registering as a group" is a real, load-bearing quirk of their signup
// form. Same trust call as pbsfFreshen in build-court-directory.js: strip a
// source's stale operational noise, never its facts.
const APOLOGY_RE = /[^.!?]*\bexperiencing technical difficulties\b[^.!?]*[.!?]\s*/gi;
const freshen = (text) => text.replace(APOLOGY_RE, '').trim();

// --- Dates ------------------------------------------------------------------

// The feed's Start_Date_Time is a UTC instant; everything the user sees is Pacific
// wall-clock. Formatting through the tz (rather than the build host's local zone)
// keeps a CI run in UTC from reporting a 9 AM workparty as 4 PM.
const fmt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts }).format(new Date(iso));
const ymd = (iso) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso)
  );
  return p; // en-CA gives YYYY-MM-DD
};
const weekday = (iso) => fmt(iso, { weekday: 'short' });
const minutesOfDay = (iso) => {
  const [h, m] = fmt(iso, { hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return h * 60 + m;
};
const clock = (min) => {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const mode = (arr) => {
  const c = {};
  for (const v of arr) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
};

// --- Categories -------------------------------------------------------------

// Every one of these is a volunteer opportunity, so `philanthropy` (the chip the
// app labels "Volunteer") is the PRIMARY category — unlike NYC, where park
// stewardship is one event type among many in a general Parks feed and lands under
// `nature` with a philanthropy tag. The secondary tag is set from the source's own
// Activities__c so the entries also answer the 🌳 Nature chip, which is what most
// of them actually are.
const TAG_FOR_ACTIVITY = {
  'Habitat Restoration': 'nature',
  'Horticultural Maintenance': 'nature',
  'Community Garden Support': 'nature',
  'Litter Abatement': 'nature',
  'Trail Maintenance': 'nature',
  'Planting Natives': 'nature',
  'Dog Play Area Maintenance': 'nature',
  'Playground Maintenance': 'nature',
  'Recreation Center Support': 'social',
};

// --- Coordinates ------------------------------------------------------------

// Park coords come from the court data we already ship. SFRPD's volunteer records
// use internal park names ("GGP Sec 2 Rhododendron Dell") that the public court
// data has no row for, so the Golden Gate Park sections and a few standalone
// natural areas are curated here. Coordinates are the actual work site, not the
// park centroid — "Golden Gate Park" spans three miles and would send a volunteer
// to the wrong end of it.
// Keys are the park name run through `norm()` (lowercased, punctuation dropped),
// so "GGP Sec 4 - Rose Garden" and "Lakeview & Ashton Mini Park" match without
// having to reproduce their punctuation here.
const MANUAL_COORDS = {
  'ggp sec 1 alvord lake': { lat: 37.77035, lng: -122.45443 },
  'ggp sec 1 conservatory of flowers': { lat: 37.77198, lng: -122.46026 },
  'ggp conservatory valley': { lat: 37.77153, lng: -122.4601 },
  'ggp sec 2 rhododendron dell': { lat: 37.7699, lng: -122.46429 },
  'ggp sec 3 botanical gardens': { lat: 37.76744, lng: -122.46896 },
  'ggp sec 4 blue heron lake boathouse': { lat: 37.76861, lng: -122.47588 },
  'ggp sec 4 rose garden': { lat: 37.77179, lng: -122.47016 },
  'ggp sec 5 bison paddock': { lat: 37.7702, lng: -122.4917 },
  'ggp sec 6 north lake': { lat: 37.7715, lng: -122.50252 },
  'ggp sec 6 archery range': { lat: 37.76973, lng: -122.50134 },
  'golden gate park oak woodlands': { lat: 37.77132, lng: -122.4655 },
  'golden gate park strawberry hill': { lat: 37.76839, lng: -122.4757 },
  'tree fern dell': { lat: 37.77007, lng: -122.46256 },
  'herons head park': { lat: 37.73832, lng: -122.37481 },
  'mt davidson park': { lat: 37.7383, lng: -122.45437 },
  'mount davidson park': { lat: 37.7383, lng: -122.45437 },
  'interior greenbelt': { lat: 37.75993, lng: -122.45635 },
  'the de young museum': { lat: 37.77147, lng: -122.46864 },
  'lincoln park': { lat: 37.7841, lng: -122.4996 },
  'mission bay commons park': { lat: 37.77037, lng: -122.39121 },
  'mission bay kids park': { lat: 37.7712, lng: -122.39312 },
  'palou phelps park': { lat: 37.73395, lng: -122.38995 },
  'pine lake park': { lat: 37.73386, lng: -122.49419 },
  // Sharp Park is SFRPD-owned but physically in Pacifica, ~12 miles south of the
  // city — the distance filter should show it as the far-away thing it is.
  'os1 sharp park': { lat: 37.62766, lng: -122.4903 },
  'now hunters point': { lat: 37.73441, lng: -122.37718 },
  'balboa natural area': { lat: 37.72165, lng: -122.4593 },
  'grand view open space': { lat: 37.75609, lng: -122.4744 },
  'park presidio pollinator garden': { lat: 37.77596, lng: -122.47269 },
  'john mclaren park gambier plaza': { lat: 37.71889, lng: -122.41396 },
  'marina yacht harbor': { lat: 37.80637, lng: -122.4364 },
  'lakeview ashton mini park': { lat: 37.71932, lng: -122.4576 },
};

// Name -> {lat,lng} from the bundled court data, matched on a stripped form so
// "Buena Vista Park" finds "Buena Vista Park" regardless of the suffix noise both
// sides carry.
function buildCoords() {
  const strip = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(rec(reation)? center|playgrounds?|park|plgd|center|clubhouse|square|mini)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const map = {};
  for (const f of ['../data/outdoor-courts.js', '../data/courts.js', '../data/manual-courts.js']) {
    try {
      const m = require(f);
      const arr = m.default || m.OUTDOOR_COURTS || m.COURTS || m.MANUAL_COURTS;
      for (const c of Array.isArray(arr) ? arr : []) {
        if (c?.name && Number.isFinite(c.lat) && Number.isFinite(c.lng)) {
          const k = strip(c.name);
          if (k && !map[k]) map[k] = { lat: c.lat, lng: c.lng };
        }
      }
    } catch {
      // optional source — a missing court file just means fewer auto-matches
    }
  }
  return (name) => MANUAL_COORDS[norm(name)] || map[strip(name)] || null;
}

// --- Shape ------------------------------------------------------------------

// One recurring job -> one class-catalog entry, from its upcoming shifts.
function toEntry(jobId, shifts, coordsFor) {
  shifts.sort((a, b) => (a.GW_Volunteers__Start_Date_Time__c < b.GW_Volunteers__Start_Date_Time__c ? -1 : 1));
  const next = shifts[0];
  const job = next.GW_Volunteers__Volunteer_Job__r || {};
  const park = next.Parks__r || {};

  // Recurrence, from the shifts themselves — the source states no rule. Days are
  // listed in week order (a job can run more than one day); the time is the modal
  // start, because a series with one odd early shift still reads "9:00 AM".
  const days = [...new Set(shifts.map((s) => weekday(s.GW_Volunteers__Start_Date_Time__c)))].sort(
    (a, b) => DOW.indexOf(a) - DOW.indexOf(b)
  );
  const startMin = +mode(shifts.map((s) => minutesOfDay(s.GW_Volunteers__Start_Date_Time__c)));
  const durH = Number(next.GW_Volunteers__Duration__c) || 0;
  const when = `${days.join(', ')} · ${clock(startMin)}${durH ? ` - ${clock(startMin + Math.round(durH * 60))}` : ''}`;

  const location = park.Name || next.Job_Location_Street__c || 'San Francisco';
  const coords = coordsFor(location) || coordsFor(park.BillingStreet) || null;

  // Description = the job blurb + where to actually meet, which the source keeps
  // in its own field and is the single most useful line for a first-timer.
  const meet = stripHtml(job.GW_Volunteers__Location_Information__c);
  const desc = [freshen(stripHtml(job.GW_Volunteers__Description__c)), meet && `Meet: ${meet}`]
    .filter(Boolean)
    .join('\n\n');

  const org = job.Fo_Group_Leader_1__r?.Name || '';
  const activity = next.Activities__c || '';
  const tag = TAG_FOR_ACTIVITY[activity];

  return {
    id: `vol-${jobId}`,
    source: 'sfrpd-volunteer',
    name: job.Name || 'Volunteer Workparty',
    category: 'philanthropy',
    ...(tag ? { tags: [tag] } : {}),
    location,
    when,
    dropIn: false,
    cost: 'Free',
    ages: '',
    minAge: 0,
    // Live "still needed" for the NEXT shift — the number that answers "can I
    // come this week?". Summing the series would advertise capacity months out.
    spots: Number.isFinite(next.GW_Volunteers__Number_of_Volunteers_Still_Needed__c)
      ? next.GW_Volunteers__Number_of_Volunteers_Still_Needed__c
      : null,
    unlimited: false,
    start: ymd(next.GW_Volunteers__Start_Date_Time__c),
    end: ymd(shifts[shifts.length - 1].GW_Volunteers__Start_Date_Time__c),
    ...(shifts.length === 1 ? { oneDay: true } : {}),
    ...(org ? { instructor: org } : {}),
    ...(activity ? { activity } : {}),
    ...(desc ? { desc } : {}),
    ...(coords || {}),
    // No per-job deep link exists: the Visualforce page reads a job id into
    // `vJobId`, but none of the obvious query-param names bind to it, so every
    // entry points at the calendar itself rather than a URL that 404s silently.
    url: CALENDAR_URL,
  };
}

async function scrape() {
  const shifts = await apex('getFilterJobs');
  if (!Array.isArray(shifts) || !shifts.length) throw new Error('getFilterJobs returned no shifts');
  console.log(`  ${shifts.length} shift rows in the feed (all history)`);

  const now = Date.now();
  const horizon = now + HORIZON_DAYS * 864e5;
  const upcoming = shifts.filter((s) => {
    const t = Date.parse(s.GW_Volunteers__Start_Date_Time__c);
    return Number.isFinite(t) && t >= now && t <= horizon && s.GW_Volunteers__Volunteer_Job__c;
  });
  console.log(`  ${upcoming.length} upcoming within ${HORIZON_DAYS} days`);

  const byJob = new Map();
  for (const s of upcoming) {
    const k = s.GW_Volunteers__Volunteer_Job__c;
    if (!byJob.has(k)) byJob.set(k, []);
    byJob.get(k).push(s);
  }

  const coordsFor = buildCoords();
  const entries = [...byJob].map(([jobId, list]) => toEntry(jobId, list, coordsFor));

  const missing = entries.filter((e) => e.lat == null);
  if (missing.length) {
    console.log(`  ⚠ ${missing.length} entr(ies) without coordinates — add to MANUAL_COORDS:`);
    for (const e of missing) console.log(`      ${e.location}`);
  }
  return entries;
}

function render(entries, generatedAt) {
  const body = entries.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return `// AUTO-GENERATED by scripts/build-sf-volunteer.js — do not edit by hand.
// Regenerate with: npm run build:volunteer
// Generated: ${generatedAt}
//
// SF Rec & Park volunteer opportunities (habitat restoration, horticultural
// maintenance, park stewardship), from their public Salesforce volunteer calendar.
//
// These are CLASS CATALOG RECORDS — same shape as data/classes.js — merged into
// the SF catalog by data/sf-classes.js, so they browse, filter and open exactly
// like an ActiveNet class. They file under the 'philanthropy' category (the chip
// the app labels "Volunteer") with a secondary 'nature'/'social' tag.
//
// \`source: 'sfrpd-volunteer'\` marks them as NOT from ActiveNet — anything that
// checks a record against the live ActiveNet catalog must skip them.
//
// One entry per recurring job (the feed emits one row per DATE); \`when\` is the
// recurrence derived from its upcoming shifts, \`spots\` is the live
// volunteers-still-needed count for the NEXT one, and start/end bracket the
// shifts inside the build's ${HORIZON_DAYS}-day horizon.

export const VOLUNTEER = [
${body}
];

export default VOLUNTEER;
`;
}

async function main() {
  console.log('Fetching SF Rec & Park volunteer calendar…');
  let entries;
  let source;
  try {
    entries = await scrape();
    if (entries.length < MIN_OK) {
      throw new Error(`only ${entries.length} volunteer jobs (min ${MIN_OK}) — feed shape may have changed`);
    }
    source = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ entries, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    let cache = null;
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch {}
    if (!cache?.entries?.length) {
      throw new Error(`fetch failed (${e.message}) and no cache — data/volunteer.js left unchanged`);
    }
    entries = cache.entries;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  entries.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));

  await applyTranslations(entries, {
    cacheFile: I18N_CACHE_FILE,
    contextLine: 'San Francisco park volunteer workparty / habitat restoration event titles',
  });

  fs.writeFileSync(OUT_FILE, render(entries, new Date().toISOString()));
  console.log(`\n✅ Wrote ${entries.length} volunteer opportunities to data/volunteer.js (${source})`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n❌ Failed:', e.message);
    process.exit(1);
  });
} else {
  module.exports = { apex, stripHtml, toEntry, buildCoords };
}
