// The indoor sports RECreate tracks drop-in open-gym times for. Court data stores
// blocks under `dropins[sportId]` (see lib/hours.js); the UI shows one sport at a
// time, chosen via the sport toggle. `basketball` is the default / primary sport.

export const SPORTS = [
  { id: 'basketball', label: 'Basketball', emoji: '🏀' },
  { id: 'volleyball', label: 'Volleyball', emoji: '🏐' },
  { id: 'pingpong', label: 'Ping Pong', emoji: '🏓' },
  { id: 'pickleball', label: 'Pickleball', emoji: '🥒' },
  { id: 'tennis', label: 'Tennis', emoji: '🎾' },
];

export const DEFAULT_SPORT = 'basketball';

// "Just down for some recreation" — a sport-less signal. Not a real drop-in sport
// (no court schedules key off it); used only by "down to play" signals when the
// poster doesn't care what they play. Label is localized via sportLabel/`sport.any`.
export const ANY_SPORT = 'any';
const ANY_META = { id: ANY_SPORT, label: 'Anything', emoji: '🤸' };

export const SPORT_BY_ID = Object.fromEntries(SPORTS.map((s) => [s.id, s]));

export function sportMeta(id) {
  if (id === ANY_SPORT) return ANY_META;
  return SPORT_BY_ID[id] || SPORT_BY_ID[DEFAULT_SPORT];
}
