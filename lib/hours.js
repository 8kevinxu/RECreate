// Open-now logic for courts, based on the per-weekday `schedule` in data/courts.js.
// Schedule is indexed 0=Sunday..6=Saturday; each entry is [openMin, closeMin]
// (minutes from midnight) or null when closed that day.

import { tg } from './i18n';

// Localized short weekday name (0=Sun..6=Sat).
export const dayName = (dow) => tg('day.' + dow);

export function fmt(mins) {
  // % 24 so a midnight close (1440, what SF's 5 AM–midnight park hours produce)
  // reads as 12AM. Without it, hour 24 trips the >= 12 branch and prints "12PM" —
  // "open until 12PM" on a court that's open until midnight.
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// Local calendar date as 'YYYY-MM-DD' (toISOString would give the UTC date).
export const localYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Dated closures a court carries that fall on `date`'s calendar day — a pool's
// posted holidays, maintenance windows and staff-training hours (see
// scripts/build-pools.js). Each is { from, to, start?, end?, reason }; no
// start/end means all day. Weekly schedules can't express any of this, so it is
// carved out of them per date below.
export function closuresOn(court, date) {
  const list = court && court.closures;
  if (!list || !list.length) return [];
  const ymd = localYmd(date);
  return list.filter((c) => c.from <= ymd && c.to >= ymd);
}
const closureRange = (c) => [c.start ?? 0, c.end ?? 1440];

// Blocks minus cut ranges, keeping each block's tag. Pieces shorter than
// `minLen` minutes are dropped.
function carve(blocks, cuts, minLen) {
  const rest = [];
  for (const b of blocks) {
    let segs = [[b[0], b[1]]];
    for (const [cs, ce] of cuts) {
      const next = [];
      for (const [s, e] of segs) {
        if (ce <= s || cs >= e) {
          next.push([s, e]);
          continue;
        }
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
      segs = next;
    }
    for (const [s, e] of segs) if (e - s >= minLen) rest.push(b[2] ? [s, e, b[2]] : [s, e]);
  }
  return rest;
}

// Returns { open: boolean, label: string } for the given court at `date`.
export function getOpenStatus(court, date = new Date()) {
  const schedule = court.schedule || [];
  const day = date.getDay();
  const todays = schedule[day];

  if (!todays || closuresOn(court, date).some((c) => c.start == null)) {
    return { open: false, label: tg('hours.closedToday') };
  }

  const [openMin, closeMin] = todays;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const open = nowMin >= openMin && nowMin < closeMin;

  if (open) {
    return { open: true, label: tg('hours.openUntil', { t: fmt(closeMin) }) };
  }
  if (nowMin < openMin) {
    return { open: false, label: tg('hours.opens', { t: fmt(openMin) }) };
  }
  return {
    open: false,
    label: tg('hours.closedOpens', {
      day: dayName((day + 1) % 7),
      t: fmt(openFor(schedule, day + 1)),
    }),
  };
}

// Find the next day's opening time for the "closed for the night" label.
function openFor(schedule, startDay) {
  for (let i = 0; i < 7; i++) {
    const d = (startDay + i) % 7;
    if (schedule[d]) return schedule[d][0];
  }
  return 6 * 60;
}

export function isOpenNow(court, date = new Date()) {
  return getOpenStatus(court, date).open;
}

// ---- Drop-in open-gym logic (per sport) -----------------------------------
// `court.dropins` is a map of sportId -> 7-element week (0=Sun..6=Sat); each day
// is an array of [startMin, endMin] drop-in blocks (empty when none that day).
// A block may carry a third element: a tag string marking a restricted session
// (e.g. 'women', 'wheelchair', '55+'), shown as a parenthetical in-app.
// Pass a sportId ('basketball' | 'volleyball' | ...).

const DEFAULT_SPORT = 'basketball';

// Block-tag id -> localized label (kept in sync with scraper's blockTag()).
const TAG_KEY = {
  women: 'tag.women',
  wheelchair: 'tag.wheelchair',
  '55+': 'tag.55',
  openplay: 'tag.openplay',
  reservable: 'tag.reservable',
  youth: 'tag.youth',
  teen: 'tag.teen',
  community: 'tag.community',
};
export function tagLabel(tag) {
  if (tag === true) return tg('tag.wheelchair'); // legacy boolean flag (pre-tags)
  return tag && TAG_KEY[tag] ? tg(TAG_KEY[tag]) : '';
}

// The 7-day week array for a court + sport (tolerates missing dropins/sport).
function sportWeek(court, sport = DEFAULT_SPORT) {
  return (court && court.dropins && court.dropins[sport]) || [];
}

// One calendar day's blocks: the weekday's, minus that date's closures.
export function blocksOn(court, sport, date) {
  const blocks = sportWeek(court, sport)[date.getDay()] || [];
  const cuts = closuresOn(court, date).map(closureRange);
  return cuts.length ? carve(blocks, cuts, 1) : blocks;
}

function fmtRange([o, c, tag]) {
  const label = tagLabel(tag);
  return `${fmt(o)}–${fmt(c)}${label ? ` (${label})` : ''}`;
}

// Status of a sport's drop-in gym right now: is a block active, or when's next?
export function getDropinStatus(court, sport = DEFAULT_SPORT, date = new Date()) {
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const today = blocksOn(court, sport, date);

  // A restricted session is shown as a trailing "(tag)" — order-safe to translate.
  const tagSuffix = (tag) => {
    const t = tagLabel(tag);
    return t ? ` (${t})` : '';
  };

  const active = today.find((b) => nowMin >= b[0] && nowMin < b[1]);
  if (active) {
    return { open: true, label: tg('hours.nowUntil', { t: fmt(active[1]) }) + tagSuffix(active[2]) };
  }

  // Later today?
  const laterToday = today.find((b) => nowMin < b[0]);
  if (laterToday) {
    return {
      open: false,
      label: tg('hours.todayAt', { t: fmt(laterToday[0]) }) + tagSuffix(laterToday[2]),
    };
  }

  // Next day with a block. A court with dated closures looks further ahead — a
  // three-week maintenance window would otherwise read "no open times" — and
  // names a date rather than a weekday once it's a week or more away.
  const dated = !!(court && court.closures && court.closures.length);
  for (let i = 1; i <= (dated ? 60 : 7); i++) {
    const next = new Date(date);
    next.setDate(date.getDate() + i);
    const blocks = blocksOn(court, sport, next);
    if (blocks.length) {
      const day = dated && i >= 7 ? `${next.getMonth() + 1}/${next.getDate()}` : dayName(next.getDay());
      return {
        open: false,
        label: tg('hours.next', { day, t: fmt(blocks[0][0]) }) + tagSuffix(blocks[0][2]),
      };
    }
  }
  return { open: false, label: tg('hours.noneListed') };
}

// Minutes of a sport's open gym left in the currently-active block at `date`
// (0 if none is active). Used to flag/filter courts that are closing soon.
export function getDropinRemaining(court, sport = DEFAULT_SPORT, date = new Date()) {
  const today = blocksOn(court, sport, date);
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const active = today.find((b) => nowMin >= b[0] && nowMin < b[1]);
  return active ? active[1] - nowMin : 0;
}

// Weekdays (0=Sun..6=Sat) a court has any drop-in block for the sport.
export function dropinWeekdays(court, sport = DEFAULT_SPORT) {
  const set = new Set();
  sportWeek(court, sport).forEach((blocks, d) => {
    if (blocks && blocks.length) set.add(d);
  });
  return set;
}

// Selectable start times within a court's open-gym blocks for a weekday, so you
// can only pick a time the gym actually runs that sport. Snapped to the clean
// :00/:30 grid (some blocks start at :15/:45) — both so the chips read evenly and
// so the union across courts never produces 15-min gaps.
export function openGymSlots(court, sport = DEFAULT_SPORT, weekday) {
  const blocks = sportWeek(court, sport)[weekday] || [];
  const set = new Set();
  for (const [s, e] of blocks) {
    for (let m = Math.ceil(s / 30) * 30; m < e; m += 30) set.add(m);
  }
  return [...set].sort((a, b) => a - b);
}

// Where the viewer sits relative to a directory `openPlayWeek` — the posted
// open-play blocks that a facility carves out of its otherwise-reservable
// courts (Rossi, Upper Noe). The card's other badges all answer "right now",
// so the open-play chip does too; this resolves which of the three things it
// has to say. Returns null when the week carries no blocks at all (nothing to
// announce) — callers hide the chip.
//
//   { kind: 'now',   end }          inside a block
//   { kind: 'today', start, end }   a block still to come today
//   { kind: 'next',  dow, start }   the soonest block on a later day
export function openPlayState(openPlayWeek, date = new Date()) {
  if (!openPlayWeek || !openPlayWeek.some((d) => (d || []).length)) return null;
  const today = date.getDay();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const todays = [...(openPlayWeek[today] || [])].sort((a, b) => a[0] - b[0]);
  for (const [s, e] of todays) if (nowMin >= s && nowMin < e) return { kind: 'now', end: e };
  for (const [s, e] of todays) if (nowMin < s) return { kind: 'today', start: s, end: e };
  // Nothing left today — walk forward for the next day that has any. The week is
  // non-empty (guarded above), so this always lands within 7 days; +7 rather than
  // +6 so a day whose blocks have all passed can still match itself next week.
  for (let i = 1; i <= 7; i++) {
    const d = (today + i) % 7;
    const blocks = [...(openPlayWeek[d] || [])].sort((a, b) => a[0] - b[0]);
    if (blocks.length) return { kind: 'next', dow: d, start: blocks[0][0] };
  }
  return null;
}

// The raw resolved drop-in week for a court + sport: a 7-element array (0=Sun..6=Sat)
// of [startMin, endMin, tag?] blocks. `openPlayWeek` (optional, same shape) folds
// shared-use open-play blocks in, tagged 'openplay'; those windows are carved OUT of
// the base blocks first so a day never carries overlapping times — base 8AM-8PM +
// open play 7AM-3PM resolves to [7AM–3PM (openplay), 3–8PM], not two overlapping ranges.
// Unlocalized on purpose: getDropinWeek() formats this for display, and
// scripts/export-chatbot-data.js ships it to the assistant, so both read one schedule.
export function resolveDropinWeek(court, sport = DEFAULT_SPORT, openPlayWeek = null) {
  const base = sportWeek(court, sport);
  if (!openPlayWeek) return base;
  return Array.from({ length: 7 }, (_, d) => {
    const cuts = openPlayWeek[d] || [];
    // drop sub-30-min slivers left by the subtraction — schedule noise
    const rest = carve(base[d] || [], cuts, 30);
    return [...rest, ...cuts.map(([s, e]) => [s, e, 'openplay'])].sort((a, b) => a[0] - b[0]);
  });
}

// Weekly schedule for display: [{ day, label, isToday }] starting Monday.
export function getDropinWeek(court, sport = DEFAULT_SPORT, date = new Date(), openPlayWeek = null) {
  const week = resolveDropinWeek(court, sport, openPlayWeek);
  const today = date.getDay();
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  return order.map((d) => {
    const blocks = week[d] || [];
    return {
      day: dayName(d),
      label: blocks.length ? blocks.map(fmtRange).join(', ') : tg('hours.closed'),
      hasDropin: blocks.length > 0,
      hasFlagged: blocks.some((b) => b[2]),
      isToday: d === today,
    };
  });
}
