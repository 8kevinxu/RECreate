// The basemap under both map surfaces: CARTO Voyager — colourful but clean
// (green parks, blue water, soft roads) with no mountain/peak symbols.
//
// Shared by components/CourtMap.js (the WebView HTML) and CourtMap.web.js so
// the two cannot drift on the key or the attribution, which is the one part of
// those files where drift is not merely cosmetic.
//
// WHY THERE IS A KEY AT ALL. CARTO served these raster tiles without one for
// years and started requiring a key in Aug 2026: keyless requests now come back
// stamped "API KEY REQUIRED" *in the PNG itself*, so it is not something the
// client can style or work around. A key is free and issued instantly with no
// approval queue — https://carto.com/basemaps/apikey — and the allowance is 5M
// tiles/month counted across the raster and vector services.
//
// Unset, the map still draws (watermarked). That is deliberate: a watermarked
// map beats a blank one, and it keeps `npx expo start` working on a fresh clone
// with no .env, the way every other EXPO_PUBLIC_ var in this app degrades.
const KEY = process.env.EXPO_PUBLIC_CARTO_KEY || '';

export const TILE_URL =
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png' +
  (KEY ? `?key=${encodeURIComponent(KEY)}` : '');

// ATTRIBUTION IS A CONDITION OF THE FREE TIER, not a style choice: "CARTO and
// OpenStreetMap attribution must stay on your maps. That is what the free tier
// is in exchange for." Both maps used to pass an attribution string with
// `attributionControl: false`, i.e. rendered it nowhere. Don't go back to that
// while the key is in use — turning the control off is the failure mode this
// comment exists to prevent.
export const TILE_ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

// detectRetina swaps {r} for @2x on dense displays; maxZoom matches what the
// Voyager raster service actually publishes.
export const TILE_OPTS = { maxZoom: 20, subdomains: 'abcd', detectRetina: true };

// Attribution styling, shared verbatim by both maps (native injects it into the
// WebView's <style>, web into its own <style> block). Small, low-contrast and
// lifted clear of the Nearby pill via --attrib-bottom, which each map sets from
// its bottomInset prop — the safe-area inset differs per device, so a fixed
// offset collides with the pill on a notched phone.
export const ATTRIB_CSS = `
  .leaflet-control-attribution {
    position: absolute !important;
    left: 14px;
    bottom: var(--attrib-bottom, 48px);
    margin: 0 !important;
    padding: 2px 7px;
    border-radius: 9px;
    background: rgba(255,255,255,0.72);
    font: 500 9.5px/1.5 -apple-system, system-ui, sans-serif;
    color: #6b7a89;
    white-space: nowrap;
    box-shadow: 0 1px 2px rgba(0,0,0,0.10);
  }
  .leaflet-control-attribution a { color: #6b7a89; text-decoration: none; }
`;

// CARTO is retiring the raster service in favour of vector tiles, and says keys
// are coming to vector too. When that lands this module becomes a MapLibre style
// URL — or points at OpenFreeMap, which serves an equivalent OpenMapTiles style
// with no key, no limits and commercial use allowed. Either way the change is
// confined to this file plus the tileLayer call in each map.
