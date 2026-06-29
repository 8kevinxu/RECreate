// Helpers for the rec.us reservation snapshot attached to courts as `reserved`
// (see data/reservations.js). Slots are keyed "YYYY-MM-DD HH:MM" (SF-local, 30-min
// grid) → booked% (share of the location's *released* courts reserved) at that time.
// `released` is a sparse map of how many courts are open for booking at a slot, set
// only when fewer than `courts` are (courts have different reservation windows).

const pad2 = (n) => String(n).padStart(2, '0');

// The current (or any) Date as a slot key, floored to the 30-min grid.
export const slotKeyOf = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${
    d.getMinutes() < 30 ? '00' : '30'
  }`;

// A reading for one slot key: { pct, open, total, releasesAt } or null when there's
// no slot. total = courts open at that hour; open = how many of those are bookable now;
// releasesAt = Date the next not-yet-released courts open for booking (null if all open).
function readSlot(res, key) {
  if (!res || !res.slots) return null;
  const pct = res.slots[key];
  if (pct == null) return null;
  const total = res.open?.[key] ?? res.courts ?? null; // courts open at this hour
  const open = res.released?.[key] ?? total; // of those, bookable now
  let releasesAt = null;
  // Some open courts have a shorter reservation window, so on a far-out date they
  // aren't bookable yet. The soonest to open is the largest still-unreleased window.
  if (total != null && open < total && Array.isArray(res.windows) && res.windows.length) {
    const at = new Date(key.replace(' ', 'T'));
    const ageHrs = (at.getTime() - Date.now()) / 3.6e6;
    const hidden = res.windows.filter((w) => w < ageHrs);
    if (hidden.length) releasesAt = new Date(at.getTime() - Math.max(...hidden) * 3.6e6);
  }
  return { pct, open, total, releasesAt };
}

// Booked reading at a specific time (floored to the 30-min grid), or null if the
// court has no bookable slot then (closed, or outside the snapshot window).
export function bookedAt(res, date) {
  return readSlot(res, slotKeyOf(date));
}

// "% booked right now": the current 30-min slot if the court is open now, else the
// next upcoming slot in the snapshot window. Returns { pct, open, total, now } or
// { pct, open, total, at }, or null once the snapshot has gone stale.
export function liveBooked(res) {
  if (!res || !res.slots) return null;
  const nowKey = slotKeyOf(new Date());
  const cur = readSlot(res, nowKey);
  if (cur) return { ...cur, now: true };
  const next = Object.keys(res.slots).sort().find((k) => k >= nowKey);
  return next ? { ...readSlot(res, next), at: next } : null;
}

// Is this sport's court fully booked — at the given time, or right now if omitted?
export function isFullyBooked(res, at) {
  if (at) {
    const b = bookedAt(res, at);
    return !!b && b.pct === 100;
  }
  const lb = liveBooked(res);
  return !!lb && lb.now && lb.pct === 100;
}
