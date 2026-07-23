// "Recommended for you": a mixed, soonest/nearest-first list of things to do right
// now. Three tiers, tried in priority order:
//   1. Interests — open-gym games for the user's favorite sports + rec-center classes
//      with openings in their favorite categories (both set on the profile).
//   2. Previous activity — when no interests are set, fall back to what they've
//      actually done: the sports they've checked into, surfacing their most-visited
//      court first. (Passed in as `history`, derived from player check-ins.)
//   3. Nearby — with neither interests nor history, just recommend what's closest
//      (any sport, any class) so a brand-new user still sees useful suggestions.
// All data is bundled (no network). The Social tab's revolving pane cycles through
// whatever this returns.
import { CLASSES } from '../data/classes';
import { haversineMiles } from './distance';

export function buildRecommendations({
  courts = [],
  userLocation = null,
  sports = [],
  categories = [],
  history = null,
  age = null,
  now = new Date(),
  max = 10,
  // The active city's class catalog (SF ActiveNet by default; NYC passes its
  // Parks-events list, and a courts-only city passes []) so users are never
  // recommended classes in another metro.
  classes = CLASSES,
} = {}) {
  const dow = now.getDay();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dist = (lat, lng) =>
    userLocation && lat != null
      ? haversineMiles(userLocation.lat, userLocation.lng, lat, lng)
      : null;

  // Interests take precedence; only when none are set do we lean on check-in history.
  const hasInterests = sports.length > 0 || categories.length > 0;
  const histSports = !hasInterests && history?.sports?.length ? history.sports : null;
  const histCourts =
    !hasInterests && history?.courtIds?.length ? new Set(history.courtIds) : null;

  // --- Sports: a court running open gym now or later today for a wanted sport ---
  // Wanted sports: favorites (tier 1) → checked-in sports (tier 2) → any (tier 3).
  const wantSports = sports.length ? sports : histSports; // null/undefined = any sport
  const sportRecs = [];
  for (const c of courts) {
    if (!c.dropins) continue;
    for (const sp of Object.keys(c.dropins)) {
      if (wantSports && !wantSports.includes(sp)) continue;
      const today = (c.dropins[sp] || [])[dow] || [];
      let best = null; // earliest block still open today
      for (const blk of today) {
        const start = blk[0];
        const end = blk[1];
        if (end <= nowMin) continue;
        if (!best || start < best.startMin) best = { startMin: start, endMin: end };
      }
      if (!best) continue;
      sportRecs.push({
        kind: 'sport',
        key: `sport:${c.id}:${sp}:${best.startMin}`,
        sport: sp,
        courtId: c.id,
        courtName: c.name,
        lat: c.lat,
        lng: c.lng,
        startMin: best.startMin,
        ongoing: best.startMin <= nowMin,
        distanceMi: dist(c.lat, c.lng),
      });
    }
  }
  sportRecs.sort((a, b) => {
    // Tier 2: bubble the user's most-visited court(s) to the top.
    const pa = histCourts && histCourts.has(a.courtId) ? 0 : 1;
    const pb = histCourts && histCourts.has(b.courtId) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const sa = a.ongoing ? nowMin : a.startMin;
    const sb = b.ongoing ? nowMin : b.startMin;
    if (sa !== sb) return sa - sb;
    return (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity);
  });

  // --- Classes: a wanted category, with openings, appropriate for the user's age ---
  // Age (when the profile has it) gently steers class picks: don't push a program at
  // someone below its minimum, keep senior programs to seniors, and float senior
  // programs to the top for older users. Unknown age = no age filtering.
  const SENIOR_AGE = 55;
  const isSenior = (cl) => cl.minAge >= SENIOR_AGE || /senior/i.test(cl.name);
  const ageFits = (cl) => {
    if (age == null) return true;
    if (cl.minAge && age < cl.minAge) return false; // too young for this class
    if (cl.maxAge != null && age > cl.maxAge) return false; // capped below the user's age (kids camps etc.)
    if (age < SENIOR_AGE && isSenior(cl)) return false; // senior program, non-senior user
    return true;
  };
  const wantCats = categories.length ? categories : null;
  const classRecs = classes.filter((cl) => cl.unlimited || cl.spots > 0)
    .filter((cl) => !wantCats || wantCats.includes(cl.category))
    .filter(ageFits)
    .map((cl) => ({
      kind: 'class',
      key: `class:${cl.id}`,
      id: cl.id,
      category: cl.category,
      name: cl.name,
      name_zh: cl.name_zh,
      name_es: cl.name_es,
      location: cl.location,
      when: cl.when,
      spots: cl.spots,
      unlimited: cl.unlimited,
      senior: isSenior(cl),
      url: cl.url,
      lat: cl.lat,
      lng: cl.lng,
      distanceMi: dist(cl.lat, cl.lng),
    }))
    .sort((a, b) => {
      // Seniors: surface senior programs first, then nearest.
      if (age != null && age >= SENIOR_AGE && a.senior !== b.senior) return a.senior ? -1 : 1;
      return (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity);
    });

  // Interleave the two sources so the pane alternates sport / class.
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < max && (i < sportRecs.length || j < classRecs.length)) {
    if (i < sportRecs.length) out.push(sportRecs[i++]);
    if (out.length >= max) break;
    if (j < classRecs.length) out.push(classRecs[j++]);
  }
  return out;
}
