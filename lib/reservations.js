// Helpers for the rec.us reservation snapshot attached to courts as `reserved`
// (see data/reservations.js). Slots are keyed "YYYY-MM-DD HH:MM" (SF-local, 30-min
// grid) → booked% of the courts rec.us would let you book AT THAT SLOT.
//
// That raw percentage is a bad answer to "can I play here?", because its denominator
// shrinks to just the bookable courts:
//   · Courts in open-play mode at that hour carry no rec.us hours then, so they drop
//     out (`open` is the sparse count of courts open at the slot). Rossi pickleball
//     Monday: courts A–D are open play until 3 PM, so 10 AM's denominator is Court E
//     alone — one booking read as "100% booked" while 4 courts sat free.
//   · Walk-up courts never reach rec.us at all (Rossi is 9 pickleball courts: 5
//     reservable + 4 walk-up), so they're missing from every reading.
//
// So we re-base every reading on the SF Rec & Park directory's court count (`dir`,
// merged onto courts by lib/useCourts.js): how many courts are RESERVED, out of how
// many exist. "Fully booked" then means what it says — nothing left to play on.

const pad2 = (n) => String(n).padStart(2, '0');

// The current (or any) Date as a slot key, floored to the 30-min grid.
export const slotKeyOf = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${
    d.getMinutes() < 30 ? '00' : '30'
  }`;

// A reading for one slot key, or null when there's no slot. `dir` is the court's
// directory facts for the sport ({ total, reservable, walkup }) when we have them.
//   pct        share of ALL courts unplayable (not of the bookable subset)
//   booked     courts reserved at that time (real bookings on this sport's courts)
//   blocked    courts unavailable because an overlapping court is booked — same
//              practical effect, but nobody reserved THIS sport (see the build header)
//   blockedBy  the sport whose booking blocks them, when we know it
//   playable   courts that exist for the sport here
//   free       playable - booked - blocked
//   openPlay   courts rec.us manages but isn't taking bookings for at that hour
//   walkup     courts that are never reservable
//   open/total courts released for booking / open for booking at that hour (the
//              "X of Y open for booking" + release-date clause, unchanged)
function readSlot(res, key, dir) {
  if (!res || !res.slots) return null;
  const raw = res.slots[key];
  if (raw == null) return null;
  const openAtHour = res.open?.[key] ?? res.courts ?? null; // rec.us courts open then
  const bookable = res.released?.[key] ?? openAtHour; // of those, bookable now
  // v2 stores reserved court counts outright. Older payloads (a stale build cache)
  // stored a booked-%; invert it — the build rounded booked/bookable to whole percent
  // and these counts are single digits, so it round-trips exactly.
  const booked = res.v >= 2 ? raw : bookable != null ? Math.round((raw / 100) * bookable) : null;
  const blocked = res.blk?.[key] ?? 0;
  // Every court for this sport, per the SFRP directory — falls back to rec.us's own
  // count when a court has no directory entry (then walk-up courts stay invisible).
  const playable = Math.max(dir?.total ?? 0, res.courts ?? 0) || null;
  const free = playable != null && booked != null ? Math.max(0, playable - booked - blocked) : null;
  // Courts you can play on but can't book right now, split by why: never reservable
  // (walk-up) vs. reservable at other hours but in open play at this one.
  const walkup = dir?.walkup ?? (playable != null && res.courts != null ? Math.max(0, playable - res.courts) : 0);
  const openPlay = openAtHour != null && res.courts != null ? Math.max(0, res.courts - openAtHour) : 0;
  const pct =
    playable && booked != null ? Math.round(((booked + blocked) / playable) * 100) : res.v >= 2 ? 0 : raw;

  let releasesAt = null;
  // Some open courts have a shorter reservation window, so on a far-out date they
  // aren't bookable yet. The soonest to open is the largest still-unreleased window.
  if (openAtHour != null && bookable < openAtHour && Array.isArray(res.windows) && res.windows.length) {
    const at = new Date(key.replace(' ', 'T'));
    const ageHrs = (at.getTime() - Date.now()) / 3.6e6;
    const hidden = res.windows.filter((w) => w < ageHrs);
    if (hidden.length) releasesAt = new Date(at.getTime() - Math.max(...hidden) * 3.6e6);
  }
  return {
    pct, booked, blocked, blockedBy: blocked ? res.overlapSport || null : null,
    playable, free, walkup, openPlay, open: bookable, total: openAtHour, releasesAt,
  };
}

// Booked reading at a specific time (floored to the 30-min grid), or null if the
// court has no bookable slot then (closed, or outside the snapshot window).
export function bookedAt(res, date, dir) {
  return readSlot(res, slotKeyOf(date), dir);
}

// "% booked right now": the current 30-min slot if the court is open now, else the
// next upcoming slot in the snapshot window. Adds `now: true` or `at: <key>`, or
// returns null once the snapshot has gone stale.
export function liveBooked(res, dir) {
  if (!res || !res.slots) return null;
  const nowKey = slotKeyOf(new Date());
  const cur = readSlot(res, nowKey, dir);
  if (cur) return { ...cur, now: true };
  const next = Object.keys(res.slots).sort().find((k) => k >= nowKey);
  return next ? { ...readSlot(res, next, dir), at: next } : null;
}

// When the courts sitting outside the booking grid at `key` come back into it — the
// next slot that day where rec.us opens more courts ("4 open play until 3 PM").
// Returns "HH:MM", or null when nothing is held back or it never reopens that day.
export function bookableFrom(res, key) {
  if (!res || !res.slots || !res.open) return null;
  const openAtHour = res.open[key];
  if (openAtHour == null || openAtHour >= (res.courts ?? 0)) return null;
  const day = key.slice(0, 10);
  const later = Object.keys(res.slots).filter((k) => k > key && k.startsWith(day)).sort();
  for (const k of later) {
    if ((res.open[k] ?? res.courts) > openAtHour) return k.slice(11);
  }
  return null;
}

// Is this sport's court fully booked — at the given time, or right now if omitted?
// Only when NOTHING is left to play on: a booked-out reservation grid alongside free
// walk-up or open-play courts is not "fully booked".
const noneLeft = (b) => !!b && (b.free != null ? b.free === 0 : b.pct === 100);

export function isFullyBooked(res, at, dir) {
  return !!fullState(res, at, dir);
}

// Why nothing is left: 'booked' (this sport's courts are reserved) vs 'unavailable'
// (nothing reserved here — an overlapping court's booking holds the space). null when
// something is still free. Callers word the badge off this rather than always saying
// "fully booked", which would credit a reservation nobody made.
export function fullState(res, at, dir) {
  const b = at ? bookedAt(res, at, dir) : liveBooked(res, dir);
  if (!b || (!at && !b.now) || !noneLeft(b)) return null;
  return b.booked === 0 && b.blocked > 0 ? 'unavailable' : 'booked';
}
