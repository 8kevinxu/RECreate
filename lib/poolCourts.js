// Turns the 9 SF public pools (data/pools.js) into court-shaped records so they
// render as "swimming" markers on the map like any sport. Open-now comes from the
// pools' PUBLIC-SWIM sessions (lap/family/senior/water-exercise/parent-tot — the
// "just show up and swim" ones), collected into a dropins.swimming week; lessons,
// camps and rentals are excluded from drop-in but still shown in the card's full
// schedule. The full pool detail (weekly sessions, fees, closures, PDF) rides on a
// `pool` block that CourtDetail renders (see components/PoolDetail.js).

import { POOLS } from '../data/pools';

// Sessions anyone can drop in and swim (vs lessons/camps/rentals).
const PUBLIC_SWIM = new Set(['lap', 'family', 'senior', 'exercise', 'parent_child']);

function toCourt(pool) {
  const schedule = [];
  const swimWeek = [];
  for (let d = 0; d < 7; d++) {
    const sessions = (pool.sessions && pool.sessions[d]) || [];
    // Facility hours = the span of all sessions that day (null when closed).
    schedule[d] = sessions.length
      ? [Math.min(...sessions.map((s) => s.start)), Math.max(...sessions.map((s) => s.end))]
      : null;
    // Drop-in "open swim" blocks for the swimming sport.
    swimWeek[d] = sessions
      .filter((s) => PUBLIC_SWIM.has(s.kind))
      .map((s) => [s.start, s.end])
      .sort((a, b) => a[0] - b[0]);
  }
  return {
    id: pool.id, // 'pool-balboa' — stable, prefix-safe for favorites
    name: pool.name,
    address: pool.address,
    lat: pool.lat,
    lng: pool.lng,
    phone: pool.phone,
    city: 'sf',
    indoor: true,
    schedule,
    dropins: { swimming: swimWeek },
    // Everything the card needs to render the full pool view.
    pool: {
      sessions: pool.sessions,
      scheduleUrls: pool.scheduleUrls,
      desc: pool.desc,
      season: pool.season,
      programs: pool.programs,
      phone: pool.phone,
    },
  };
}

export const POOL_COURTS = POOLS.map(toCourt);
export default POOL_COURTS;
