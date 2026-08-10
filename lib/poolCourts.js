// Turns each city's public pools into court-shaped records so they render as
// "swimming" markers on the map like any sport. Open-now comes from the pools'
// PUBLIC-SWIM sessions (lap/family/senior/water-exercise/parent-tot — the "just
// show up and swim" ones), collected into a dropins.swimming week; lessons,
// camps and rentals are excluded from drop-in but still shown in the card's full
// schedule. The full pool detail (weekly sessions, fees, closures, PDF) rides on
// a `pool` block that CourtDetail renders (see components/PoolDetail.js).
//
// Two cities, one shape: SF's 9 pools come from seasonal PDFs parsed into a
// weekly grid, NYC's 92 from a citywide outdoor schedule plus per-rec-center
// indoor grids. Both arrive as the same POOLS record, so everything below —
// and the whole render path — is city-agnostic.

import { POOLS, POOL_FEES } from '../data/pools';
import NYC_POOLS from '../data/cities/nyc/pools';

// Sessions anyone can drop in and swim (vs lessons/camps/rentals).
const PUBLIC_SWIM = new Set(['lap', 'family', 'senior', 'exercise', 'parent_child']);

function toCourt(pool, city) {
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
    id: pool.id, // 'pool-balboa' / 'nyc-pool-…' — stable, prefix-safe for favorites
    name: pool.name,
    address: pool.address,
    lat: pool.lat,
    lng: pool.lng,
    phone: pool.phone,
    city,
    // SF's pools are all indoor; NYC's are mostly outdoor, and the record says
    // which. Defaulting to indoor keeps SF's existing behaviour byte-identical.
    indoor: pool.indoor !== false,
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
      // Fees travel WITH the pool: SF charges per visit on a city fee schedule,
      // NYC's outdoor pools are free and its indoor ones need a rec-center
      // membership. PoolDetail used to import SF's table directly, which quietly
      // priced NYC pools at SF rates.
      fees: pool.fees || POOL_FEES,
      // Why a pool has no schedule, in NYC Parks' own words ("closed for
      // reconstruction"). Far more use than an empty weekly grid.
      notice: pool.notice || null,
    },
  };
}

export const POOL_COURTS = [
  ...POOLS.map((p) => toCourt(p, 'sf')),
  ...NYC_POOLS.map((p) => toCourt(p, 'nyc')),
];
export default POOL_COURTS;
