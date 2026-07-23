// Open-now logic for courts, based on the per-weekday `schedule` in data/courts.js.
// Schedule is indexed 0=Sunday..6=Saturday; each entry is [openMin, closeMin]
// (minutes from midnight) or null when closed that day.

import { tg } from './i18n';

// Localized short weekday name (0=Sun..6=Sat).
const dayName = (dow) => tg('day.' + dow);

function fmt(mins) {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// Returns { open: boolean, label: string } for the given court at `date`.
export function getOpenStatus(court, date = new Date()) {
  const schedule = court.schedule || [];
  const day = date.getDay();
  const todays = schedule[day];

  if (!todays) {
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
};
export function tagLabel(tag) {
  if (tag === true) return tg('tag.wheelchair'); // legacy boolean flag (pre-tags)
  return tag && TAG_KEY[tag] ? tg(TAG_KEY[tag]) : '';
}

// The 7-day week array for a court + sport (tolerates missing dropins/sport).
function sportWeek(court, sport = DEFAULT_SPORT) {
  return (court && court.dropins && court.dropins[sport]) || [];
}

function fmtRange([o, c, tag]) {
  const label = tagLabel(tag);
  return `${fmt(o)}–${fmt(c)}${label ? ` (${label})` : ''}`;
}

// Status of a sport's drop-in gym right now: is a block active, or when's next?
export function getDropinStatus(court, sport = DEFAULT_SPORT, date = new Date()) {
  const week = sportWeek(court, sport);
  const day = date.getDay();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const today = week[day] || [];

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

  // Next day this week with a block.
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    const blocks = week[d] || [];
    if (blocks.length) {
      return {
        open: false,
        label: tg('hours.next', { day: dayName(d), t: fmt(blocks[0][0]) }) + tagSuffix(blocks[0][2]),
      };
    }
  }
  return { open: false, label: tg('hours.noneListed') };
}

// Minutes of a sport's open gym left in the currently-active block at `date`
// (0 if none is active). Used to flag/filter courts that are closing soon.
export function getDropinRemaining(court, sport = DEFAULT_SPORT, date = new Date()) {
  const today = sportWeek(court, sport)[date.getDay()] || [];
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

// Weekly schedule for display: [{ day, label, isToday }] starting Monday.
// `openPlayWeek` (optional, same 7-day shape) folds shared-use open-play blocks
// into each day's row tagged 'openplay' — rendered as "7AM–3PM (open play)".
// The open-play windows are carved OUT of the base blocks first so a day never
// shows overlapping times: base 8AM-8PM + open play 7AM-3PM reads
// "7AM–3PM (open play), 3–8PM", not two overlapping ranges.
export function getDropinWeek(court, sport = DEFAULT_SPORT, date = new Date(), openPlayWeek = null) {
  const base = sportWeek(court, sport);
  const week = openPlayWeek
    ? Array.from({ length: 7 }, (_, d) => {
        const cuts = openPlayWeek[d] || [];
        const rest = [];
        for (const b of base[d] || []) {
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
          // drop sub-30-min slivers left by the subtraction — schedule noise
          for (const [s, e] of segs) if (e - s >= 30) rest.push(b[2] ? [s, e, b[2]] : [s, e]);
        }
        return [...rest, ...cuts.map(([s, e]) => [s, e, 'openplay'])].sort((a, b) => a[0] - b[0]);
      })
    : base;
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
