#!/usr/bin/env node
/*
 * Build data/court-directory.js — per-court facility facts (court counts, lights,
 * restrooms, nets) for tennis + pickleball, scraped from SF Rec & Park's public
 * court directories. Run with:  npm run build:directory
 *
 *   Tennis:     https://sfrecpark.org/1446/Tennis-Court-Directory
 *   Pickleball: https://sfrecpark.org/1772/Pickleball-Court-Directory
 *
 * Each directory is a single HTML table keyed by facility name. We parse the rows,
 * match each to one of our outdoor courts by name (sport-gated, with a few manual
 * aliases for names that don't line up), and write a courtId -> { sport: {...} }
 * map merged at runtime by lib/useCourts.js and shown on the court detail card.
 *
 * Resilience mirrors the other builds: live fetch -> last-good cache
 * (directory-cache.json); a fetch failure keeps the existing data file.
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const SOURCES = {
  tennis: 'https://sfrecpark.org/1446/Tennis-Court-Directory',
  pickleball: 'https://sfrecpark.org/1772/Pickleball-Court-Directory',
};
const CACHE_FILE = path.join(__dirname, 'directory-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'court-directory.js');
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Abort (keep last-good data) if fewer than this many courts get directory facts.
const MIN_COURTS_OK = 30;

// Directory facility name (normalized) -> our court id, for names that don't match
// by substring (the directory shortens or renames a few parks).
const ALIASES = {
  rossi: 'angelo-j-rossi-playground-outdoor',
  'dolores park': 'mission-dolores-park-outdoor',
  larsen: 'carl-larsen-park-outdoor',
  mclaren: 'john-mclaren-park-outdoor',
  'j p murphy': 'j-p-murphy-playground-outdoor',
  'margaret s hayward': 'margaret-s-hayward-playground-outdoor',
  'minnie and lovie ward': 'minnie-and-lovie-rec-center-outdoor',
  'stern grove': 'sigmund-stern-recreation-grove-outdoor',
};

// Pickleball open-play times for "See schedule" directory rows come from the
// schedule PDF each row links (DocumentCenter): openPlayFromPdf() parses the
// poster's weekly grid when the PDF has a text layer (Moscone) into a 7-day
// week of [startMin, endMin] blocks (0=Sun..6=Sat — same convention as
// court.dropins, so the app can merge them into the schedule rows). Some
// posters are flattened images with NO text layer (Presidio Wall, Rossi as of
// 2026-07) — those fall back to the entries below, transcribed from the
// posters: a `week` of open-play blocks, plus an optional `note` for nuance
// the week can't carry. The build logs when a fallback is used; re-verify
// these if SFRP posts a new poster (the log prints the PDF URL).
const PDF_FALLBACK = {
  // Poster: courts B/D/F are open play 9AM-dark every day; courts A/C/E are
  // open play 9AM-1PM (weekends 9AM-3PM) then reservable until dark. One
  // tagged open-play block per day (true via B/D/F, ending at the 8PM the app
  // uses for park daylight hours) REPLACES the generic dropins — pickleball
  // doesn't exist here before 9AM (tennis holds 7:30-9). The A/C/E split
  // rides OPEN_PLAY_NOTES.
  'presidio wall': { playWeek: Array.from({ length: 7 }, () => [[540, 1200, 'openplay']]) },
  // Poster ("Rossi Court 3"): open play Tue/Thu/Fri 9AM-3PM & Sun 9AM-5PM on
  // the main pod. Unlike Moscone, pickleball at Rossi is available all day on
  // OTHER courts (1 & 2 walk-up, court E reservable), so this is an open-play
  // overlay on the general daylight hours — NOT a playWeek replacement — and
  // the court split rides OPEN_PLAY_NOTES.
  rossi: { week: [[[540, 1020]], [], [[540, 900]], [], [[540, 900]], [[540, 900]], []] },
};

// Court-split / reservation nuance the weekly open-play blocks can't carry,
// transcribed from the same posters (applies to parsed and fallback courts
// alike); the card shows it under the weekly schedule. Re-verify with the
// posters when SFRP revises them.
const OPEN_PLAY_NOTES = {
  moscone: 'Evenings after the times shown: court 4 reservable for tennis or pickleball (Tue/Thu tennis-only); court 3 tennis-only.',
  'presidio wall': 'Courts B/D/F: open play all day. Courts A/C/E: reservable after 1 PM (3 PM weekends).',
  rossi: 'Open play is on court 3 (main pod), reservable after it ends. Courts 1 & 2: walk-up, bring your own net (tennis reservations may take them weekend mornings). Court E (permanent net): reservable all day.',
};

// The same posters constrain TENNIS at these facilities. Presidio Wall's poster
// covers every court, so tennis there is literally 7:30-9 AM daily — playWeek
// REPLACES the court's dropins.tennis at runtime (lib/useCourts.js), so the
// map's open-now status and the schedule agree. Moscone's and Rossi's posters
// govern only courts 3(&4) while their other courts stay all-day tennis, so
// they get a note instead of an override.
const TENNIS_ADJUST = {
  'presidio wall': {
    playWeek: Array.from({ length: 7 }, () => [[450, 540]]),
    note: 'Tennis 7:30-9 AM daily only — courts convert to pickleball at 9 AM. High-school tennis may reserve 3-6 PM in season.',
  },
  moscone: {
    note: 'Courts 3 & 4 host pickleball part-day; tennis-only Tue/Thu 9 AM-3 PM & Sun 9 AM-5 PM, shared 3-6 PM weekdays. Courts 1 & 2 all-day tennis.',
  },
  rossi: {
    note: 'Court 3 hosts pickleball part-day (shared from 3 PM weekdays / 5 PM weekends); courts 1 & 2 all-day tennis.',
  },
};

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop parentheticals like "(15th St)"
    .replace(/&/g, ' and ')
    .replace(/[.,'’"]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(jr|sr)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');

const num = (s) => {
  const n = parseInt(String(s).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
};
const yes = (s) => /^\s*y/i.test(String(s || ''));

async function getHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Read a directory table into header-keyed row objects. Cell links survive as
// row._links[header] (absolute URLs) — the pickleball "See schedule" cells link
// each court's posted schedule PDF.
function parseTable($, table) {
  const rows = $(table).find('tr');
  const head = rows
    .first()
    .find('th,td')
    .map((i, c) => $(c).text().trim().replace(/\s+/g, ' '))
    .get();
  const out = [];
  rows.slice(1).each((i, tr) => {
    const cellEls = $(tr).find('th,td');
    const cells = cellEls.map((j, c) => $(c).text().trim().replace(/\s+/g, ' ')).get();
    if (!cells.length || !cells[0]) return;
    const row = { _links: {} };
    head.forEach((h, k) => {
      row[h] = cells[k] ?? '';
      const href = cellEls.eq(k).find('a[href]').attr('href');
      if (href) row._links[h] = new URL(href, 'https://sfrecpark.org').href;
    });
    out.push(row);
  });
  return out;
}

// ---- posted schedule PDFs ---------------------------------------------------
// Parse a court-schedule poster (e.g. Moscone's) into a compact open-play string.
// The template is a weekly grid: 7 day rows top-to-bottom Mon..Sun, each
// pickleball open-play block an "OPEN GROUP PLAY" label under a "PICKLEBALL"
// heading with its time range beside it. We pull positioned text via pdfjs-dist
// (build-only devDep, same as build-pools), cluster items into day rows by
// y-gaps, and take the time ranges x-aligned with each OPEN GROUP PLAY label.
// Returns null when the PDF has no text layer (a flattened image poster).
const TIME_RE = /^\d{1,2}(:\d{2})?(AM|PM)?\s*-\s*\d{1,2}(:\d{2})?(AM|PM)$/i;

// "7AM" / "10:30 a.m." → minutes from midnight; a missing meridiem borrows the
// range's end meridiem ("3-6PM" → 3PM).
function toMin(s, fallbackMer) {
  const m = String(s).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let h = +m[1] % 12;
  if (/^p/i.test(m[3] || fallbackMer || '')) h += 12;
  return h * 60 + (+m[2] || 0);
}

// "7AM-3PM" / "10:30 a.m. to 1:30 p.m." → [startMin, endMin], or null.
function parseRange(str) {
  const m = String(str).match(
    /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/i
  );
  if (!m) return null;
  const endMer = (m[2].match(/a\.?m\.?|p\.?m\.?/i) || [''])[0];
  const s = toMin(m[1], endMer);
  const e = toMin(m[2]);
  return s != null && e != null && e > s ? [s, e] : null;
}

// Explicit directory-cell text like "Tuesdays and Thursdays, 10:30 a.m. to
// 1:30 p.m." → a 7-day week (one shared time range), or null when unparseable.
const DAY_TOKENS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function weekFromText(text) {
  const days = new Set();
  const re = /\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi;
  let m;
  while ((m = re.exec(text))) days.add(DAY_TOKENS[m[1].toLowerCase()]);
  const range = parseRange(text);
  if (!days.size || !range) return null;
  const week = Array.from({ length: 7 }, () => []);
  for (const d of days) week[d] = [range];
  return week;
}

async function openPlayFromPdf(url) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const items = tc.items
    .map((it) => ({ s: it.str.trim().replace(/\s+/g, ' '), x: it.transform[4], y: it.transform[5] }))
    .filter((it) => it.s);
  if (!items.length) return null; // image-only poster — caller falls back

  // Cluster into horizontal bands: rows of the grid sit far apart in y compared
  // to the lines within one block.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const bands = [];
  for (const it of sorted) {
    const band = bands[bands.length - 1];
    if (band && band[band.length - 1].y - it.y < 60) band.push(it);
    else bands.push([it]);
  }
  // Day rows are the bands that contain schedule times (title/footer bands don't).
  const dayBands = bands.filter((b) => b.some((it) => TIME_RE.test(it.s)));
  if (dayBands.length !== 7) {
    throw new Error(`expected 7 day rows in ${url}, found ${dayBands.length} — poster layout changed?`);
  }

  // Per day: time ranges x-aligned with a standalone "PICKLEBALL" heading — the
  // open-group-play blocks. Reservable blocks are headed "TENNIS OR PICKLEBALL"
  // (never plain PICKLEBALL), and as a guard we skip a heading whose block
  // carries an x-aligned RESERVABLE tag. (Most blocks also say "OPEN GROUP
  // PLAY", but e.g. Moscone's Sunday block omits it, so it can't be the anchor.)
  // Rows read top-to-bottom Mon..Sun; emit Sun-first to match court.dropins.
  // Blocks carry display tags: 'openplay' (standalone PICKLEBALL heading) and
  // 'reservable' (shared TENNIS OR PICKLEBALL heading). Tennis-only windows
  // simply don't appear, and court-specific evening slots (icon-only in the
  // poster) ride the facility note — so the week is the court's complete
  // pickleball hours and REPLACES the generic daylight dropins (playWeek).
  const week = Array.from({ length: 7 }, () => []);
  dayBands.forEach((band, i) => {
    const blocks = [];
    const collect = (headRe, tag, tol) => {
      for (const h of band.filter((it) => headRe.test(it.s))) {
        if (tag === 'openplay' && band.some((it) => /^reservable$/i.test(it.s) && Math.abs(it.x - h.x) < tol)) continue;
        for (const it of band) {
          if (TIME_RE.test(it.s) && Math.abs(it.x - h.x) < tol) {
            const r = parseRange(it.s);
            if (r) blocks.push([r[0], r[1], tag]);
          }
        }
      }
    };
    collect(/^pickleball$/i, 'openplay', 60);
    collect(/^tennis\s*or\s*pickleball$/i, 'reservable', 120);
    week[(i + 1) % 7] = blocks.sort((a, b) => a[0] - b[0]);
  });
  return week.some((d) => d.length) ? week : null;
}

// Our outdoor courts, indexed for name matching, with the sports each offers.
function ourCourts() {
  const outdoor = require('../data/outdoor-courts.js').default;
  const offers = (c, s) => (c.dropins?.[s] || []).some((d) => d && d.length);
  return outdoor.map((c) => ({
    id: c.id,
    name: c.name,
    n: norm(c.name),
    sports: ['tennis', 'pickleball'].filter((s) => offers(c, s)),
  }));
}

// Match a directory facility (for a given sport) to one of our courts. Sport-gated;
// prefers an alias, then exact name, then the closest name that contains the
// facility name as whole words (fewest extra tokens wins).
function matchCourt(facility, sport, courts) {
  const fn = norm(facility);
  if (ALIASES[fn]) return courts.find((c) => c.id === ALIASES[fn]) || null;
  const pool = courts.filter((c) => c.sports.includes(sport));
  let best = null,
    bestScore = Infinity;
  for (const c of pool) {
    if (c.n === fn) return c; // exact
    const contains =
      c.n === fn ||
      c.n.startsWith(fn + ' ') ||
      c.n.endsWith(' ' + fn) ||
      c.n.includes(' ' + fn + ' ');
    if (!contains || fn.length < 4) continue;
    const extra = c.n.split(' ').length - fn.split(' ').length; // fewer extra words = closer
    if (extra < bestScore) {
      bestScore = extra;
      best = c;
    }
  }
  return best;
}

// ---- pickleballsf.com enrichment --------------------------------------------
// The community-maintained venue pages provide what SFRP doesn't publish: a
// short human description of each location. SFRP stays CANONICAL for schedules
// — pickleballsf can lag (their Buena Vista page still referenced Spotery,
// SFRP's pre-rec.us booking system) — so schedule-looking text from these
// pages is only LOGGED as an advisory cross-reference, never written to data.
// Keyed by pickleballsf URL slug (stabler than page titles) -> our court id.
const PBSF_BASE = 'https://pickleballsf.com/';
const PBSF_VENUES = {
  'buena-vista-park': 'buena-vista-park-outdoor',
  'christopher-playground': 'george-christopher-playground-outdoor',
  'crocker-amazon': 'crocker-amazon-playground-outdoor',
  'jackson-playground': 'jackson-playground-outdoor',
  'larsen-playground-pb-court-hub': 'carl-larsen-park-outdoor',
  'louis-sutter-pickleball-complex': 'louis-sutter-playground-outdoor',
  'moscone-playground': 'moscone-rec-center-outdoor',
  'parkside-square-courts': 'parkside-square-outdoor',
  'presidio-wall': 'presidio-wall-playground-outdoor',
  'richmond-playground': 'richmond-playground-outdoor',
  'rossi-playground': 'angelo-j-rossi-playground-outdoor',
  'stern-grove-playground': 'sigmund-stern-recreation-grove-outdoor',
  'upper-noe-recreation-center': 'upper-noe-rec-center-outdoor',
};

// Transcribed descriptions for venue pages whose content is only short bullet
// lists the extractor can't use (composed from those bullets; re-check the
// pages occasionally).
const PBSF_DESC_FALLBACK = {
  'larsen-playground-pb-court-hub':
    'Dedicated drop-in pickleball hub — "next up" paddle queues when busy. Bring your own paddle and balls; no fees. Play during daylight hours (no play before 7:30 AM).',
  'crocker-amazon': '4 permanent pickleball courts, reservable on rec.us.',
};

const dehtmlText = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&#0?38;|&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#039;/g, "'")
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function pbsfEnrich(out) {
  let added = 0;
  for (const [slug, courtId] of Object.entries(PBSF_VENUES)) {
    const entry = out[courtId] && out[courtId].pickleball;
    if (!entry) continue;
    try {
      const html = await getHtml(PBSF_BASE + slug + '/');
      const paras = [...html.matchAll(/<(p|li)[^>]*>([\s\S]*?)<\/\1>/g)]
        .map((m) => dehtmlText(m[2]))
        .filter(Boolean);
      // Description: the first substantive paragraph (venue pages lead with one).
      // Skip link plugs, the site's boilerplate mission blurb, and divider rows;
      // prefer text that's actually about the courts over e.g. parking tips.
      const candidates = paras.filter(
        (p) =>
          p.length >= 80 &&
          !/https?:/i.test(p) &&
          !/pickleball community is a friendly/i.test(p) &&
          (p.match(/[a-z]/gi) || []).length / p.length > 0.6
      );
      const desc = candidates.find((p) => /pickleball|court/i.test(p)) || candidates[0];
      if (desc) {
        // Drop a lead sentence that references the source page's own layout
        // ("Dedicated hours for pickleball below. …") — meaningless in our card.
        const cleaned = desc
          .replace(/^[^.!?]*\b(below|above)\b[^.!?]*[.!?]\s*/i, '')
          // ...and a trailing lead-in that ran into a list on the source page
          // ("Open play hours are:") — a dangling colon reads broken in our card.
          .replace(/\s*[^.!?]*:$/, '');
        let finalDesc = cleaned.length >= 40 ? cleaned : desc;
        // Append one practical tip (parking / restrooms / entrance) when the
        // page has one and it fits — e.g. Louis Sutter's driveway directions.
        const practical = candidates.find(
          (p) => p !== desc && /parking|restroom|entrance|water fountain/i.test(p)
        );
        if (practical && (finalDesc + practical).length <= 330) {
          finalDesc += ' ' + practical.replace(/\s*[^.!?]*:$/, '');
        }
        entry.desc =
          finalDesc.length > 340
            ? finalDesc.slice(0, 337).replace(/[,;\s]+\S*$/, '') + '…'
            : finalDesc;
        added++;
      } else if (PBSF_DESC_FALLBACK[slug]) {
        entry.desc = PBSF_DESC_FALLBACK[slug];
        added++;
      }
      // Advisory cross-reference: surface their schedule text beside ours so a
      // human running the build can spot drift — SFRP data is not overwritten.
      const sched = paras.filter((p) => /open play|drop-?in|group play/i.test(p) && /\d/.test(p));
      if (sched.length && (entry.playWeek || entry.openPlayWeek)) {
        console.log(`  ✎ pickleballsf x-ref for ${courtId}:`);
        for (const s of sched.slice(0, 3)) console.log(`      "${s.slice(0, 140)}"`);
      }
    } catch (e) {
      console.log(`  ⚠ pickleballsf ${slug}: ${e.message}`);
    }
  }
  console.log(`  pickleballsf: descriptions for ${added} courts`);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function build() {
  const courts = ourCourts();
  const out = {}; // courtId -> { sport: {...} }
  const misses = [];

  // --- Tennis ---
  const $t = cheerio.load(await getHtml(SOURCES.tennis));
  for (const r of parseTable($t, $t('table').first())) {
    const facility = r['Facility'];
    const court = matchCourt(facility, 'tennis', courts);
    const total = num(r['Total courts']);
    if (!court) {
      if (total > 0) misses.push(`tennis: ${facility}`);
      continue;
    }
    const tAdj = TENNIS_ADJUST[norm(facility)];
    (out[court.id] ||= {}).tennis = {
      total,
      reservable: num(r['Reservable courts']),
      walkup: num(r['Walk-up courts']),
      lights: yes(r['Lights']),
      restrooms: yes(r['Restrooms']),
      ...(tAdj && tAdj.playWeek ? { playWeek: tAdj.playWeek } : {}),
      ...(tAdj && tAdj.note ? { note: tAdj.note } : {}),
    };
  }

  // --- Pickleball (outdoor table only; indoor gym courts aren't in our data) ---
  const $p = cheerio.load(await getHtml(SOURCES.pickleball));
  for (const r of parseTable($p, $p('table').first())) {
    const facility = r['Facility'];
    const court = matchCourt(facility, 'pickleball', courts);
    const total = num(r['Total courts']);
    if (!court) {
      if (total > 0) misses.push(`pickleball: ${facility}`);
      continue;
    }
    const nets = (r['Nets*'] || r['Nets'] || '').trim();
    // "Open Play" column: a court count (dedicated open-play courts), explicit
    // times ("Tues/Thurs 10:30am-1:30pm"), or "See schedule" linking the court's
    // posted schedule PDF — parsed when it has a text layer, else the transcribed
    // fallback above.
    const openKey = Object.keys(r).find((k) => /open\s*play/i.test(k) && k !== '_links');
    const openRaw = openKey ? String(r[openKey]).trim() : '';
    const openPlayCourts = /^\d+$/.test(openRaw) ? num(openRaw) : 0;
    let openPlayWeek = null;
    let pbPlayWeek = null; // authoritative pickleball hours replacing base dropins
    let openPlayTimes = openRaw && !/^\d+$/.test(openRaw) ? openRaw : null;
    if (openPlayTimes && /^(see\s+)?schedule/i.test(openPlayTimes)) {
      const link = openKey && r._links[openKey];
      if (link) {
        try {
          pbPlayWeek = await openPlayFromPdf(link);
        } catch (e) {
          console.log(`  ⚠ ${facility} schedule PDF: ${e.message}`);
        }
      }
      if (!pbPlayWeek) {
        const fb = PDF_FALLBACK[norm(facility)];
        openPlayWeek = (fb && fb.week) || null;
        pbPlayWeek = (fb && fb.playWeek) || null;
        console.log(
          `  ↺ ${facility}: open-play from ${fb ? 'transcribed fallback' : 'nowhere (left as-is)'}` +
            (link ? ` — poster is not machine-readable, re-verify against ${link}` : '')
        );
      }
    } else if (openPlayTimes) {
      // Explicit times right in the cell (e.g. Upper Noe) — structure when parseable.
      openPlayWeek = weekFromText(openPlayTimes);
    }
    if (openPlayWeek || pbPlayWeek) openPlayTimes = null; // structured data supersedes the string
    const note = OPEN_PLAY_NOTES[norm(facility)] || null;
    (out[court.id] ||= {}).pickleball = {
      total,
      reservable: num(r['Reservable']),
      walkup: num(r['Walk-up shared use']),
      lights: yes(r['Lights']),
      restrooms: yes(r['Restrooms']),
      nets: nets || null,
      ...(openPlayCourts > 0 ? { openPlayCourts } : {}),
      ...(openPlayWeek ? { openPlayWeek } : {}),
      ...(pbPlayWeek ? { playWeek: pbPlayWeek } : {}),
      ...(openPlayTimes ? { openPlayTimes } : {}),
      ...(note ? { note } : {}),
    };
  }

  await pbsfEnrich(out);

  let count = 0;
  for (const id of Object.keys(out)) count += Object.keys(out[id]).length;
  if (count < MIN_COURTS_OK) {
    throw new Error(`only ${count} directory readings (min ${MIN_COURTS_OK}) — page shape may have changed`);
  }
  if (misses.length) console.log(`  ⚠ unmatched directory rows:\n    ${misses.join('\n    ')}`);
  return { out, count };
}

function render(directory, generatedAt) {
  const ids = Object.keys(directory).sort();
  const body = ids
    .map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(directory[id])},`)
    .join('\n');
  return `// AUTO-GENERATED by scripts/build-court-directory.js — do not edit by hand.
// Regenerate with: npm run build:directory
// Generated: ${generatedAt}
//
// Per-court facility facts from SF Rec & Park's tennis + pickleball court
// directories. Map of our court id -> { sport: { total, reservable, walkup,
// lights, restrooms, [dedicated], [nets], [openPlayCourts], [openPlayTimes] } }.
// openPlayCourts = dedicated open-play court count; openPlayWeek = shared-use
// open-play blocks as a dropins-style week (0=Sun..6=Sat, [startMin, endMin] —
// parsed from the posted schedule PDF each "See schedule" row links, or from
// explicit cell text; transcribed fallback for image-only posters); openPlayTimes
// = display-only string when the times can't be structured; note = court-split /
// reservation nuance shown under the card's schedule; desc = short location
// description from pickleballsf.com (community site — descriptions only, never
// schedules); playWeek (tennis) =
// authoritative week that REPLACES the court's dropins for that sport at runtime
// (poster covers every court, e.g. Presidio Wall). Merged onto courts by
// lib/useCourts.js; the card folds openPlayWeek into the weekly schedule rows
// tagged "(open play)".

export const DIRECTORY = {
${body}
};

export default DIRECTORY;
`;
}

async function main() {
  console.log('Fetching SF Rec & Park court directories…');
  let directory, source;
  try {
    const { out, count } = await build();
    directory = out;
    source = 'live';
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ directory, fetchedAt: new Date().toISOString() }, null, 2) + '\n'
    );
    console.log(`  parsed ${count} court-sport entries`);
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.directory) {
      throw new Error(`fetch failed (${e.message}) and no cache — data/court-directory.js left unchanged`);
    }
    directory = cache.directory;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.writeFileSync(OUT_FILE, render(directory, new Date().toISOString()));
  console.log(`\n✅ Wrote ${Object.keys(directory).length} courts to data/court-directory.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
