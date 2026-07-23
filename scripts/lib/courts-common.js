/*
 * Shared helpers for the court build scripts (scripts/build-*.js and the
 * per-city adapters in scripts/lib/). Pure utilities only — no fetching, no
 * city knowledge. Extracted from build-outdoor-courts.js so new city builders
 * reuse the exact same conventions (minutes-from-midnight blocks, 0=Sun..6=Sat
 * weeks, name slugs) instead of re-copying them.
 */

const fs = require('fs');

// "Mission Bay Park" -> "mission-bay-park". SF court ids are built from this —
// never change its behavior (Supabase rows + on-device favorites key off ids).
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Minutes from midnight, the schedule unit used across all data files.
const time = (h, m = 0) => h * 60 + m;

// One empty drop-in week: no blocks any day (0=Sun..6=Sat).
const emptyWeek = () => [[], [], [], [], [], [], []];

// First-come outdoor courts have no posted schedule; model them as open a fixed
// daily window (approx. park hours) every day of the week.
const parkSchedule = (hours) => Array.from({ length: 7 }, () => [...hours]);

// One drop-in block per open day spanning the window — "available all open hours".
const allOpenHoursWeek = (sched) => sched.map((h) => (h ? [[h[0], h[1]]] : []));

// All tracked sports (keep in sync with lib/sports.js) + the weight-room facility
// view; every court carries a week for each so the dropins shape is uniform.
const ALL_SPORTS = ['basketball', 'volleyball', 'pingpong', 'badminton', 'pickleball', 'tennis', 'soccer', 'baseball', 'weightroom'];

// Last-good snapshot cache, shared format across builders: JSON file next to the
// script, pretty-printed with a trailing newline (diff-friendly when committed).
function loadCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

module.exports = { slug, time, emptyWeek, parkSchedule, allOpenHoursWeek, ALL_SPORTS, loadCache, saveCache };
