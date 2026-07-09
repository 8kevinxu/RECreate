// Web-only: make the mouse wheel scroll a bit further per notch. On a
// react-native-web SPA, ScrollViews are plain overflow divs whose wheel scrolling
// is 100% browser-native — there's no RN deceleration to tune — so the only lever
// for "slightly faster" is to intercept genuine mouse-wheel events and add a little
// extra distance.
//
// Deliberately narrow so it never makes things WORSE:
//   • Only classic mouse wheels are touched — pixel-mode (deltaMode 0), large,
//     integer, purely-vertical deltas. Trackpads (small/fractional deltas, some
//     horizontal jitter) and Firefox's line-mode wheels are left fully native, so
//     precision scrolling + momentum are unaffected.
//   • We bail unless there's a real scrollable ancestor that can actually move in
//     the wheel's direction — so the Leaflet map (wheel = zoom) and page ends are
//     never hijacked.

const MULT = 1.3; // extra wheel distance per notch (1.0 = native). Keep it gentle.
const WHEEL_MIN = 50; // px; below this we assume a trackpad and stay out of the way

function nearestScrollable(node) {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.scrollHeight > el.clientHeight) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    el = el.parentElement;
  }
  return null;
}

function onWheel(e) {
  if (e.ctrlKey) return; // pinch-zoom gesture — leave it
  const dy = e.deltaY;
  // Classic mouse wheel heuristic: pixel mode, sizable, integer, no horizontal
  // component. Everything else (trackpads, line-mode wheels) falls through to native.
  const isMouseWheel =
    e.deltaMode === 0 && e.deltaX === 0 && Math.abs(dy) >= WHEEL_MIN && Number.isInteger(dy);
  if (!isMouseWheel || dy === 0) return;

  const el = nearestScrollable(e.target);
  if (!el) return;
  const atTop = dy < 0 && el.scrollTop <= 0;
  const atBottom = dy > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight;
  if (atTop || atBottom) return; // let native handle the boundary (no hijack)

  e.preventDefault();
  el.scrollTop += dy * MULT;
}

export function installFastWheel() {
  if (typeof window === 'undefined' || window.__recFastWheel) return;
  window.__recFastWheel = true;
  // Non-passive + capture so we can preventDefault and win before the target's
  // own wheel handlers (e.g. Leaflet) — but we only ever preventDefault after
  // confirming a scrollable ancestor, so the map keeps its wheel-zoom.
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
}
