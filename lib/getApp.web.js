// The web build's "get the iPhone app" prompt: who is eligible, when to ask,
// and how long a dismissal lasts. UI lives in components/GetAppPrompt.js; this
// file decides whether it renders at all.
//
// Three constraints shape every rule below:
//
//   1. There is no Android build (eas.json is iOS-only), so an Android visitor
//      must never be sent to an App Store link they cannot use.
//   2. scripts/postbuild-web.js already injects <meta name="apple-itunes-app">
//      into index.html and every prerendered page, so iOS Safari ALREADY shows
//      Apple's native smart banner. Asking again there stacks two prompts.
//   3. A desktop visitor cannot install anything, so the honest ask there is a
//      QR code they scan with the phone already in their hand — not a button
//      that asks them to remember a chore.
import { useEffect, useState } from 'react';

// Keep in sync with APP_STORE_ID in scripts/postbuild-web.js.
export const APP_STORE_URL =
  'https://apps.apple.com/us/app/recreate-recreation-made-easy/id6786438986';

const KEY = 'recreate.getapp.v1';

// Escalating snooze, taking lib/rateApp.js's stance: a prompt that returns on
// the same terms after being dismissed is worse than one that never asked.
// 1st dismiss → 7 days, 2nd → 30 days, 3rd → never again.
const SNOOZE_MS = [7 * 864e5, 30 * 864e5];

// Never on first paint — a prompt shown before the visitor knows what the site
// is has nothing to sell. Both surfaces additionally wait for a real
// interaction; the delay is the floor, not the trigger.
const DELAY_MS = { bar: 12000, qr: 45000 };

// One ask per session, app-wide. Exported state rather than a local so a future
// contextual sheet (favoriting a court, hitting the CORS wall on live data)
// can claim the session and silence this bar instead of stacking on it.
let askedThisSession = false;

export function getAppAsked() {
  return askedThisSession;
}

export function markGetAppAsked() {
  askedThisSession = true;
}

function readLedger() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { n: 0, at: 0 };
    const v = JSON.parse(raw);
    return { n: Number(v.n) || 0, at: Number(v.at) || 0 };
  } catch {
    // Private-mode Safari throws on localStorage. Treat it as a clean slate:
    // the session guard still holds, so the worst case is one ask per visit.
    return { n: 0, at: 0 };
  }
}

// Exported for the dismiss handler and for anything that wants to retire the
// prompt outright (arriving from the app, or eventually installing it).
export function dismissGetApp(permanent = false) {
  askedThisSession = true;
  const prev = readLedger();
  const next = { n: permanent ? SNOOZE_MS.length + 1 : prev.n + 1, at: Date.now() };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}

function snoozed() {
  const { n, at } = readLedger();
  if (n > SNOOZE_MS.length) return true; // dismissed past the last step — never again
  if (!n) return false;
  const wait = SNOOZE_MS[Math.min(n, SNOOZE_MS.length) - 1];
  return Date.now() - at < wait;
}

// ?getapp=bar|qr forces a surface, skipping the device check, the delay and the
// snooze — the only way to actually look at the iOS-Chrome bar from a desktop
// browser. Not persisted, and not linked from anywhere.
function forcedSurface() {
  try {
    const v = new URLSearchParams(window.location.search).get('getapp');
    return v === 'bar' || v === 'qr' ? v : null;
  } catch {
    return null;
  }
}

// 'bar' | 'qr' | null. Device class, not viewport width: a narrow desktop
// window is still a machine that cannot install an iPhone app.
function surfaceFor() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent || '';

  let params = null;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {}

  // Already came from the app (deep link, or the smart banner's own hand-off).
  if (params && params.get('from') === 'app') {
    dismissGetApp(true);
    return null;
  }

  // ?getapp=bar|qr forces a surface, skipping the device check, the delay and
  // the snooze — the only way to actually look at the iOS-Chrome bar from a
  // desktop browser. Not persisted and not linked from anywhere.
  const forced = forcedSurface();
  if (forced) return forced;

  // Added to the home screen — as close to installed as the web build gets.
  if (navigator.standalone) return null;
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return null;
  } catch {}

  if (askedThisSession || snoozed()) return null;

  // iPadOS 13+ reports itself as a Mac; the touch count is the usual tell.
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (/Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const handheld = iOS || android || /Mobi/i.test(ua);

  // Desktop, any browser — including desktop Safari, which has no smart banner
  // of its own. It cannot install anything, so the QR is the only useful ask.
  if (!handheld) return 'qr';

  // From here down we are on a phone, and a phone never gets the QR: scanning a
  // code with the device already holding it is nonsense.
  if (android) return null; // no Android build to send them to

  // Safari on iOS already renders Apple's smart banner from the meta tag that
  // scripts/postbuild-web.js injects, so the bar exists purely to cover the iOS
  // browsers that render nothing — Chrome, Firefox, Edge, Opera, the Google app.
  if (iOS) return /CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua) ? 'bar' : null;

  // Some other handheld OS with no app to install.
  return null;
}

// Returns [surface, dismiss]. App.js calls this and threads the result down —
// it also needs to know the bar is up so the floating nav and the recenter
// button can move clear of it.
export function useGetAppPrompt() {
  const [surface, setSurface] = useState(null);

  useEffect(() => {
    const s = surfaceFor();
    if (!s) return undefined;
    if (forcedSurface()) {
      setSurface(s); // previewing — show it now, no engagement gate
      return undefined;
    }

    let interacted = false;
    let elapsed = false;
    let settled = false;
    let timer = null;
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

    function cleanup() {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, onInteract, true));
    }

    function reveal() {
      if (settled || !interacted || !elapsed) return;
      settled = true;
      markGetAppAsked();
      setSurface(s);
      cleanup();
    }

    function onInteract() {
      interacted = true;
      reveal();
    }

    // Capture phase so a scroll inside one of the app's own lists counts —
    // scroll events from a nested scroller do not bubble to window.
    events.forEach((e) => window.addEventListener(e, onInteract, { passive: true, capture: true }));
    timer = setTimeout(() => {
      elapsed = true;
      reveal();
    }, DELAY_MS[s]);

    return cleanup;
  }, []);

  const dismiss = () => {
    dismissGetApp();
    setSurface(null);
  };

  return [surface, dismiss];
}
