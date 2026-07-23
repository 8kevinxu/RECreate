// Supported metros. Every court record carries a `city` id (older cached/remote
// payloads may lack it — consumers must default to 'sf'); the app shows one
// city at a time, auto-detected from location with a manual override in
// Settings. `features` gates the city-specific surfaces: SF has the full
// product (classes, pools, rec.us reservations, court directory, golf); a
// courts-only city hides those tabs/sections entirely.
//
// Adding a city: one entry here + a scraper config in scripts/cities/<id>.js
// (see scripts/lib/socrata-outdoor.js) + an import line in data/cities/index.js.

export const CITIES = [
  {
    id: 'sf',
    name: 'San Francisco',
    center: { lat: 37.7749, lng: -122.4194 },
    zoom: 12,
    tz: 'America/Los_Angeles',
    // Generous: includes the adjacent Sharp Park / San Bruno assets the app covers.
    bbox: [37.2, -123.2, 38.3, -121.7], // [latMin, lngMin, latMax, lngMax]
    features: { classes: true, pools: true, reservations: true, directory: true, golf: true },
  },
  {
    id: 'nyc',
    name: 'New York City',
    center: { lat: 40.7549, lng: -73.984 },
    zoom: 11, // bigger metro than SF — start one step further out
    tz: 'America/New_York',
    bbox: [40.4, -74.3, 41.0, -73.6],
    // Optional sub-areas the user can filter the map/classes to (Settings).
    // Matched against a record's borough — court.neighborhood / class.borough.
    subregions: ['Bronx', 'Brooklyn', 'Manhattan', 'Queens', 'Staten Island'],
    // classes: the free NYC Parks programs feed (build-nyc-classes.js).
    features: { classes: true, pools: false, reservations: false, directory: false, golf: false },
  },
];

export const DEFAULT_CITY = 'sf';

// A record's sub-area for the subregion filter: courts store it in
// `neighborhood`, classes in `borough`. Empty string when unknown.
export function recordSubregion(r) {
  return (r && (r.borough || r.neighborhood)) || '';
}

// Does a record pass the selected subregions? An empty/absent selection means
// "all"; a record with an unknown sub-area is never hidden.
export function inSubregions(r, selected) {
  if (!selected || !selected.length) return true;
  const s = recordSubregion(r);
  return !s || selected.includes(s);
}

export function getCity(id) {
  return CITIES.find((c) => c.id === id) || CITIES.find((c) => c.id === DEFAULT_CITY);
}

// The supported city containing (lat, lng), or null when outside all of them
// (the caller falls back to DEFAULT_CITY). Bboxes don't overlap, so first match
// wins; nearest-center is the tiebreaker if they ever do.
export function nearestCity(lat, lng) {
  const inside = CITIES.filter(
    (c) => lat >= c.bbox[0] && lat <= c.bbox[2] && lng >= c.bbox[1] && lng <= c.bbox[3]
  );
  if (!inside.length) return null;
  if (inside.length === 1) return inside[0];
  const d2 = (c) => (c.center.lat - lat) ** 2 + (c.center.lng - lng) ** 2;
  return inside.sort((a, b) => d2(a) - d2(b))[0];
}

export default CITIES;
