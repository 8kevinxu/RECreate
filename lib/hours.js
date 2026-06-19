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

// ---- Basketball open-gym logic --------------------------------------------
// `court.basketball` is indexed 0=Sun..6=Sat; each day is an array of
// [startMin, endMin] drop-in blocks (empty when no basketball that day).

// A block is [openMin, closeMin] or [openMin, closeMin, true] for wheelchair
// basketball, which we mark with an asterisk.
function fmtRange([o, c, wheelchair]) {
  return `${fmt(o)}–${fmt(c)}${wheelchair ? '*' : ''}`;
}

// Status of drop-in basketball right now: is a block active, or when's next?
export function getBasketballStatus(court, date = new Date()) {
  const week = court.basketball || [];
  const day = date.getDay();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  const today = week[day] || [];

  const active = today.find((b) => nowMin >= b[0] && nowMin < b[1]);
  if (active) {
    return { open: true, label: `Open gym now · until ${fmt(active[1])}` };
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

// Weekly schedule for display: [{ day, label, isToday }] starting Monday.
export function getBasketballWeek(court, date = new Date()) {
  const week = court.basketball || [];
  const today = date.getDay();
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  return order.map((d) => {
    const blocks = week[d] || [];
    return {
      day: DAY_NAMES[d],
      label: blocks.length ? blocks.map(fmtRange).join(', ') : 'Closed',
      hasBball: blocks.length > 0,
      hasWheelchair: blocks.some((b) => b[2]),
      isToday: d === today,
    };
  });
}
