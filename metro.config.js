// Sentry's Metro wrapper around Expo's default config: annotates bundles so
// stack traces symbolicate against uploaded source maps. Harmless when Sentry
// is unconfigured (no EXPO_PUBLIC_SENTRY_DSN).
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
