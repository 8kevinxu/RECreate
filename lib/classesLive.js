// Real-time class availability from SF Rec & Park's ActiveNet, fetched at runtime
// so openings reflect "right now" — the build-time data/classes.js stays as the
// instant-load baseline and the fallback. React Native's native fetch isn't bound
// by browser CORS and persists the session cookie across requests, so we can do
// ActiveNet's CSRF handshake + list fetch straight from the app.
//
// Returns { map: { 'anc-<id>': { spots, unlimited } }, at } overlaid onto the
// static list, or null on failure (callers keep the baseline). Availability
// parsing mirrors scripts/build-classes.js (uses `openings`, not capacity).
//
// Important: ActiveNet paginates against server-side session state, so pages must
// be fetched sequentially (parallel requests return overlapping pages). We also
// query the same category groups as the build — combining all categories into one
// search returns a different, smaller set.

const BASE = 'https://anc.apm.activecommunities.com/sfrecpark';
const GROUPS = [['29'], ['50', '25', '24'], ['26'], ['33'], ['51']]; // mirrors build-classes.js (incl. Aquatics)
const MAX_PAGES = 30; // per-group safety bound
const TTL_MS = 60 * 1000; // serve a cached result for this long (tab switches)

let cache = null; // { at, map }

async function getCsrf() {
  const res = await fetch(`${BASE}/activity/search?locale=en-US`, { headers: { Accept: 'text/html' } });
  const html = await res.text();
  const m = html.match(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/);
  return m ? m[1] : null;
}

async function fetchPage(csrf, cats, page) {
  const res = await fetch(
    `${BASE}/rest/activities/list?locale=en-US&page_number=${page}&total_records_per_page=20`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRF-Token': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE}/activity/search?locale=en-US`,
      },
      body: JSON.stringify({
        activity_search_pattern: {
          activity_select_param: 2,
          activity_keyword: '',
          activity_category_ids: cats,
          for_map: false,
        },
        activity_transfer_pattern: {},
      }),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseOpenings(item) {
  const raw = String(item.openings ?? '');
  const unlimited = /unlimited/i.test(raw);
  const n = parseInt(raw, 10);
  return { spots: unlimited ? null : Number.isFinite(n) ? n : null, unlimited };
}

export async function fetchLiveAvailability(force = false) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  try {
    const csrf = await getCsrf();
    if (!csrf) return null;
    const map = {};
    for (const cats of GROUPS) {
      let page = 1;
      let totalPages = 1;
      do {
        const d = await fetchPage(csrf, cats, page);
        for (const it of d.body?.activity_items || []) map[`anc-${it.id}`] = parseOpenings(it);
        totalPages = d.headers?.page_info?.total_page || 1;
        page++;
      } while (page <= totalPages && page <= MAX_PAGES);
    }
    if (!Object.keys(map).length) return null;
    cache = { at: Date.now(), map };
    return cache;
  } catch (e) {
    return null;
  }
}
