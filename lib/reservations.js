// Helpers for the rec.us reservation snapshot attached to courts as `reserved`
// (see data/reservations.js). Slots are keyed "YYYY-MM-DD HH:MM" (SF-local, 30-min
// grid) → booked% (share of the location's courts reserved) at that time.

const pad2 = (n) => String(n).padStart(2, '0');

// The current (or any) Date as a slot key, floored to the 30-min grid.
export const slotKeyOf = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${
    d.getMinutes() < 30 ? '00' : '30'
  }`;

// "% booked right now" for a court's reserved[sport] entry: the current 30-min slot
// if the court is open now, else the next upcoming slot in the snapshot window.
// Returns { pct, now } or { pct, at }, or null once the snapshot has gone stale.
export function liveBooked(res) {
  if (!res || !res.slots) return null;
  const nowKey = slotKeyOf(new Date());
  if (res.slots[nowKey] != null) return { pct: res.slots[nowKey], now: true };
  const next = Object.keys(res.slots).sort().find((k) => k >= nowKey);
  return next ? { pct: res.slots[next], at: next } : null;
}

// Is this sport's court fully booked right at this moment?
export function isFullyBooked(res) {
  const live = liveBooked(res);
  return !!live && live.now && live.pct === 100;
}
