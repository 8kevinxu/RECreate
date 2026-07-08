// Web no-op twin of lib/crash.js — Metro picks this on web, keeping
// @sentry/react-native out of the web bundle (web is covered by Vercel
// Analytics; native crash reporting is Sentry's job).
export const crashReportingEnabled = false;
export const withCrashReporting = (Root) => Root;
export const captureTestError = () => false;
