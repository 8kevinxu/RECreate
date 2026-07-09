// Web-only: make wheel/trackpad scrolling a bit faster while staying smooth. On a
// react-native-web SPA, ScrollViews are plain overflow divs whose wheel scrolling
// is 100% browser-native, so the only lever is to intercept wheel events and drive
// the scroll ourselves.
//
// A raw `scrollTop += delta * k` multiplier works for a mouse wheel but ruins a
// trackpad: multiplying every momentum event makes it feel doubled and jittery.
// Instead we accumulate a *target* offset and glide toward it each animation frame
// (a lerp). That amplifies distance a touch AND smooths the step sequence, so both
// a mouse notch and a trackpad flick end up faster but fluid.
//
// Scoping that keeps it from ever making things worse:
//   • Only acts when there's a real vertically-scrollable ancestor that can move in
//     the wheel's direction — so the Leaflet map (wheel = zoom) and page ends are
//     never hijacked (we don't preventDefault there, native/zoom take over).
//   • Mouse wheels get a slightly larger boost than trackpads (which are already
//     continuous), and line/page-mode deltas are normalized to pixels.

const MULT_WHEEL = 1.3; // mouse-wheel distance boost (discrete notches)
const MULT_TRACKPAD = 1.15; // trackpad boost (already smooth/continuous — gentler)
const LERP = 0.22; // per-frame approach to target (higher = snappier, lower = floatier)
const LINE_PX = 32; // px per line for deltaMode 1 (Firefox mouse wheel ≈ 3 lines/notch)

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

// deltaY in real pixels, whatever the wheel's deltaMode.
function pxDelta(e, el) {
  if (e.deltaMode === 1) return e.deltaY * LINE_PX; // lines → px
  if (e.deltaMode === 2) return e.deltaY * el.clientHeight; // pages → px
  return e.deltaY; // already px
}

// Classic mouse wheel = pixel mode, sizable, integer, purely vertical. Everything
// else (small/fractional/horizontal deltas) is treated as a trackpad.
function isMouseWheel(e) {
  return e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY) && e.deltaX === 0);
}

let active = null; // element currently being eased
let target = 0; // float target scrollTop for `active`
let raf = 0;

function tick() {
  raf = 0;
  if (!active) return;
  const cur = active.scrollTop;
  const diff = target - cur;
  if (Math.abs(diff) < 0.5) {
    active.scrollTop = target; // settle exactly
    return;
  }
  active.scrollTop = cur + diff * LERP;
  raf = requestAnimationFrame(tick);
}

function onWheel(e) {
  if (e.ctrlKey) return; // pinch-zoom gesture — leave it
  const el = nearestScrollable(e.target);
  if (!el) return; // e.g. over the Leaflet map: let it zoom

  // Re-sync the target to the live scrollTop whenever we start fresh on an element
  // (new element, or the previous glide already settled) so a scrollbar drag or a
  // programmatic jump in between doesn't get clobbered. Mid-glide, keep stacking
  // onto the existing target so rapid notches/flicks accumulate.
  if (el !== active || raf === 0) {
    active = el;
    target = el.scrollTop;
  }

  const d = pxDelta(e, el) * (isMouseWheel(e) ? MULT_WHEEL : MULT_TRACKPAD);
  const max = el.scrollHeight - el.clientHeight;
  const next = Math.max(0, Math.min(max, target + d));
  // Already pinned at the edge we're pushing toward → don't hijack; let the event
  // scroll a parent / bounce natively.
  if (next === target && (target <= 0 || target >= max)) return;

  target = next;
  e.preventDefault();
  if (!raf) raf = requestAnimationFrame(tick);
}

export function installFastWheel() {
  if (typeof window === 'undefined' || window.__recFastWheel) return;
  window.__recFastWheel = true;
  // Non-passive + capture so we can preventDefault and win before target handlers
  // (e.g. Leaflet) — but we only preventDefault after confirming a scrollable
  // ancestor that can actually move, so the map keeps its wheel-zoom.
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
}
