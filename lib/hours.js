// Open-now logic for courts, based on the per-weekday `schedule` in data/courts.js.
// Schedule is indexed 0=Sunday..6=Saturday; each entry is [openMin, closeMin]
// (minutes from midnight) or null when closed that day.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
    return { open: false, label: 'Closed today' };
  }

  const [openMin, closeMin] = todays;
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const open = nowMin >= openMin && nowMin < closeMin;

  if (open) {
    return { open: true, label: `Open until ${fmt(closeMin)}` };
  }
  if (nowMin < openMin) {
    return { open: false, label: `Opens ${fmt(openMin)}` };
  }
  return { open: false, label: `Closed (opens ${DAY_NAMES[(day + 1) % 7]} ${fmt(openFor(schedule, day + 1))})` };
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

// Block-tag id -> human label (kept in sync with scraper's blockTag()).
const TAG_LABEL = {
  women: "women's",
  wheelchair: 'wheelchair',
  '55+': '55 & better',
};
export function tagLabel(tag) {
  return tag ? TAG_LABEL[tag] || tag : '';
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

  const active = today.find((b) => nowMin >= b[0] && nowMin < b[1]);
  if (active) {
    const label = tagLabel(active[2]);
    const what = label ? `${label} open gym` : 'Open gym';
    return { open: true, label: `${what} now · until ${fmt(active[1])}` };
  }

  // Later today?
  const laterToday = today.find((b) => nowMin < b[0]);
  if (laterToday) {
    return { open: false, label: `Open gym today ${fmt(laterToday[0])}` };
  }

  // Next day this week with a block.
  for (let i = 1; i <= 7; i++) {
    const d = (day + i) % 7;
    const blocks = week[d] || [];
    if (blocks.length) {
      return { open: false, label: `Next: ${DAY_NAMES[d]} ${fmt(blocks[0][0])}` };
    }
  }
  return { open: false, label: 'No open-gym times listed' };
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
export function getDropinWeek(court, sport = DEFAULT_SPORT, date = new Date()) {
  const week = sportWeek(court, sport);
  const today = date.getDay();
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  return order.map((d) => {
    const blocks = week[d] || [];
    return {
      day: DAY_NAMES[d],
      label: blocks.length ? blocks.map(fmtRange).join(', ') : 'Closed',
      hasDropin: blocks.length > 0,
      hasFlagged: blocks.some((b) => b[2]),
      isToday: d === today,
    };
  });
}
