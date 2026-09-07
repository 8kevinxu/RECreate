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
// WebView's <style>, web into its own <style> block).
//
// It sits in the BOTTOM-RIGHT corner as plain hairline text, not as a chip. Two
// separate decisions, both arrived at by looking at it on a 390pt screen:
//
//   * No pill. A white rounded background with a drop shadow is the exact
//     costume every interactive control in this app wears, so the credit read
//     as a third button stacked above Nearby — the eye kept going to it. The
//     text alone, with a white halo for contrast over the map, reads as map
//     furniture and stops competing. The halo replaces the pill's job.
//   * Bottom-right. The left-hand column is the primary control stack (Nearby,
//     and the court card slides up over it); the right side holds only the
//     recenter button, which --attrib-bottom already clears. Lower-right is
//     also the corner the OSM guidelines call traditional. Both maps therefore
//     call setPosition('bottomright') — the CSS `right` offset resolves against
//     Leaflet's zero-width corner container, so the two must agree.
//
// The other corners were tried and are physically unavailable: below the Nearby
// pill the bottom nav covers it, and top-left is under the "Updated" chip and
// the location banner.
//
// Colour is #5d6b7a rather than the old #6b7a89: shrinking type means raising
// contrast, not lowering it. The old pair cleared only ~4.4:1 against white,
// under the 4.5:1 WCAG AA floor the OSM guidelines point at ("legible and
// understandable, taking into consideration the font, size, colour, contrast").
// There is no numeric minimum size in either licence — legibility is the test —
// so 9.5px is a floor set by reading it, not by a rule.
//
// The !important flags are load-bearing: Leaflet's own stylesheet targets
// `.leaflet-container .leaflet-control-attribution` (two classes) and outranks
// a bare class selector, which is why the previous background/padding values
// here were silently never applied.
export const ATTRIB_CSS = `
  .leaflet-control-attribution {
    position: absolute !important;
    right: 15px;
    bottom: var(--attrib-bottom, 48px);
    margin: 0 !important;
    padding: 0 !important;
    background: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    font: 500 9.5px/1.4 -apple-system, system-ui, sans-serif;
    color: #5d6b7a;
    white-space: nowrap;
    text-shadow: 0 0 2px #fff, 0 0 4px #fff, 0 0 6px #fff;
  }
  .leaflet-control-attribution a { color: #5d6b7a; text-decoration: none; }
`;

// CARTO is retiring the raster service in favour of vector tiles, and says keys
// are coming to vector too. When that lands this module becomes a MapLibre style
// URL — or points at OpenFreeMap, which serves an equivalent OpenMapTiles style
// with no key, no limits and commercial use allowed. Either way the change is
// confined to this file plus the tileLayer call in each map.
