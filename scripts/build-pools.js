#!/usr/bin/env node
/*
 * Build data/pools.js — SF Rec & Park public swimming pools + their weekly swim
 * schedules. Run with:  npm run build:pools
 *
 * Why this looks different from the other builds: the pools' schedules don't live
 * in an API or an HTML table — each pool posts a *seasonal PDF* (re-issued every
 * few months) on its facility page. So the pipeline is:
 *   1. For each known pool (stable facility id), GET its sfrecpark.org page and
 *      find the current schedule PDF link(s) (text-labeled DocumentCenter docs,
 *      excluding the shared deck-rules PDFs).
 *   2. Download each PDF and pull positioned text via pdfjs-dist.
 *   3. Reconstruct the weekly grid geometrically: merge text fragments into row
 *      cells, map cells to day columns by x, pair each activity label with the
 *      time below it, and classify the label into a session `kind`.
 *   4. Emit sessions[dow] = [{ kind, start, end }] (0=Sun..6=Sat, minutes from
 *      midnight — same convention as the court schedule data).
 *
 * Coordinates, addresses and phones come from the curated META table below (the
 * facility pages don't expose lat/lng, and there are only nine pools). Fees are
 * a single city-wide schedule (POOL_FEES) refreshed by hand from the aquatics
 * fee notice — they change ~annually, not seasonally.
 *
 * Resilience mirrors the other builds: live -> last-good cache (pools-cache.json);
 * a fetch/parse failure (or a suspiciously empty result) keeps the existing data.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('./fetch-timeout');

const BASE = 'https://sfrecpark.org';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_FILE = path.join(__dirname, 'pools-cache.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'pools.js');
const MIN_OK_POOLS = 7; // abort (keep last-good) if fewer than this scrape with sessions
const DECK_RULES = new Set(['/DocumentCenter/View/19018', '/DocumentCenter/View/19019', '/DocumentCenter/View/19020']);

// Curated facts per pool. `slug` is the stable sfrecpark facility path; the
// schedule PDF link is discovered live from that page each run. Coords were
// geocoded once (pages have no lat/lng); addresses/phones are hand-verified.
// `season` is only a FALLBACK now — the live value is read off the schedule PDF's
// own link text (seasonFromLabel), so it tracks the poster the sessions came from.
const META = [
  { id: 'pool-balboa', slug: 'Balboa-Pool-212', name: 'Balboa Pool', address: 'San Jose Ave & Havelock St, San Francisco, CA 94112', lat: 37.726134, lng: -122.443381, phone: '(415) 831-6805', season: 'Jun 9 – Aug 15' },
  { id: 'pool-coffman', slug: 'Coffman-Pool-213', name: 'Coffman Pool', address: '1701 Visitacion Ave, San Francisco, CA 94134', lat: 37.713221, lng: -122.4158, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-garfield', slug: 'Garfield-Pool-214', name: 'Garfield Pool', address: '1271 Treat Ave, San Francisco, CA 94110', lat: 37.750098, lng: -122.412027, phone: '(628) 652-7221', season: 'Jun 7 – Aug 13' },
  { id: 'pool-hamilton', slug: 'Hamilton-Pool-215', name: 'Hamilton Pool', address: '1900 Geary Blvd, San Francisco, CA 94115', lat: 37.784566, lng: -122.435086, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-mlk', slug: 'Martin-Luther-King-Jr-Pool-216', name: 'Martin Luther King Jr. Pool', address: '5701 3rd St, San Francisco, CA 94124', lat: 37.725545, lng: -122.393722, phone: '(415) 288-2807', season: 'Jun 9 – Aug 15' },
  { id: 'pool-mission', slug: 'Mission-Community-Pool-217', name: 'Mission Community Pool', address: '1 Linda St, San Francisco, CA 94110', lat: 37.759653, lng: -122.422606, phone: null, season: 'Jun 9 – Aug 15' },
  { id: 'pool-northbeach', slug: 'North-Beach-Pool-218', name: 'North Beach Pool', address: '661 Lombard St, San Francisco, CA 94133', lat: 37.802705, lng: -122.412437, phone: null, season: 'Jun 6 – Aug 10', note: 'Two pools under one roof: a warm pool and a cool pool.' },
  { id: 'pool-rossi', slug: 'Rossi-Pool-219', name: 'Rossi Pool', address: '600 Arguello Blvd, San Francisco, CA 94118', lat: 37.779065, lng: -122.45828, phone: '(628) 652-7230', season: 'Jun 7 – Aug 13' },
  { id: 'pool-sava', slug: 'Sava-Pool-220', name: 'Sava Pool', address: '1149 Wawona St (19th Ave), San Francisco, CA 94116', lat: 37.737803, lng: -122.475897, phone: null, season: 'Jun 30 – Aug 15' },
];

// City-wide aquatics fees (sfrecpark.org/DocumentCenter/View/29318). Update by
// hand when the annual fee notice changes — they're not seasonal.
const FEES = {
  effective: '2026-07-01',
  source: `${BASE}/DocumentCenter/View/29318`,
  note: 'FY26-27 CPI +2.18%',
  groups: [
    { id: 'child', label: 'Children (0–17)', dropIn: 2, passes: [['Monthly (no lessons)', 27], ['Summer pass', 34], ['Yearly swim pass', 285]] },
    { id: 'adult', label: 'Adults (18–64)', dropIn: 8, passes: [['Rec swim – 10 visits', 76], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 101], ['Monthly (no lessons)', 111], ['Yearly swim pass', 1007]] },
    { id: 'senior', label: 'Seniors (65+)', dropIn: 7, passes: [['Rec swim – 10 visits', 35], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 52], ['Monthly (no lessons)', 59], ['Yearly swim pass', 672]] },
    { id: 'medical', label: 'Economic need (Medi-Cal)', dropIn: 7, passes: [['Rec swim – 10 visits', 35], ['Water exercise drop-in', 12], ['Water exercise – 10 visits', 52], ['Monthly (no lessons)', 62], ['Yearly swim pass', 672]] },
  ],
};

const KIND_ORDER = ['lap', 'family', 'senior', 'youth', 'lessons', 'adult_lessons', 'parent_child', 'special_olympics', 'exercise', 'camp', 'school', 'rental', 'other'];

// ---- PDF schedule parsing -------------------------------------------------

const DOW = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 };
// A bare "p"/"a" meridiem counts too — North Beach prints "1:45pm-4:30p".
const TIME = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|[ap](?![a-z]))?\s*[-–]\s*((\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|[ap](?![a-z]))|noon)/i;
const KINDS = [
  [/parent\s*(&|and|\/)?\s*tots?|piranha|parent.?child/i, 'parent_child'],
  [/adult\s*(swim\s*)?lesson/i, 'adult_lessons'],
  [/learn\s*-?\s*to\s*-?\s*swim|\blts\b|swim\s*lesson|youth\s*lesson|pre-?school|swim\s*team/i, 'lessons'],
  // Team training for registered athletes with intellectual disabilities —
  // neither lessons nor drop-in, so it gets its own name.
  [/special\s*olympic/i, 'special_olympics'],
  [/water\s*exercise|self.?guided|deep\s*water/i, 'exercise'],
  [/senior|therapy/i, 'senior'],
  [/rec\/?family|family|recreation|rec\s*swim/i, 'family'],
  [/lap/i, 'lap'],
  // SFUSD classes / school groups hold the pool for a school — not public swim,
  // but worth naming: it's why the pool is busy with nobody you can join.
  [/sfusd|school\s*group/i, 'school'],
  [/rental|masters|synchro|hockey|youth\s*team/i, 'rental'],
  [/sfrpd|\bcamp\b/i, 'camp'],
];
// Every kind a label names. One PDF cell often lists several programs sharing
// the slot in different lanes ("Parent & Tot(1)/ Senior Swim(3)", "Family/Lap
// Swim", "Sfusd/Rec Swim"), and taking only the first match dropped the rest.
// Parentheticals are lane annotations, not programs — "Lap Swim (Lap/Therapy)"
// is lap swim, not senior therapy, and "Rental (Youth Teams)" is a rental, not
// a swim team — so they're stripped before matching.
const kindsOf = (s) => {
  const bare = s.replace(/\([^)]*\)?/g, ' ');
  const ks = KINDS.filter(([re]) => re.test(bare)).map(([, k]) => k);
  // "Adult Swim Lessons" is adult lessons, not also kids' lessons, and "Senior
  // Lap Swim" is a senior session, not lap swim anyone can join.
  const drop = new Set();
  if (ks.includes('adult_lessons')) drop.add('lessons');
  if (/senior\s*lap/i.test(bare)) drop.add('lap');
  return ks.filter((k) => !drop.has(k));
};
// Closure and staffing notes printed inside the grid ("Closed every 4th
// Thursday of / the Month for Training / 8/27, 9/24, 10/22", "All city pools
// will be closed on December 12", a supervisor's name). They
// sit above a time like any label, so without this each fragment became its
// own "Other" session — a phantom session at the very hour the pool is shut.
const CLOSURE_NOTE =
  /closed|in-?service|training|\bstaff\b|supervisor|will be|of the month|^(the )?month\b|^\d{1,2}\/\d{1,2}|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d|^(from|for|on|and)\b|^((from|for|on|and)\s*)+$/i;
// Cells that are notes/legend/footer, not activity labels.
const isNote = (s) =>
  /^\(|notes?:|pool info|^_+$|^•|^\(shallow|^\(deep|^\(main|^\(small|^\(water|^\(1 |^\(advanced|^\(beg|temperature|@|\.org|francisco|\bave\b|\bblvd\b|\bstreet\b|treat|geary|lombard|arguello|wawona/i.test(s) ||
  CLOSURE_NOTE.test(s) ||
  s.length < 3;

const toMin = (h, m, ap, nextAp) => {
  h = +h;
  m = m ? +m : 0;
  ap = (ap || '').replace(/\./g, '').toLowerCase();
  if (!ap && nextAp) ap = nextAp;
  if (ap.length === 1) ap += 'm';
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h * 60 + m;
};
function parseTime(s) {
  s = s.replace(/\bnoon\b/i, '12:00pm');
  const m = s.match(TIME);
  if (!m) return null;
  const endAp = (m[7] || '').replace(/\./g, '').toLowerCase() || (/noon/i.test(m[4]) ? 'pm' : '');
  let start = toMin(m[1], m[2], m[3], endAp);
  let end = toMin(m[5] || 12, m[6], m[7] || '', endAp);
  // Borrowing the end's meridiem can invert a range that straddles noon
  // ("11:30–12:30 PM" must not read as 11:30 PM), and a 12:xx end after an
  // AM start is PM even when the PDF says otherwise. Prefer the reading that
  // makes the session run forward.
  if (end <= start) {
    if (!m[3] && start >= 720 && start - 720 < end) start -= 720;
    else if (end + 720 > start && end + 720 <= 1440) end += 720;
  }
  return end > start ? { start, end } : null;
}

// Merge per-glyph text fragments on the same line into row cells (dropping the
// right-side notes panel at x>760), so split words/times become whole strings.
// Once the day columns are known, `sameCol` stops a merge across a column
// boundary: on tightly set posters (MLK, Sava, Garfield) neighbouring days sit
// 12–35pt apart, so a gap threshold alone fused the same session in four day
// columns into one cell, parsed it once, and the other days silently lost it.
// Gaps use each item's real rendered width, not a per-character estimate.
const MERGE_GAP = 20;
function mergeRows(items, sameCol = () => true, maxX = 760) {
  const rows = [];
  items
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .forEach((it) => {
      let r = rows.find((r) => Math.abs(r.y - it.y) <= 4);
      if (!r) {
        r = { y: it.y, its: [] };
        rows.push(r);
      }
      r.its.push(it);
    });
  return rows.map((r) => {
    r.its.sort((a, b) => a.x - b.x);
    const cells = [];
    let cur = null;
    let prev = null;
    let lastEnd = null;
    for (const it of r.its) {
      if (cur && it.x - lastEnd < MERGE_GAP && sameCol(prev, it)) cur.s += (it.x - lastEnd > 3 ? ' ' : '') + it.s;
      else {
        cur = { x: it.x, s: it.s };
        cells.push(cur);
      }
      prev = it;
      lastEnd = it.x + (it.w || it.s.length * 5.5);
    }
    return { y: r.y, cells: cells.filter((c) => c.x < maxX) };
  });
}

// One PDF's positioned text -> { dow: [{kind,start,end}] }.
function parseGrid(items) {
  const dkey = (s) => DOW[s.toUpperCase().replace(/[^A-Z]/g, '')];
  // Day names are single items, so the header is found before columns exist.
  const heads = items.filter((it) => dkey(it.s) !== undefined);
  const hdrY = mergeRows(heads).find((r) => r.cells.length >= 2)?.y;
  if (hdrY == null) return null;
  const hdrItems = heads.filter((it) => Math.abs(it.y - hdrY) <= 4).sort((a, b) => a.x - b.x);
  // Column bands split at the midpoints between header centres; text is
  // centred in its cell, so an item's centre says which day it belongs to.
  const centre = (it) => it.x + (it.w || it.s.length * 5.5) / 2;
  const cuts = hdrItems.slice(1).map((h, i) => (centre(hdrItems[i]) + centre(h)) / 2);
  const band = (it) => cuts.filter((c) => centre(it) > c).length;
  const rows = mergeRows(items, (a, b) => band(a) === band(b));
  const hdr = rows.find((r) => Math.abs(r.y - hdrY) <= 4);
  const cols = hdr.cells
    .filter((c) => dkey(c.s) !== undefined)
    .map((c) => ({ dow: dkey(c.s), x: c.x }))
    .sort((a, b) => a.x - b.x);
  const colOf = (x) => {
    let best = null;
    let bd = 80;
    for (const c of cols) {
      const d = Math.abs(c.x - x);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  const body = rows.filter((r) => r.y < hdr.y - 6);
  const notes = [];
  const perCol = {};
  cols.forEach((c) => (perCol[c.dow] = []));
  for (const r of body)
    for (const cell of r.cells) {
      const c = colOf(cell.x);
      if (c) perCol[c.dow].push({ y: r.y, s: cell.s });
    }
  const out = {};
  for (const c of cols) {
    const cells = perCol[c.dow].sort((a, b) => b.y - a.y);
    notes.push(...gridClosureNotes(cells));
    const sess = [];
    let buf = [];
    for (const cell of cells) {
      const t = parseTime(cell.s);
      if (t) {
        // Strip EVERY time on the cell, not just the one parsed — a leftover
        // "12:30pm – 3:30pm" was being read as an unclassifiable label.
        const inline = cell.s.replace(new RegExp(TIME.source, 'gi'), '').replace(/noon/gi, '').trim();
        const labels = [...new Set([...buf.map((b) => b.s), inline])].filter((x) => x && !isNote(x) && /[a-z]{3}/i.test(x));
        const kinds = new Set(labels.flatMap(kindsOf));
        for (const k of kinds) sess.push({ kind: k, start: t.start, end: t.end });
        // A label nothing recognises is usually the tail of one that was
        // ("Senior/Therapy/ Access" + "Swim"), so it only becomes an "other"
        // session when the slot has no recognised program at all — and then it
        // keeps its own text, so the card can show what the poster says.
        if (!kinds.size) for (const L of labels) sess.push({ kind: 'other', label: L, start: t.start, end: t.end });
        buf = [];
      } else buf.push({ s: cell.s });
    }
    const seen = new Set();
    out[c.dow] = sess
      .filter((s) => {
        // A session that runs backwards or longer than 10h is a misparse of the
        // PDF grid — publish nothing rather than a wrong time.
        if (s.end <= s.start || s.end - s.start > 600) {
          console.warn(`    ⚠ dropping implausible session dow=${c.dow} ${s.kind} ${s.start}–${s.end}`);
          return false;
        }
        const k = s.kind + (s.label || '') + s.start + s.end;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.start - b.start);
  }
  // The notes panel right of the grid, split into bullets.
  const notesHead = items.find((it) => /^notes\s*:?$/i.test(it.s.trim()));
  if (notesHead) notes.push(...panelNotes(items.filter((it) => it.x >= notesHead.x - 2)));
  return { sessions: out, notes };
}


// ---- Closures -------------------------------------------------------------
//
// Every poster lists the dates a pool is shut — holidays, a multi-week
// maintenance window, a 12–2 staff training on the 4th Thursday — and none of
// it reaches the weekly `sessions` grid, which is weekday-shaped and knows no
// dates. So the card said "Open" on Labor Day and all through North Beach's
// three-week maintenance closure. Closures come from two places on the page:
// the notes panel (bullets) and notes printed inside grid cells, which often
// carry dates the panel doesn't (Coffman's in-service Saturdays, Sava's
// training Thursdays). Output per pool:
//   closures: [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', start?, end?, reason }]
// start/end are minutes-from-midnight for a partial closure (absent = all day);
// reason is 'holiday' | 'maintenance' | 'training' | null.

// No word boundaries: poster text arrives glued together ("will beclosedon").
const CLOSURE_WORD = /clos(ed|ure|ing)|in-?service|mainten|maintence/i;
// Re-space glued text ("onOctober", "CLOSEDDecember", "from9am", "8/22/26and")
// so dates and words can be matched at all.
const respace = (t) =>
  t
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/(\d[ap])(for|on|to|and|in)\b/gi, '$1 $2') // "12p-2pfor"
    .replace(/(\d)([a-z]{2,})/gi, '$1 $2');
const HOLIDAY_NAMES = [
  [/labor\s*day/i, 'Labor Day'],
  [/indigenous/i, "Indigenous Peoples' Day"],
  [/veteran/i, 'Veterans Day'],
  [/thanksgiving/i, 'Thanksgiving'],
  [/christmas/i, 'Christmas'],
  [/new\s*year/i, "New Year's Day"],
  [/juneteenth/i, 'Juneteenth'],
  [/independence/i, 'Independence Day'],
  [/memorial\s*day/i, 'Memorial Day'],
];
const MONTH_IDX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DOW_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
// "Sept. 7", "November 26th", "September 7, 2026", "8/27", "12/12/26".
const DATE_TOKEN =
  /\b(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})(?:\s?(?:st|nd|rd|th)\b)?(?:,?\s*(20\d\d))?|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)(?![\d:])/gi;
const TIME_G = new RegExp(TIME.source, 'gi');
const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const DAY_MS = 86400000;
const timeOnly = (s) =>
  !!parseTime(s) && !s.replace(TIME_G, '').replace(/\([^)]*\)|noon|[\s.\-–]/gi, '');
const dateList = (s) => /^\(?[\d\s\/,&]*(and)?[\d\s\/,&]*\)?$/i.test(s.trim()) && /\d\/\d/.test(s);

// The poster's own season as UTC dates ("Sep 1 – Dec 12" + the year printed
// on the page), so a bare "9/24" gets a year and a stray number far outside
// the season is rejected rather than published.
function seasonBounds(label, items) {
  const posted = seasonFromLabel(label);
  const yearHit = [String(label || ''), ...items.map((i) => i.s)].join(" ").match(/(?<!\d)(20\d\d)(?!\d)/);
  const year = yearHit ? +yearHit[1] : new Date().getFullYear();
  if (!posted) return null;
  const [a, b] = posted.split(' – ').map((x) => {
    const [mon, day] = x.split(' ');
    return [MONTH_IDX[mon.toLowerCase()], +day];
  });
  const from = utc(year, a[0], a[1]);
  let to = utc(year, b[0], b[1]);
  if (to < from) to = utc(year + 1, b[0], b[1]);
  return { from, to };
}

// Panel text -> one note per bullet. A new bullet starts at "•", at a heading,
// or after a tall vertical gap (Rossi prints its maintenance closure as a
// free-standing line under the contact block).
function panelNotes(items) {
  const rows = mergeRows(items.filter((i) => !/^(st|nd|rd|th)$/i.test(i.s.trim())), undefined, Infinity);
  const notes = [];
  let cur = null;
  let lastY = null;
  for (const r of rows) {
    const text = r.cells.map((c) => c.s).join(' ').trim();
    const heading = /^(cost|notes|pool info)\s*:?/i.test(text);
    if (!cur || heading || text.startsWith('•') || lastY - r.y > 22) {
      cur = { text: '' };
      notes.push(cur);
    }
    cur.text += ' ' + text.replace(/^•\s*/, '');
    lastY = r.y;
  }
  return notes.map((n) => ({ text: n.text.trim() })).filter((n) => CLOSURE_WORD.test(n.text));
}

// Notes inside one day column's cells. The note's hours are either written in
// it ("Closed for In-Service August 22, 9am-1pm"), or they are the time of the
// session it annotates — printed just below the note ("Lap Swim / Closed every
// 4th Thursday / 11:30am-2:00pm") or just above it ("Lap Swim / 11:30am-1:00pm
// / Closed every 4th Thursday"). A note under a session label is `borrowed`:
// it closes that session, and the pool may say more precisely elsewhere when.
function gridClosureNotes(cells) {
  const notes = [];
  const isLabel = (s) => kindsOf(s).length > 0;
  const skippable = (s) => isNote(s) && !CLOSURE_WORD.test(s) && !timeOnly(s);
  for (let i = 0; i < cells.length; i++) {
    if (!CLOSURE_WORD.test(cells[i].s)) continue;
    let j = i + 1;
    while (j < cells.length && !isLabel(cells[j].s) && !timeOnly(cells[j].s)) j++;
    let text = cells.slice(i, j).map((c) => c.s).join(' ');
    let time = null;
    let borrowed = false;
    if (!TIME.test(text)) {
      let k = i - 1;
      while (k >= 0 && skippable(cells[k].s)) k--;
      if (j < cells.length && timeOnly(cells[j].s)) {
        time = parseTime(cells[j].s);
        borrowed = k >= 0 && isLabel(cells[k].s);
        j++;
        while (j < cells.length && dateList(cells[j].s)) text += ' ' + cells[j++].s;
      } else if (k >= 0 && timeOnly(cells[k].s)) {
        time = parseTime(cells[k].s);
        borrowed = true;
      }
    }
    notes.push({ text, time, borrowed });
    i = j - 1;
  }
  return notes;
}

// One note -> closure entries.
function closuresFromNote({ text, time: cellTime = null, borrowed = false }, season) {
  if (!season || !CLOSURE_WORD.test(text)) return [];
  const s = respace(text)
    .replace(/(\d{1,2})\/\s+(\d{1,2})/g, '$1/$2') // "11/ 26"
    .replace(/(\d{1,2}\/\d{1,2})\s*\/\s*(\d{2,4})\b/g, '$1/$2') // "10/12 / 26"
    .replace(/\breopen\w*\s*(on\s*)?\S+/gi, ' '); // "reopen 11/22" is not a closure
  const reason = HOLIDAY_NAMES.some(([re]) => re.test(s)) || /holiday/i.test(s)
    ? 'holiday'
    : /mainten|maintence/i.test(s)
    ? 'maintenance'
    : /training|in-?service/i.test(s)
    ? 'training'
    : null;
  const times = [...s.matchAll(TIME_G)].map((m) => ({ i: m.index, t: parseTime(m[0]) })).filter((x) => x.t);
  const noteTime = times[0]?.t || cellTime;

  const place = (month, day, yr) => {
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
    let y = yr || season.from.getUTCFullYear();
    let d = utc(y, month, day);
    if (!yr && d < season.from - 60 * DAY_MS) d = utc(y + 1, month, day);
    const inReach = d >= season.from - 60 * DAY_MS && d <= +season.to + 60 * DAY_MS;
    return inReach ? d : null;
  };
  const toks = [];
  for (const m of s.matchAll(DATE_TOKEN)) {
    const month = m[1] ? MONTH_IDX[m[1].slice(0, 3).toLowerCase()] : +m[4];
    const day = m[1] ? +m[2] : +m[5];
    const yr = m[3] ? +m[3] : m[6] ? (+m[6] < 100 ? 2000 + +m[6] : +m[6]) : null;
    toks.push({ i: m.index, end: m.index + m[0].length, month, day, yr });
  }
  // Group tokens into [from, to] spans: "12/1-12/19", "October 13 - October
  // 31", and a same-month tail — "November 26-27" (a span), "Nov. 26 and 27".
  const spans = [];
  for (let k = 0; k < toks.length; k++) {
    const a = toks[k];
    const b = toks[k + 1];
    if (b && /^\s*(-|–|to|through|thru)\s*$/i.test(s.slice(a.end, b.i))) {
      spans.push({ i: a.i, end: b.end, from: a, to: b });
      k++;
      continue;
    }
    const tail = s.slice(a.end).match(/^\s*(-|–|to|and|&)\s*(\d{1,2})(?:\s?(?:st|nd|rd|th)\b)?(?![\d\/:])/i);
    if (tail) {
      const second = { ...a, day: +tail[2] };
      const end = a.end + tail[0].length;
      if (/and|&/i.test(tail[1])) spans.push({ i: a.i, end: a.end, from: a, to: a }, { i: a.i, end, from: second, to: second });
      else spans.push({ i: a.i, end, from: a, to: second });
      continue;
    }
    spans.push({ i: a.i, end: a.end, from: a, to: a });
  }

  const out = [];
  const push = (from, to, t, segment) => {
    const name = HOLIDAY_NAMES.find(([re]) => re.test(segment))?.[1];
    out.push({
      from: iso(from),
      to: iso(to),
      ...(t ? { start: t.start, end: t.end } : {}),
      reason,
      ...(name ? { name } : {}),
      ...(borrowed ? { borrowed } : {}),
    });
  };
  spans.forEach((sp, n) => {
    const from = place(sp.from.month, sp.from.day, sp.from.yr);
    const to = place(sp.to.month, sp.to.day, sp.to.yr || sp.from.yr);
    if (!from || !to || to < from || to - from > 120 * DAY_MS) return;
    // A time written after this date (and before the next) is this date's;
    // otherwise the note's hours apply to every date in it.
    const nextI = spans.slice(n + 1).find((x) => x.i > sp.i)?.i ?? s.length;
    const own = times.find((x) => x.i >= sp.end && x.i < nextI)?.t;
    push(from, to, own || noteTime, s.slice(sp.i, nextI));
  });

  // "Closed every 4th Thursday of the month" with no dates listed: every such
  // weekday inside the season.
  const every = !out.length && s.match(/every\s*(\d)\s*(?:st|nd|rd|th)?\s*(sun|mon|tue|wed|thu|fri|sat)/i);
  if (every) {
    const nth = +every[1];
    const dow = DOW_IDX[every[2].toLowerCase()];
    for (let d = new Date(season.from); d <= season.to; d = new Date(+d + DAY_MS)) {
      if (d.getUTCDay() === dow && Math.ceil(d.getUTCDate() / 7) === nth) push(d, d, noteTime, s);
    }
  }
  return out;
}

// All of a pool's notes -> its closure list, deduped. A note that only closes
// the session it's printed under yields to the pool's own statement for that
// date (Mission's grid closes its 11:15 lap swim; its notes say 12–2).
function mergeClosures(entries) {
  const stated = new Set(entries.filter((e) => !e.borrowed && e.from === e.to).map((e) => e.from));
  const kept = entries.filter((e) => !(e.borrowed && e.from === e.to && stated.has(e.from)));
  const allDay = kept.filter((e) => e.start == null);
  const byKey = new Map();
  for (const e of kept) {
    // A partial closure inside an all-day one says nothing more.
    if (e.start != null && allDay.some((a) => a.from <= e.from && a.to >= e.to)) continue;
    const k = `${e.from}|${e.to}`;
    const list = byKey.get(k) || [];
    const hit = list.find((x) => (x.start == null && e.start == null) || (x.start != null && e.start != null && e.start <= x.end && x.start <= e.end));
    if (!hit) list.push({ ...e });
    else {
      if (e.start != null) Object.assign(hit, { start: Math.min(hit.start, e.start), end: Math.max(hit.end, e.end) });
      hit.reason = hit.reason || e.reason;
      hit.name = hit.name || e.name;
    }
    byKey.set(k, list);
  }
  return [...byKey.values()]
    .flat()
    .map(({ borrowed, name, ...e }) => (name ? { ...e, name } : e))
    .sort((a, b) => a.from.localeCompare(b.from) || (a.start ?? -1) - (b.start ?? -1));
}

// City-wide holidays for POOL_CLOSURES (the assistant's closure topic): an
// all-day holiday closure printed on at least two pools' posters.
function cityHolidays(pools) {
  const seen = new Map();
  for (const p of pools)
    for (const c of p.closures || []) {
      if (c.reason !== 'holiday' || c.start != null || c.from !== c.to) continue;
      const e = seen.get(c.from) || { pools: 0, names: {} };
      e.pools++;
      if (c.name) e.names[c.name] = (e.names[c.name] || 0) + 1;
      seen.set(c.from, e);
    }
  return [...seen]
    .filter(([, e]) => e.pools >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({ date, label: Object.entries(e.names).sort((x, y) => y[1] - x[1])[0]?.[0] || 'Holiday' }));
}

// Several posters say "All city pools will be closed on…", but each lists only
// the holidays it has room for (Coffman's omits Labor Day). A holiday two or
// more posters agree on is applied to every pool whose season it falls in.
function withCityHolidays(pools) {
  const holidays = cityHolidays(pools);
  for (const p of pools) {
    const b = seasonBoundsFromText(p.season, p.scheduleUrls);
    if (!b) continue;
    const extra = holidays
      .filter((h) => utc(...h.date.split('-').map(Number)) >= b.from && utc(...h.date.split('-').map(Number)) <= b.to)
      .filter((h) => !(p.closures || []).some((c) => c.start == null && c.from <= h.date && c.to >= h.date))
      .map((h) => ({ from: h.date, to: h.date, reason: 'holiday', ...(h.label !== 'Holiday' ? { name: h.label } : {}) }));
    if (extra.length) p.closures = mergeClosures([...(p.closures || []), ...extra]);
  }
}
const seasonBoundsFromText = (season, urls) =>
  seasonBounds(`${season} ${(urls || []).map((u) => u.label).join(' ')}`, []);

// ---- Scraping -------------------------------------------------------------

// Site-wide boilerplate that appears on every facility page (department blurb,
// contact/accessibility footer, share widget), funding minutiae, dated
// announcement letters ("Dear Swimmers…"), and the "offers lap swim, …" line
// that just duplicates the card's program chips. Footer phrases are matched
// precisely — a pool's real blurb may legitimately mention accessibility.
const DESC_SKIP =
  /SocialShare|\$\(document\)|Department manages|10-minute walk|Main Office|committed to ensuring|accessibility barrier|WCAG|Human Resources|Language Access|reasonable effort|offers lap swim|funded by|GO Bond|Impact Fee|^Dear\b|excited to announce/i;

// The facility page's own paragraph about this pool (renovation, layout,
// amenities) — the only per-pool description SFRP publishes anywhere. First
// substantial paragraph that isn't boilerplate wins; null when a page has none.
function pageDesc($) {
  let best = null;
  $('p').each((_, p) => {
    if (best) return;
    const t = $(p).text().replace(/\s+/g, ' ').trim();
    if (t.length < 80 || DESC_SKIP.test(t)) return;
    best = t.length > 340 ? t.slice(0, 337).replace(/\s+\S*$/, '') + '…' : t;
  });
  return best;
}

async function fetchFacilityPage(slug) {
  const cheerio = require('cheerio');
  const html = await (await fetchT(`${BASE}/Facilities/Facility/Details/${slug}`, { headers: { 'User-Agent': UA } })).text();
  const $ = cheerio.load(html);
  const docs = [];
  $('a[href*="/DocumentCenter/View/"]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    const rel = href.replace(BASE, '');
    if (href && text && !DECK_RULES.has(rel) && !docs.find((d) => d.url.endsWith(rel))) {
      docs.push({ label: text, url: href.startsWith('http') ? href : BASE + href });
    }
  });
  return { docs, desc: pageDesc($) };
}

async function pdfItems(url) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = Buffer.from(await (await fetchT(url, { headers: { 'User-Agent': UA } })).arrayBuffer());
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  return tc.items
    .filter((i) => i.str.trim())
    .map((i) => ({ x: Math.round(i.transform[4]), y: Math.round(i.transform[5]), w: i.width, s: i.str.trim() }));
}

// The season label the app shows must describe the SAME poster the sessions were
// parsed from, and the sessions come from whatever PDF is live while `season` was
// hand-typed — so the two drift apart silently every time SFRP re-posts. They had
// already drifted for 2 of 9 pools (Balboa curated "Jun 9 – Aug 15" against a
// poster reading "June 3_Aug 16"; North Beach "Jun 6" against "June 9").
//
// The link text SFRP labels each PDF with carries the dates, so read them from
// there and keep the curated value as the fallback. Labels are inconsistently
// punctuated — "June 3_Aug 16", "June 7 to Aug 13", "Jun9_ Aug15th",
// "June30-aug15new" — so month and day may be separated by spaces, underscores,
// dashes, or nothing at all. `(?!\d)` stops the "20" of a "Summer 2026" stamp
// from being read as a day.
const MONTHS = { jan: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', may: 'May', jun: 'Jun',
  jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };
const MONTH_DAY_RE = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s_.\-]*(\d{1,2})(?!\d)/gi;

function seasonFromLabel(label) {
  const hits = [...String(label || '').matchAll(MONTH_DAY_RE)]
    .map((h) => ({ mon: MONTHS[h[1].toLowerCase()], day: Number(h[2]) }))
    .filter((h) => h.mon && h.day >= 1 && h.day <= 31);
  if (hits.length < 2) return null;
  const [a, b] = hits;
  return `${a.mon} ${a.day} – ${b.mon} ${b.day}`;
}

async function scrapePool(m) {
  const { docs: scheduleUrls, desc } = await fetchFacilityPage(m.slug);
  // A facility with separate warm-pool and cool-pool PDFs (North Beach) gets each
  // session tagged with which pool runs it, so the app can show the two schedules
  // separately. Single-PDF pools stay untagged (no `pool` field).
  const poolTag = (label) => (/warm/i.test(label) ? 'warm' : /cool/i.test(label) ? 'cool' : null);
  const tags = new Set(scheduleUrls.map((d) => poolTag(d.label)).filter(Boolean));
  const tagPdfs = tags.has('warm') && tags.has('cool');
  const week = [[], [], [], [], [], [], []];
  const seen = week.map(() => new Set());
  const closureEntries = [];
  for (const d of scheduleUrls) {
    const tag = tagPdfs ? poolTag(d.label) : null;
    const items = await pdfItems(d.url);
    const { sessions: grid = {}, notes = [] } = parseGrid(items) || {};
    const bounds = seasonBounds(d.label, items);
    for (const n of notes) closureEntries.push(...closuresFromNote(n, bounds));
    for (const dow of Object.keys(grid))
      for (const s of grid[dow]) {
        const k = (tag || '') + s.kind + (s.label || '') + s.start + s.end;
        if (!seen[dow].has(k)) {
          seen[dow].add(k);
          week[dow].push(tag ? { ...s, pool: tag } : s);
        }
      }
  }
  week.forEach((a) => a.sort((x, y) => x.start - y.start || x.kind.localeCompare(y.kind)));
  const kinds = new Set(week.flat().map((s) => s.kind));

  // Prefer the posted dates over the curated ones, and say so when they disagree —
  // a mismatch means the curated table is behind the poster (or SFRP changed a
  // label format and the parse needs a look).
  const posted = scheduleUrls.map((d) => seasonFromLabel(d.label)).find(Boolean);
  const season = posted || m.season;
  if (posted && posted !== m.season) {
    console.log(`    ↻ ${m.name} — season from poster: ${posted} (curated said ${m.season})`);
  } else if (!posted) {
    console.log(`    ⚠ ${m.name} — no dates in any PDF label; keeping curated ${m.season}`);
  }

  return {
    id: m.id,
    name: m.name,
    address: m.address,
    lat: m.lat,
    lng: m.lng,
    phone: m.phone,
    season,
    ...(m.note ? { note: m.note } : {}),
    ...(desc ? { desc } : {}),
    programs: KIND_ORDER.filter((k) => kinds.has(k)),
    scheduleUrls,
    sessions: week,
    closures: mergeClosures(closureEntries),
  };
}

// ---- Output ---------------------------------------------------------------

function render(pools) {
  return `// AUTO-GENERATED by scripts/build-pools.js — do not edit by hand.
// Regenerate with: npm run build:pools
// Generated: ${new Date().toISOString()}
//
// SF Rec & Park public swimming pools, scraped from sfrecpark.org. Each pool's
// weekly schedule is parsed from its seasonal PDF (the authoritative source —
// see scheduleUrls). sessions[dow] = array of { kind, start, end } where dow is
// 0=Sun..6=Sat and start/end are minutes-from-midnight. kind is one of
// POOL_SESSION_KINDS; the app renders a localized label per kind. A facility
// with separate warm-/cool-pool PDFs (North Beach) also tags each session with
// pool: "warm" | "cool" so the two schedules render separately. Schedules are
// seasonal (see \`season\`) and the build refreshes them when SFRP posts new PDFs.

export const POOL_SESSION_KINDS = ${JSON.stringify(KIND_ORDER)};

export const POOL_FEES = ${JSON.stringify(FEES, null, 2)};

export const POOL_CLOSURES = ${JSON.stringify(cityHolidays(pools))};

export const POOLS = [
${pools.map((p) => '  ' + JSON.stringify(p)).join(',\n')}
];

export default POOLS;
`;
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  console.log('Fetching SF Rec & Park pool schedules…');
  let pools;
  let source;
  try {
    pools = [];
    for (const m of META) {
      const p = await scrapePool(m);
      const n = p.sessions.flat().length;
      console.log(`  ${p.name}: ${p.scheduleUrls.length} pdf(s), ${n} sessions`);
      pools.push(p);
    }
    const withSessions = pools.filter((p) => p.sessions.flat().length > 0).length;
    if (withSessions < MIN_OK_POOLS) {
      throw new Error(`only ${withSessions} pools parsed sessions (min ${MIN_OK_POOLS}) — PDF layout may have changed`);
    }
    source = 'live';
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ pools, fees: FEES, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch (e) {
    const cache = loadCache();
    if (!cache || !cache.pools) throw new Error(`fetch failed (${e.message}) and no cache — data/pools.js left unchanged`);
    pools = cache.pools;
    source = 'cache';
    console.log(`  ↺ ${e.message}; using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  withCityHolidays(pools);
  fs.writeFileSync(OUT_FILE, render(pools));
  console.log(`\n✅ Wrote ${pools.length} pools to data/pools.js (${source})`);
}

main().catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
