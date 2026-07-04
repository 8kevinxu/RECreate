// Small date helpers shared by the map's time picker and the "plan a run" form.
import { tg } from './i18n';

// Localized short weekday name (0=Sun..6=Sat). The clock (AM/PM) stays numeric
// across languages, so only the words around it are translated.
const dayShort = (dow) => tg('day.' + dow);

// English weekday tokens as they appear in scraped ActiveNet schedule strings.
const EN_DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Localize the weekday words (and "Noon") inside a scraped class schedule string
// like "Tue & Thu · 12:30 PM - Noon" → zh "周二 & 周四 · 12:30 PM - 中午". Times and
// AM/PM stay numeric (mirrors dayShort's convention); the source text is English.
export function localizeWhen(when) {
  if (!when) return when;
  return String(when)
    .replace(/\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/g, (m) => dayShort(EN_DOW[m.toLowerCase()]))
    .replace(/\bNoon\b/g, tg('time.noon'));
}

// Course term from ISO dates → compact numeric range, matching the app's M/D
// convention (dayChipLabel). "6/11 – 8/13/2026" same year, else both years; a
// single/one-day date → "6/11/2026". Parsed by hand (not new Date(iso)) to dodge
// UTC-midnight off-by-one. Returns null when there's no start date.
export function formatDateRange(start, end) {
  if (!start) return null;
  const p = (iso) => iso.split('-').map(Number); // [y, m, d]
  const [ys, ms, ds] = p(start);
  if (!end || end === start) return `${ms}/${ds}/${ys}`;
  const [ye, me, de] = p(end);
  return ys === ye ? `${ms}/${ds} – ${me}/${de}/${ye}` : `${ms}/${ds}/${ys} – ${me}/${de}/${ye}`;
}

// 15, 30 → "12:30 PM"; whole hours drop the minutes ("12 PM").
export function fmtClock(h24, m) {
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Whole-day difference from today (0 = today, 1 = tomorrow, …).
export function dayDelta(d) {
  return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
}

// Day-chip label: "Today" / "Tue 6/22".
export function dayChipLabel(d) {
  if (dayDelta(d) === 0) return tg('date.today');
  return `${dayShort(d.getDay())} ${d.getMonth() + 1}/${d.getDate()}`;
}

// Minutes → "1h 20m" / "2h" / "45m" (empty for 0 or less).
export function fmtDuration(mins) {
  if (!mins || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const H = tg('dur.h');
  const M = tg('dur.m');
  if (h && m) return `${h}${H} ${m}${M}`;
  if (h) return `${h}${H}`;
  return `${m}${M}`;
}

// "Today 3 PM" / "Tue 6/22 6 PM".
export function viewLabel(date) {
  const d = new Date(date);
  const day = dayDelta(d) === 0 ? tg('date.today') : dayChipLabel(d);
  return `${day} ${fmtClock(d.getHours(), d.getMinutes())}`;
}
