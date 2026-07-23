#!/usr/bin/env node
/*
 * Build a city's outdoor-courts data file from its scraper config:
 *   node scripts/build-city-outdoor.js <cityId>     e.g. nyc
 * Config lives in scripts/cities/<cityId>.js; output lands in
 * data/cities/<cityId>/outdoor-courts.js (+ scripts/cities/<cityId>-cache.json).
 * Adapters are picked by the config's `kind` — only Socrata portals so far
 * (ArcGIS FeatureServer cities like Seattle/LA need a second adapter).
 */

const cityId = process.argv[2];
if (!cityId || !/^[a-z0-9-]+$/.test(cityId)) {
  console.error('Usage: node scripts/build-city-outdoor.js <cityId>   (e.g. nyc)');
  process.exit(1);
}

let cfg;
try {
  cfg = require(`./cities/${cityId}`);
} catch {
  console.error(`No config at scripts/cities/${cityId}.js`);
  process.exit(1);
}

const ADAPTERS = { socrata: require('./lib/socrata-outdoor').buildCityOutdoor };
const build = ADAPTERS[cfg.kind];
if (!build) {
  console.error(`Unknown adapter kind "${cfg.kind}" (have: ${Object.keys(ADAPTERS).join(', ')})`);
  process.exit(1);
}

build(cfg).catch((e) => {
  console.error('\n❌ Failed:', e.message);
  process.exit(1);
});
