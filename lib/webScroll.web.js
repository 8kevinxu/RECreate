// Web-only: make wheel/trackpad scrolling faster. On a react-native-web SPA,
// ScrollViews are plain overflow divs whose wheel scrolling is 100% browser-native,
// so the only lever is to intercept wheel events and drive the scroll ourselves.
//
// The two inputs want opposite treatment:
//   • Mouse wheel — discrete notches. We ease toward an accumulated target each
//     animation frame (a lerp) so a big multiplied jump reads as smooth, not steppy.
//   • Trackpad — already a smooth, continuous stream, so easing only adds lag that
//     makes it feel sluggish. We apply the multiplier DIRECTLY for an immediate 1:1
//     response, just covering more distance.
//
// Scoping that keeps it from ever making things worse:
//   • Vertical-dominant gestures only — horizontal two-finger swipes (back/forward
//     nav, horizontal scroll) pass straight through untouched.
//   • Only acts when there's a real vertically-scrollable ancestor that can move in
//     the gesture's direction — so the Leaflet map (wheel = zoom) and page ends are
//     never hijacked (we don't preventDefault there; native/zoom take over).

const MULT_WHEEL = 1.3; // mouse-wheel distance boost (discrete notches, eased)
const MULT_TRACKPAD = 1.7; // trackpad distance boost (continuous, applied directly)
const LERP = 0.22; // mouse-wheel per-frame approach to target (higher = snappier)
const LINE_PX = 32; // px per line for deltaMode 1 (Firefox mouse wheel ≈ 3 lines/notch)

function nearestScrollable(node) {
  let el = node instanceof Element ? node : null;
  while (el && el !== document.body && el !== document.documentElement) {
    if (el.scrollHeight - el.clientHeight > 1) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return el;
    }
    el = el.parentElement;
  }
  // Fallback: some screens scroll the document itself, not an inner div.
  const de = document.scrollingElement || document.documentElement;
  if (de && de.scrollHeight - de.clientHeight > 1) return de;
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

// --- mouse-wheel easing engine --------------------------------------------
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

// Temporary instrumentation so we can see what's actually firing. Check
// `window.__recFastWheelStats` in the console after scrolling. Remove once tuned.
const stats = { events: 0, wheel: 0, trackpad: 0, noTarget: 0, moved: 0 };

function onWheel(e) {
  stats.events++;
  if (e.ctrlKey) return; // pinch-zoom gesture — leave it
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // horizontal swipe/nav — leave it
  const el = nearestScrollable(e.target);
  if (!el) {
    stats.noTarget++;
    return; // e.g. over the Leaflet map: let it zoom
  }
  if (isMouseWheel(e)) stats.wheel++;
  else stats.trackpad++;

  const max = el.scrollHeight - el.clientHeight;

  if (!isMouseWheel(e)) {
    // Trackpad: direct + immediate. Easing here just feels like drag.
    const cur = el.scrollTop;
    const next = Math.max(0, Math.min(max, cur + pxDelta(e, el) * MULT_TRACKPAD));
    if (next === cur && (cur <= 0 || cur >= max)) return; // pinned at edge → native
    if (active === el) active = null; // cancel any in-flight glide so they don't fight
    e.preventDefault();
    el.scrollTop = next;
    stats.moved++;
    return;
  }

  // Mouse wheel: eased glide. Re-sync to live scrollTop when starting fresh (new
  // element, or the previous glide settled) so a scrollbar drag isn't clobbered;
  // mid-glide, keep stacking so rapid notches accumulate.
  if (el !== active || raf === 0) {
    active = el;
    target = el.scrollTop;
  }
  const next = Math.max(0, Math.min(max, target + pxDelta(e, el) * MULT_WHEEL));
  if (next === target && (target <= 0 || target >= max)) return;
  target = next;
  e.preventDefault();
  stats.moved++;
  if (!raf) raf = requestAnimationFrame(tick);
}

export function installFastWheel() {
  if (typeof window === 'undefined' || window.__recFastWheel) return;
  window.__recFastWheel = true;
  window.__recFastWheelStats = stats; // inspect in console after scrolling
  // eslint-disable-next-line no-console
  console.info('[recFastWheel] installed v3 — scroll, then check window.__recFastWheelStats');
  // Non-passive + capture so we can preventDefault and win before target handlers
  // (e.g. Leaflet) — but we only preventDefault after confirming a scrollable
  // ancestor that can actually move, so the map keeps its wheel-zoom.
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
}
