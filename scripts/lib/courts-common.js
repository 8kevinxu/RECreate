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
// daily window every day of the week — each city passes its own published park
// hours (SF: 5 AM–midnight; a close of 1440 is fine, see lib/hours.js `fmt`).
const parkSchedule = (hours) => Array.from({ length: 7 }, () => [...hours]);

// One drop-in block per open day spanning the window — "available all open hours".
const allOpenHoursWeek = (sched) => sched.map((h) => (h ? [[h[0], h[1]]] : []));

// All tracked sports (keep in sync with lib/sports.js) + the weight-room facility
// view; every court carries a week for each so the dropins shape is uniform.
const ALL_SPORTS = ['basketball', 'volleyball', 'pingpong', 'badminton', 'pickleball', 'tennis', 'soccer', 'baseball', 'handball', 'weightroom'];

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

// A cache fallback is a safety net, not a steady state. Every build here falls
// back to its last-good cache and exits 0, which is right for one bad run and
// wrong for thirty: nycgovparks.org began answering GitHub's runner IPs with
// HTTP 405 in early August 2026 and every NYC build served cache for three
// weeks while the workflow reported success on every run. Nothing was watching
// the one line that said so.
//
// Call this after writing the output. It leaves the data in place — stale data
// beats no data — but marks the run failed so the workflow surfaces it. Age is
// measured from the cache's own `fetchedAt`, so it reflects when the data was
// really collected, not when the file was last rewritten.
function reportStale(source, cache, { label, maxHours = 72 } = {}) {
  if (source !== 'cache') return false;
  const at = cache && cache.fetchedAt ? Date.parse(cache.fetchedAt) : NaN;
  const hours = Number.isFinite(at) ? (Date.now() - at) / 36e5 : Infinity;
  if (hours <= maxHours) {
    console.log(`  ⓘ ${label}: serving cache from ${cache.fetchedAt} (${hours.toFixed(0)}h old, limit ${maxHours}h)`);
    return false;
  }
  const age = Number.isFinite(hours) ? `${(hours / 24).toFixed(1)} days old` : 'of unknown age';
  // ::error:: renders in the GitHub Actions run summary, not just the log.
  console.error(`::error::${label}: live source unreachable and the cache is ${age} (limit ${maxHours}h). The data shipped is stale — fix the source.`);
  process.exitCode = 1;
  return true;
}

module.exports = { slug, time, emptyWeek, parkSchedule, allOpenHoursWeek, ALL_SPORTS, loadCache, saveCache, reportStale };
