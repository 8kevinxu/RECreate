// Web twin of lib/urlState.js (same .web.js platform split as CourtMap /
// WebAnalytics / crash). The web build is a static SPA — every path rewrites to
// index.html and a reload boots App.js from scratch — so the current view (tab,
// map sport, Favorites mode, open court) is mirrored into the query string via
// history.replaceState. Reloading (or sharing the URL) then restores that view
// instead of dumping the user back on the default map. replaceState on purpose:
// tab switches shouldn't pile up history entries behind the back button.

// 'add' is the friend-invite param (?add=<friend-code>, see lib/invite.js) —
// read once at boot; App.js never writes it back, so the first writeUrlState
// consumes it off the URL (it persists in AsyncStorage until acted on).
const KEYS = ['tab', 'sport', 'fav', 'court', 'add'];

export function readUrlState() {
  try {
    const params = new URLSearchParams(window.location.search);
    const state = {};
    for (const k of KEYS) {
      const v = params.get(k);
      if (v) state[k] = v;
    }
    return state;
  } catch {
    return null;
  }
}

// Falsy values drop their param so the default view keeps a bare, clean URL.
export function writeUrlState(state) {
  try {
    const params = new URLSearchParams(window.location.search);
    for (const k of KEYS) {
      if (state[k]) params.set(k, String(state[k]));
      else params.delete(k);
    }
    const qs = params.toString();
    const url = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
    window.history.replaceState(null, '', url);
  } catch {}
}
