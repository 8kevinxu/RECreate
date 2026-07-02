// Vercel Analytics is web-only. On native this is a no-op; Metro loads the
// .web.js variant on web (same platform-split pattern as CourtMap). Keeping the
// @vercel/analytics import out of the native bundle avoids DOM-only code there.
export default function WebAnalytics() {
  return null;
}
