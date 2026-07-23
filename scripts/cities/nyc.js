/*
 * New York City — outdoor courts & fields from NYC Open Data (Socrata).
 * Run: npm run build:nyc  (node scripts/build-city-outdoor.js nyc)
 *
 * Facilities: "Athletic Facilities" (qnem-b8re) — one row per court/field with
 * boolean per-sport columns, a `gispropnum` park-property key, and a WGS84
 * multipolygon footprint (centroid -> pin). Only `featurestatus='Active'` rows
 * count (retired facilities linger in the dataset).
 * Park names/addresses: "Parks Properties" (enfh-gkve), joined by gispropnum;
 * `borough` codes map to names below.
 *
 * Sports NYC tracks that the app has no sport for (handball, bocce, cricket,
 * football, track) are intentionally unmapped. No pingpong/badminton source.
 */

module.exports = {
  cityId: 'nyc', // must match lib/cities.js
  cityName: 'New York City',
  kind: 'socrata',
  domain: 'data.cityofnewyork.us',
  attribution: 'NYC Open Data: Athletic Facilities qnem-b8re + Parks Properties enfh-gkve',
  facilities: {
    datasetId: 'qnem-b8re',
    where: "featurestatus='Active'",
    parkKeyField: 'gispropnum',
    geoField: 'multipolygon',
    // boolean column -> app sport(s). Diamonds of every size roll up to
    // baseball; both soccer designations roll up to soccer (mirrors SF, where
    // Ball Field -> baseball and Soccer Field/Multi-Use Turf -> soccer).
    sportFlags: {
      basketball: ['basketball'],
      tennis: ['tennis'],
      volleyball: ['volleyball'],
      pickleball: ['pickleball'],
      adult_baseball: ['baseball'],
      adult_softball: ['baseball'],
      ll_baseb_12andunder: ['baseball'],
      ll_baseb_13andolder: ['baseball'],
      ll_softball: ['baseball'],
      t_ball: ['baseball'],
      regulation_soccer: ['soccer'],
      nonregulation_soccer: ['soccer'],
    },
    // Per-row facility facts aggregated into each pin's per-sport `facts`
    // (court count, lighting, surfaces) + park-level `accessible`.
    factFields: { lighted: 'field_lighted', accessible: 'accessible', surface: 'surface_type' },
  },
  lookup: {
    datasetId: 'enfh-gkve',
    keyField: 'gispropnum',
    fields: { name: 'name311', address: 'address', area: 'borough' },
  },
  areaNames: { X: 'Bronx', B: 'Brooklyn', M: 'Manhattan', Q: 'Queens', R: 'Staten Island' },
  bbox: [40.4, -74.3, 41.0, -73.6], // keep in sync with lib/cities.js
  parkHours: [480, 1200], // 8 AM – 8 PM, same model as SF outdoor courts
  minCourtsOk: 350, // ~half of the ~700 park pins seen at launch
  source: 'nycparks-outdoor',
  disclaimer: 'Outdoor public courts — first-come; verify on nycgovparks.org.',
};
