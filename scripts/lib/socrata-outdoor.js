/*
 * Generic outdoor-courts builder for cities that publish per-court facility
 * records on a Socrata open-data portal (the same platform behind DataSF).
 * Driven entirely by a per-city config module in scripts/cities/<id>.js and run
 * via scripts/build-city-outdoor.js — adding a Socrata city is config only.
 *
 * Model matches SF's outdoor courts (build-outdoor-courts.js): one pin per park
 * property, offering the union of the sports its court/field records list,
 * open a fixed daily park-hours window (no posted drop-in schedules). Output is
 * COMPACT — each record carries a `sports` array instead of the uniform
 * all-sports `dropins` shape; data/cities/index.js expands it at import so the
 * bundled module stays small (~700 NYC pins).
 *
 * Config shape (see scripts/cities/nyc.js):
 *   cityId/cityName    — registry id (must exist in lib/cities.js) + label
 *   domain             — Socrata portal host
 *   facilities         — { datasetId, where, parkKeyField, geoField, sportFlags }
 *     sportFlags       — { <boolean column>: [sport ids it maps to] }
 *   lookup             — { datasetId, keyField, fields:{name,address,area} }
 *     (park-property dataset joined by parkKeyField for name/address)
 *   areaNames          — optional map for lookup `area` codes (e.g. NYC boroughs)
 *   bbox               — [latMin, lngMin, latMax, lngMax] sanity filter
 *   parkHours          — [openMin, closeMin] daily window
 *   minCourtsOk        — gate: abort (keep last data) under this many pins
 *   source/disclaimer/verifyOn — provenance strings for the records
 *
 * Resilience mirrors the SF builders: live fetch -> last-good cache
 * (scripts/cities/<id>-cache.json) -> abort keeping the existing data file.
 * A future non-Socrata city (ArcGIS FeatureServer — Seattle/LA) gets its own
 * adapter module; the runner picks by config `kind`.
 */

const fs = require('fs');
const path = require('path');
const { fetchT } = require('../fetch-timeout');
const { slug, loadCache, saveCache } = require('./courts-common');

const UA = { 'User-Agent': 'RECreate/1.0', Accept: 'application/json' };
const PAGE = 1000;

// Display order for the sports in a pin's note (same as SF's builder).
const ORDER = ['basketball', 'volleyball', 'tennis', 'pickleball', 'soccer', 'baseball', 'weightroom'];

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Amenity join: a court-level boolean set true when the park has a matching
// row in another portal dataset. Two join kinds:
//   'key'  — join by the same park key (e.g. gispropnum) → Set of keys
//   'name' — join by normalized park name (+ optional area/borough) → Set of
//            "name|area" strings (the facilities dataset has no name, so this
//            resolves against the lookup-derived name in buildCourts)
async function fetchAmenitySet(domain, spec) {
  const cols = spec.kind === 'key' ? [spec.keyField] : [spec.nameField, spec.areaField].filter(Boolean);
  const rows = await fetchAllRows(domain, spec.datasetId, {
    $select: cols.join(','),
    ...(spec.where ? { $where: spec.where } : {}),
  });
  const set = new Set();
  for (const r of rows) {
    if (spec.kind === 'key') {
      if (r[spec.keyField]) set.add(r[spec.keyField]);
    } else {
      const nm = normName(r[spec.nameField]);
      if (nm) set.add(spec.areaField ? `${nm}|${r[spec.areaField] || ''}` : nm);
    }
  }
  return set;
}

async function fetchAllRows(domain, datasetId, params) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    // $order is required for stable paging — without it Socrata may repeat or
    // skip rows across pages (seen in practice: ~30% of lookup rows missing).
    const qs = new URLSearchParams({ ...params, $order: ':id', $limit: String(PAGE), $offset: String(offset) });
    const url = `https://${domain}/resource/${datasetId}.json?${qs}`;
    const res = await fetchT(url, { headers: UA }, 60000);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${datasetId}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// Average of every vertex across the (multi)polygon — plenty for a park pin.
function centroid(geo) {
  let lat = 0;
  let lng = 0;
  let n = 0;
  const walk = (a) => {
    if (typeof a[0] === 'number') {
      lng += a[0];
      lat += a[1];
      n++;
    } else a.forEach(walk);
  };
  if (geo && Array.isArray(geo.coordinates)) walk(geo.coordinates);
  return n ? { lat: lat / n, lng: lng / n } : null;
}

function noteFor(sports) {
  const list = ORDER.filter((s) => sports.includes(s)).join(' & ');
  return `Outdoor ${list} — first-come, open during park hours (no posted drop-in schedule).`;
}

// Group facility rows by park property; union sports; average row centroids.
// Per-sport facility facts (court count, lighting, surfaces) and park-level
// accessibility aggregate from cfg.facilities.factFields when configured:
//   { lighted: '<bool col>', accessible: '<bool col>', surface: '<text col>' }
function buildParks(rows, cfg) {
  const { parkKeyField, geoField, sportFlags, factFields = {} } = cfg.facilities;
  const [latMin, lngMin, latMax, lngMax] = cfg.bbox;
  const truthy = (v) => v === true || v === 'true';
  const byPark = new Map();
  for (const r of rows) {
    const key = r[parkKeyField];
    if (!key) continue;
    const sports = new Set();
    for (const [flag, mapped] of Object.entries(sportFlags)) {
      if (truthy(r[flag])) mapped.forEach((s) => sports.add(s));
    }
    if (!sports.size) continue;
    const c = centroid(r[geoField]);
    if (!c || c.lat < latMin || c.lat > latMax || c.lng < lngMin || c.lng > lngMax) continue;
    let p = byPark.get(key);
    if (!p) {
      p = { key, sports: new Set(), lat: 0, lng: 0, n: 0, facts: {}, accessible: false };
      byPark.set(key, p);
    }
    const lighted = factFields.lighted ? truthy(r[factFields.lighted]) : false;
    const surface = factFields.surface ? String(r[factFields.surface] || '').trim() : '';
    for (const s of sports) {
      p.sports.add(s);
      let f = p.facts[s];
      if (!f) f = p.facts[s] = { n: 0, lit: false, surf: [] };
      f.n++; // one dataset row = one court/field
      if (lighted) f.lit = true;
      if (surface && !f.surf.includes(surface)) f.surf.push(surface);
    }
    if (factFields.accessible && truthy(r[factFields.accessible])) p.accessible = true;
    p.lat += c.lat;
    p.lng += c.lng;
    p.n++;
  }
  return [...byPark.values()].map((p) => ({
    key: p.key,
    sports: [...p.sports],
    facts: p.facts,
    accessible: p.accessible,
    lat: Number((p.lat / p.n).toFixed(6)),
    lng: Number((p.lng / p.n).toFixed(6)),
  }));
}

function buildCourts(parks, lookupByKey, cfg, amenitySets = {}) {
  // Deterministic ids: assign in park-key order, and when two properties share
  // a name slug (NYC repeats playground names across boroughs), suffix BOTH
  // with their park key — a weekly cron must never churn ids (check-ins,
  // reviews, and favorites key off them).
  parks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const slugCount = new Map();
  for (const p of parks) {
    const row = lookupByKey[p.key] || {};
    p.name = row.name || `Park ${p.key}`;
    p.address = row.address || '';
    p.neighborhood = row.area || '';
    const s = slug(p.name);
    slugCount.set(s, (slugCount.get(s) || 0) + 1);
  }
  const amenityCfg = cfg.amenities || {};
  const reservable = cfg.reservable; // { sports:[...], booking:{ url, permit } }
  return parks
    .map((p) => {
      const base = slug(p.name);
      const id =
        slugCount.get(base) > 1
          ? `${cfg.cityId}-${base}-${p.key.toLowerCase()}-outdoor`
          : `${cfg.cityId}-${base}-outdoor`;
      const facts = {};
      for (const s of ORDER) if (p.facts[s]) facts[s] = { ...p.facts[s] };
      const rec = {
        id,
        name: p.name,
        address: p.address,
        neighborhood: p.neighborhood,
        lat: p.lat,
        lng: p.lng,
        sports: ORDER.filter((s) => p.sports.includes(s)),
        facts,
        accessible: p.accessible,
        // Any lighted facility ⇒ the park pin counts as lit (the card's Lights
        // chip; per-sport truth lives in facts[sport].lit).
        lights: Object.values(p.facts).some((f) => f.lit),
        notes: noteFor(p.sports),
      };
      // Court-level amenities from other portal datasets (water/restrooms/…).
      for (const [name, spec] of Object.entries(amenityCfg)) {
        const set = amenitySets[name];
        if (!set) continue;
        const hit =
          spec.kind === 'key'
            ? set.has(p.key)
            : set.has(spec.areaField ? `${normName(p.name)}|${p.neighborhood}` : normName(p.name));
        if (hit) rec[name] = true;
      }
      // Reservable sports (e.g. NYC tennis permit system): flag the sport +
      // attach a court-level booking link/guidelines for the render.
      if (reservable) {
        const has = reservable.sports.filter((s) => rec.sports.includes(s));
        if (has.length) {
          for (const s of has) if (rec.facts[s]) rec.facts[s].reservable = true;
          rec.booking = reservable.booking;
        }
      }
      return rec;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

function render(courts, cfg, generatedAt, scheduleSource) {
  const body = courts
    .map(
      (c) => `  {
    id: ${JSON.stringify(c.id)},
    name: ${JSON.stringify(c.name)},
    address: ${JSON.stringify(c.address)},
    neighborhood: ${JSON.stringify(c.neighborhood)},
    lat: ${c.lat},
    lng: ${c.lng},
    sports: ${JSON.stringify(c.sports)},
    facts: ${JSON.stringify(c.facts || {})},
    accessible: ${!!c.accessible},${c.lights ? '\n    lights: true,' : ''}${c.restrooms ? '\n    restrooms: true,' : ''}${c.water ? '\n    water: true,' : ''}${c.booking ? `\n    booking: ${JSON.stringify(c.booking)},` : ''}
    notes: ${JSON.stringify(c.notes)},
  },`
    )
    .join('\n');

  return `// AUTO-GENERATED by scripts/build-city-outdoor.js ${cfg.cityId} — do not edit by hand.
// Regenerate with: npm run build:${cfg.cityId}
// Generated: ${generatedAt}
//
// ${cfg.cityName} outdoor public courts & fields (${cfg.attribution}).
// One pin per park property, offering the union of its records' sports. These
// are first-come courts with no posted drop-in schedule, modeled as open a
// fixed daily park-hours window. COMPACT format: \`sports\` lists what's
// offered; data/cities/index.js expands each record to the app's uniform
// { schedule, dropins } shape at import.
//
// scheduleSource = ${JSON.stringify(scheduleSource)} ("live" fetched this run | "cache" last good)

export const GENERATED_AT = ${JSON.stringify(generatedAt)};
export const CITY = ${JSON.stringify(cfg.cityId)};
export const PARK_HOURS = ${JSON.stringify(cfg.parkHours)};
export const SOURCE = ${JSON.stringify(cfg.source)};
export const DISCLAIMER = ${JSON.stringify(cfg.disclaimer)};

export const OUTDOOR_COURTS = [
${body}
];

export default OUTDOOR_COURTS;
`;
}

async function buildCityOutdoor(cfg) {
  const cacheFile = path.join(__dirname, '..', 'cities', `${cfg.cityId}-cache.json`);
  const outDir = path.join(__dirname, '..', '..', 'data', 'cities', cfg.cityId);
  const outFile = path.join(outDir, 'outdoor-courts.js');

  console.log(`Fetching ${cfg.cityName} outdoor courts from ${cfg.domain}…`);
  let courts;
  let scheduleSource;
  try {
    const { datasetId, where, parkKeyField, geoField, sportFlags, factFields = {} } = cfg.facilities;
    const flagOr = Object.keys(sportFlags)
      .map((f) => `${f}=true`)
      .join(' OR ');
    const rows = await fetchAllRows(cfg.domain, datasetId, {
      $select: [parkKeyField, geoField, ...Object.keys(sportFlags), ...Object.values(factFields)].join(','),
      $where: `${where} AND (${flagOr})`,
    });
    const parks = buildParks(rows, cfg);

    const lk = cfg.lookup;
    const lookupRows = await fetchAllRows(cfg.domain, lk.datasetId, {
      $select: [lk.keyField, ...Object.values(lk.fields)].join(','),
    });
    const lookupByKey = {};
    for (const r of lookupRows) {
      const key = r[lk.keyField];
      if (!key || lookupByKey[key]) continue;
      const area = r[lk.fields.area] || '';
      lookupByKey[key] = {
        name: r[lk.fields.name] || '',
        address: r[lk.fields.address] || '',
        area: (cfg.areaNames && cfg.areaNames[area]) || area,
      };
    }

    // Court-level amenity joins from other portal datasets (config-driven).
    const amenitySets = {};
    for (const [name, spec] of Object.entries(cfg.amenities || {})) {
      try {
        amenitySets[name] = await fetchAmenitySet(cfg.domain, spec);
      } catch (e) {
        console.log(`  ⚠ amenity "${name}" (${spec.datasetId}): ${e.message} — skipped this run`);
      }
    }

    courts = buildCourts(parks, lookupByKey, cfg, amenitySets);
    if (courts.length < cfg.minCourtsOk) {
      throw new Error(`only ${courts.length} parks (min ${cfg.minCourtsOk}) — dataset may have changed`);
    }
    scheduleSource = 'live';
    saveCache(cacheFile, { courts, fetchedAt: new Date().toISOString() });
    const count = (sport) => courts.filter((c) => c.sports.includes(sport)).length;
    const amenityCount = (f) => courts.filter((c) => c[f]).length;
    console.log(
      `  ✓ ${courts.length} parks — ` +
        ORDER.filter((s) => count(s))
          .map((s) => `${count(s)} ${s}`)
          .join(', ') +
        ' (live)'
    );
    console.log(
      `  amenities: ${amenityCount('restrooms')} restrooms, ${amenityCount('water')} water, ` +
        `${amenityCount('booking')} reservable`
    );
  } catch (e) {
    const cache = loadCache(cacheFile);
    if (!cache || !Array.isArray(cache.courts)) {
      throw new Error(`fetch failed (${e.message}) and no cache available — ${outFile} left unchanged`);
    }
    courts = cache.courts;
    scheduleSource = 'cache';
    console.log(`  ↺ fetch failed (${e.message}); using cache from ${cache.fetchedAt || 'unknown'}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, render(courts, cfg, new Date().toISOString(), scheduleSource));
  console.log(`\n✅ Wrote ${courts.length} outdoor courts to data/cities/${cfg.cityId}/outdoor-courts.js (${scheduleSource})`);
}

module.exports = { buildCityOutdoor };
