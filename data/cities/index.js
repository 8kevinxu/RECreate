// Hand-written aggregator for the per-city generated court data (Metro needs
// static imports, so each city is one explicit line here + its entry in
// lib/cities.js + a scripts/cities/<id>.js scraper config).
//
// City files are COMPACT — each record lists its offered `sports` instead of
// carrying the app's uniform { schedule, dropins } shape (at ~700 pins per city
// the empty weeks would triple the bundled size). This module expands them at
// import: offered sports span the daily park-hours window, all other tracked
// sports get an empty week, matching data/outdoor-courts.js records exactly.

import { SPORTS, WEIGHT_ROOM } from '../../lib/sports';
import NYC, { CITY as NYC_CITY, PARK_HOURS as NYC_HOURS, SOURCE as NYC_SOURCE, DISCLAIMER as NYC_DISCLAIMER } from './nyc/outdoor-courts';
import NYC_INDOOR from './nyc/indoor-courts';
import NYC_CLASSES from './nyc/classes';

const SPORT_KEYS = [...SPORTS.map((s) => s.id), WEIGHT_ROOM];

function expandCity(courts, city, parkHours, source, disclaimer) {
  const schedule = Array.from({ length: 7 }, () => [...parkHours]);
  return courts.map((c) => {
    const dropins = {};
    for (const k of SPORT_KEYS) {
      dropins[k] = c.sports.includes(k)
        ? schedule.map((h) => [[h[0], h[1]]])
        : [[], [], [], [], [], [], []];
    }
    const { sports, ...rest } = c;
    return { ...rest, city, indoor: false, schedule, dropins, source, disclaimer };
  });
}

// city id -> expanded court list, merged into the app's court list by
// lib/useCourts.js (deduped by id there; city ids are prefixed so they can
// never collide with SF's bare slugs).
export const CITY_COURTS = {
  // Indoor rec centers carry full records (real per-sport schedules); outdoor
  // pins are compact and expanded here.
  [NYC_CITY]: [...NYC_INDOOR, ...expandCity(NYC, NYC_CITY, NYC_HOURS, NYC_SOURCE, NYC_DISCLAIMER)],
};

// city id -> class/program list (same record shape as data/classes.js). SF's
// ActiveNet catalog stays in data/classes.js; cities without one are absent.
export const CITY_CLASSES = {
  [NYC_CITY]: NYC_CLASSES,
};

export default CITY_COURTS;
