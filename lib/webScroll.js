// Native no-op twin of lib/webScroll.web.js (same .web.js platform split as
// CourtMap / WebAnalytics / crash). Wheel speed is a browser concern, so there's
// nothing to do on native — RN handles momentum natively.
export function installFastWheel() {}
