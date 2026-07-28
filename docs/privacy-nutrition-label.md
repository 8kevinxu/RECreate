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
  **The assistant transmits coordinates but does not collect them** — it measures
  a distance and drops them, which is inside Apple's real-time-service exemption.
  See "Enabling the assistant" below; that exemption is enforced by tests, not by
  convention.
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

## Enabling the assistant

Turning the assistant on (`EXPO_PUBLIC_ASSISTANT_URL` set in a build profile)
sends two things off the device that otherwise never leave it. They land in
completely different places on this table, and the difference is worth being
precise about, because the intuitive reading — "the app sends location, so
Location is now collected" — is wrong here.

### Coordinates: still Not Collected

`lib/assistant.js` posts the user's coordinates so "what's open near me?" can be
sorted by distance. Apple's definition of *collect* is not "transmits"; it is
transmitting off-device in a way that allows access **"for a period longer than
what is necessary to service the transmitted request in real time."**

The service sits inside that exemption, and specifically:

- `agent.py` turns `lat`/`lng` into an `origin` tuple, hands it to retrieval for
  a haversine, and drops it when the request ends. Nothing is persisted.
- **The model never receives them.** `origin` is keyword-only and absent from the
  tool schemas, so it cannot be model-supplied; results carry
  `miles_from_user: 1.2`, never a latitude. This matters more than the rest —
  the model provider is a genuine third party that retains what it is sent.
- No log line carries the request body or state.

So Location stays **Not Collected** and the entry above stands. What makes that
fragile is that all three properties are conventions, not types: one
`log.info("state=%s", state)` added while chasing a bug would quietly falsify the
App Store label with no visible symptom. They are therefore **enforced by tests**
— `TestCoordinatesStayInsideTheRequest` in `chatbot/tests/test_agent.py` fails if
coordinates reach the model payload, a log record, or the response, and
`TestRequestLogging` in `test_app.py` covers the handler. If you ever need to
break one of those on purpose, that is the moment to revisit this section, add
`NSPrivacyCollectedDataTypePreciseLocation` to `app.json` → `privacyManifests`,
and add *Location → Precise Location* to the ASC answers.

### Questions: disclose them in the policy

The user's typed question does go to the model provider and is retained by them.
That is covered by the existing **User Content** row rather than a new one, but
it is a materially new flow and the policy should say so. `npm run check` fails
if any `eas.json` profile enables the assistant while `public/privacy.html` never
mentions it. Suggested wording:

> **AI assistant** — if you ask the in-app assistant a question, your question is
> sent to our assistant service and to the AI provider that phrases the answer.
> Answers come from the app's own court, pool and class data. If you have granted
> location permission, your coordinates are used to measure distance while
> answering and are not stored, logged, or sent to the AI provider.

Keep that last clause honest — it is a claim about `chatbot/`'s behaviour, and the
tests named above are what keep it true.

### And the service itself

A deployed assistant needs `ASSISTANT_TOKEN`, a narrowed
`ASSISTANT_ALLOWED_ORIGINS`, and a daily budget, because every question costs a
model call — see `chatbot/README.md` → "Before this ever leaves localhost". Not a
privacy matter, but it belongs on the same checklist.

## When to update this

Re-check both the policy and this table whenever you add a feature that sends a
**new kind of user data off the device** (e.g. photo uploads → add User Content ›
Photos; an analytics SDK → add Usage Data). Keep `public/privacy.html`, this
doc, `app.json` `privacyManifests`, and the ASC label in lockstep.
