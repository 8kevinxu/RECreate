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
  now = new Date(),
  max = 10,
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

  // --- Classes: a wanted category, with openings ---
  const wantCats = categories.length ? categories : null;
  const classRecs = CLASSES.filter((cl) => cl.unlimited || cl.spots > 0)
    .filter((cl) => !wantCats || wantCats.includes(cl.category))
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
      url: cl.url,
      lat: cl.lat,
      lng: cl.lng,
      distanceMi: dist(cl.lat, cl.lng),
    }))
    .sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));

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
