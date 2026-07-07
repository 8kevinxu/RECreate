# App Store privacy nutrition label ↔ Privacy Policy reconciliation

This maps every data type RECreate actually collects (derived from the code and
from `public/privacy.html`) to the **App Privacy** answers in App Store Connect,
so the nutrition label matches the policy. Reviewers under a Guideline 2.1 hold
compare these two directly.

**Source of truth for the policy:** `public/privacy.html` (hosted at
`https://recreate-sf.vercel.app/privacy.html`).
**On-device manifest:** `app.json` → `ios.privacyManifests` (written into
`PrivacyInfo.xcprivacy` at build/prebuild; the `ios/` dir is CNG-generated and
git-ignored, so `app.json` is the source of truth).

## App Store Connect → App Privacy answers

Set these exactly. Nothing is used for **Tracking**; nothing is used for
third-party advertising or sold. Every item below is **linked to the user's
identity** and used only for **App Functionality** (plus **Notifications** where
noted).

| ASC category → data type | Collected? | Linked | Tracking | Purpose | Why (policy section) |
|---|---|---|---|---|---|
| **Contact Info → Email Address** | Yes | Yes | No | App Functionality | Account creation ("Account information") |
| **Contact Info → Name** | Yes | Yes | No | App Functionality | Display name / profile ("Account information") |
| **User Content → Other User Content** | Yes | Yes | No | App Functionality | Reviews, chats, signals, runs, check-ins ("Content you create") |
| **Identifiers → User ID** | Yes | Yes | No | App Functionality | Supabase account id linking your content |
| **Identifiers → Device ID** | Yes | Yes | No | App Functionality, Notifications | Expo push token ("Push token") |
| **Diagnostics → Crash Data** | Yes | **No** | No | App Functionality | Sentry crash reports ("Crash data") — the one label item **not** linked to identity |

### Explicitly **Not Collected** (must be answered "No" / left off the label)

- **Location (Precise or Coarse).** The policy states location is used
  **on-device only** and never stored on our servers. In Apple's model "collect"
  means transmitted off the device, so Location is **Not Collected**. Do **not**
  add Location to the nutrition label — adding it would *contradict* the policy.
  (The `NSLocationWhenInUseUsageDescription` string is still required and present
  in `app.json`; that governs the runtime permission prompt, not the label.)
- **Usage Data / Analytics.** No usage-analytics SDK is bundled in the native
  app. (`@vercel/analytics` is **web-only** via `WebAnalytics.web.js` and never
  enters the iOS bundle — see CLAUDE.md.) Answer **No**. Diagnostics → **Crash
  Data is the exception** (Sentry, native-only via `lib/crash.js`, active when
  `EXPO_PUBLIC_SENTRY_DSN` is set): answer **Yes**, not linked to identity —
  `Sentry.init` sets `sendDefaultPii: false` and we never call `setUser`.
  Performance Data / Other Diagnostics stay **No** (`tracesSampleRate: 0`).
- **Purchases, Financial Info, Health, Browsing History, Search History,
  Sensitive Info, Contacts.** None collected → **No**.
- **Safety data (blocks/reports)** and **on-device preferences (language,
  favorites, read-state)** are described in the policy but are either server-side
  moderation records tied to your account (covered by User ID / User Content) or
  stored only on-device (not collected). No separate label category is required.

## On-device privacy manifest (`app.json` → `ios.privacyManifests`)

`NSPrivacyCollectedDataTypes` declares the same six types above
(`EmailAddress`, `Name`, `UserID`, `OtherUserContent`, `DeviceID` with
`Linked = true`, plus `CrashData` with `Linked = false`), each
`Tracking = false`, purpose `AppFunctionality`.
`NSPrivacyTracking = false`. Location is intentionally omitted (on-device only).
Required-reason API declarations (`NSPrivacyAccessedAPITypes` for UserDefaults,
file timestamps, system boot time, disk space) are aggregated automatically by
Expo/EAS from the bundled libraries.

## When to update this

Re-check both the policy and this table whenever you add a feature that sends a
**new kind of user data off the device** (e.g. photo uploads → add User Content ›
Photos; an analytics SDK → add Usage Data). Keep `public/privacy.html`, this
doc, `app.json` `privacyManifests`, and the ASC label in lockstep.
