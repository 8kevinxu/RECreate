// Crash reporting (Sentry), native only — the web build ships the no-op twin
// lib/crash.web.js (same .web.js platform split as WebAnalytics/CourtMap) and
// is covered by Vercel Analytics instead. Follows the app's null-seam pattern:
// without EXPO_PUBLIC_SENTRY_DSN set this module does nothing, so the app runs
// fine with no Sentry account configured.
import * as Sentry from '@sentry/react-native';

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
export const crashReportingEnabled = !!dsn;

if (crashReportingEnabled) {
  Sentry.init({
    dsn,
    // Crash/error reporting only: no performance tracing, no session replay,
    // and no PII (user ids/emails stay out of crash reports — see
    // docs/privacy-nutrition-label.md).
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}

// Wraps the root component with Sentry's error boundary + touch instrumentation.
export const withCrashReporting = (Root) => (crashReportingEnabled ? Sentry.wrap(Root) : Root);
