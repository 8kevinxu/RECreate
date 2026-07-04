// The indoor sports RECreate tracks drop-in open-gym times for. Court data stores
// blocks under `dropins[sportId]` (see lib/hours.js); the UI shows one sport at a
// time, chosen via the sport toggle. `basketball` is the default / primary sport.

// Playable sports: you can organize runs / post "down to play" signals / favorite
// these. Kept as its own list so the weight room (below) never leaks into those.
export const SPORTS = [
  { id: 'basketball', label: 'Basketball', emoji: '🏀' },
  { id: 'volleyball', label: 'Volleyball', emoji: '🏐' },
  { id: 'pingpong', label: 'Ping Pong', emoji: '🏓' },
  // No Unicode pickleball emoji exists; components/SportGlyph.js draws a real
  // holed ball, and this 🟢 is only the text fallback where a glyph isn't wired.
  { id: 'pickleball', label: 'Pickleball', emoji: '🟢' },
  { id: 'tennis', label: 'Tennis', emoji: '🎾' },
  { id: 'soccer', label: 'Soccer', emoji: '⚽' },
];

export const DEFAULT_SPORT = 'basketball';

// The rec-center weight room — a facility view with open-gym-style drop-in hours
// (scraped into dropins.weightroom like a sport), but NOT something you organize a
// game for. It's selectable on the map alongside the sports yet excluded from
// SPORTS, so runs/signals/favorites/profile never offer it.
export const WEIGHT_ROOM = 'weightroom';
const WEIGHT_ROOM_META = { id: WEIGHT_ROOM, label: 'Weight Room', emoji: '🏋️' };

// Everything selectable in the map's sport speed-dial: playable sports + the
// weight-room facility view.
export const MAP_SPORTS = [...SPORTS, WEIGHT_ROOM_META];

// Sports offered in the social composers — Plan a session (RunModal) and "I'm
// down" signals (SignalModal): the playable sports plus the weight room, since you
// can plan or signal a lifting session even though it isn't a pickup "game".
// (Favorites/profile stay sports-only, so the weight room isn't offered there.)
export const PLAN_SPORTS = [...SPORTS, WEIGHT_ROOM_META];

// Is this a playable sport (vs. a facility view like the weight room)? Guards the
// hand-off to social features so they never inherit a weight-room "sport".
export const isPlayableSport = (id) => SPORTS.some((s) => s.id === id);

// "Just down for some recreation" — a sport-less signal. Not a real drop-in sport
// (no court schedules key off it); used only by "down to play" signals when the
// poster doesn't care what they play. Label is localized via sportLabel/`sport.any`.
export const ANY_SPORT = 'any';
const ANY_META = { id: ANY_SPORT, label: 'Anything', emoji: '🤸' };

export const SPORT_BY_ID = Object.fromEntries(MAP_SPORTS.map((s) => [s.id, s]));

export function sportMeta(id) {
  if (id === ANY_SPORT) return ANY_META;
  return SPORT_BY_ID[id] || SPORT_BY_ID[DEFAULT_SPORT];
}
