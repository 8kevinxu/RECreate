// Native no-op twin of lib/urlState.web.js (same .web.js platform split as
// CourtMap / WebAnalytics / crash). There's no address bar on native — view
// state just lives in memory like always.
export function readUrlState() {
  return null;
}
export function writeUrlState() {}
