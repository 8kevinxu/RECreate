// Native no-op twin of lib/getApp.web.js (same platform split as lib/crash.js
// and components/WebAnalytics.js). Prompting someone to install the app while
// they are standing inside it is nonsense, so the native build gets an inert
// hook and none of the web detection code.
//
// The App Store URL still lives here so both platforms import it from one place
// — it is the same id scripts/postbuild-web.js injects as the Safari smart
// banner (APP_STORE_ID there).
export const APP_STORE_URL =
  'https://apps.apple.com/us/app/recreate-recreation-made-easy/id6786438986';

const noop = () => {};

// Returns [surface, dismiss] to match the web hook's shape exactly, so App.js
// has no platform branch of its own.
export function useGetAppPrompt() {
  return [null, noop];
}
