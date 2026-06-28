// The indoor sports HoopMap tracks drop-in open-gym times for. Court data stores
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

export const SPORT_BY_ID = Object.fromEntries(SPORTS.map((s) => [s.id, s]));

export function sportMeta(id) {
  return SPORT_BY_ID[id] || SPORT_BY_ID[DEFAULT_SPORT];
}
