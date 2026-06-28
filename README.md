# 🏀 HoopMap SF
https://hoopmap.netlify.app/

Find an **indoor basketball court** to play at right now in San Francisco. The
app maps every **SF Recreation & Parks recreation center with an indoor gym** —
tap a pin for the weekly **open-gym basketball schedule**, facility hours, and
address. **"Open now"** filters to centers running drop-in basketball *right now*
(map pins fade when open gym isn't currently happening).

Built with **Expo / React Native**. The map is **Leaflet + OpenStreetMap**
rendered inside a `WebView` (no API key, no billing).

## Run it

```bash
npm install        # if you haven't already
npx expo start     # then press 'i' (iOS sim), 'a' (Android), or scan the QR in Expo Go
```

The first launch asks for location permission. If you decline, the map just
stays centered on San Francisco — everything else still works.

## Project layout

| File | What it does |
| --- | --- |
| `App.js` | Main screen: header, open-now filter, map, court detail card, geolocation |
| `components/CourtMap.js` | Leaflet map in a WebView; renders markers, handles taps |
| `assets/stephCurryIcon.js` | User-location marker image (data URI) |
| `data/courts.js` | **Generated** bundled court list (offline fallback) |
| `data/courts.json` | **Generated** hostable court data the app fetches at launch |
| `data/manual-courts.js` | **Hand-curated** fully-static courts; merged in at runtime, never regenerated |
| `data/sanbruno-court.js` | **Generated** San Bruno RAC court (drop-in hours from a city Google Sheet) |
| `scripts/build-indoor-courts.js` | Builds the SF data files; scrapes live schedules |
| `scripts/build-sanbruno-court.js` | Builds the San Bruno court; parses the city gym Google Sheet |
| `scripts/schedule-cache.json` | Last-good scraped schedule per facility (fallback) |
| `.github/workflows/refresh-schedules.yml` | Weekly cron that re-scrapes + commits |
| `lib/useCourts.js` | Fetches/caches court data at launch (bundled→cached→remote) |
| `lib/hours.js` | Open-now + basketball open-gym logic from per-weekday schedules |
| `lib/crowd.js` | Crowd check-in store (levels, freshness, "voted X ago") |
| `lib/reviews.js` | Per-court reviews store (Supabase + local fallback) |
| `lib/datetime.js` | Shared date helpers (time picker + run form) |
| `lib/auth.js` | Account state (Supabase Auth: session, profile, sign in/out) |
| `lib/runs.js` | "Plan a run" store (create/join/leave/cancel pickup runs) |
| `components/AuthModal.js` | Sign in / create account / account sheet |
| `components/RunModal.js` | Top-level "Plan a run" form — pick a court + day/time in either order |
| `lib/friends.js` | Friends graph (codes, add/accept/remove) |
| `components/FriendsModal.js` | Friends sheet (your code, add by code, requests, friends list) |
| `lib/feed.js` | Activity feed: merges signals + runs into one stream; unread tracking |
| `components/FeedModal.js` | Activity sheet — friends' signals + upcoming runs, with composers |
| `lib/signals.js` | "Down to hoop" signals + joinable sessions (friends-only, realtime) |
| `components/SignalModal.js` | "Down to hoop" composer (now / at a time + note) |
| `components/SessionModal.js` | Session sheet (join, suggest a time, host confirms) |
| `lib/distance.js` | Haversine distance + formatting (miles) |
| `lib/push.js` | Expo push-token registration + notification-tap handling |
| `components/NearbyList.js` | Nearby courts ranked by distance, with a min-open filter |

## Court data (SF Rec & Parks indoor gyms)

`data/courts.js` is **auto-generated** — don't edit it by hand. It combines three
sources:

1. **Which rec centers have an indoor gym + facility hours** — curated in the
   `CENTERS` table in the build script (rarely changes).
2. **Coordinates, addresses, neighborhoods** — DataSF "Recreation and Parks
   Facilities" dataset (`ib5c-xgwu`), fetched by property name.
3. **Open-gym drop-in times (per sport)** — **scraped live each build** from the
   *Gymnasium* row of each center's sfrecpark.org facility page. League/class/camp
   sessions are excluded — only show-up-and-play blocks are kept.

Each court carries:
- `schedule[]` — facility operating hours (one block per day)
- `dropins` — a `{ sportId: week }` map of drop-in open-gym blocks per sport, where
  each `week` is indexed `0=Sun..6=Sat` and each day is an array of `[startMin,
  endMin]` blocks. Tracked sports live in `lib/sports.js` (**basketball**,
  **volleyball**, **ping pong**, **pickleball**, **tennis**); the app shows one at
  a time via the (scrollable) sport toggle. Indoor coverage comes from rec-center
  gyms (basketball broad; volleyball ~6 centers; ping pong ~10, scraped from the
  multipurpose-room / auditorium rows, not just the gym). **Basketball**,
  **pickleball**, and **tennis** also add outdoor public courts from DataSF (see
  below): basketball ~76 parks, tennis ~66, pickleball ~13. So basketball and
  pickleball are **both** indoor and outdoor (the app shows an Indoor/Outdoor
  sub-filter for them); tennis is outdoor-only.
- `indoor` — `true` for gyms, `false` for outdoor courts; surfaced as an
  Indoor/Outdoor badge and in the header count.
- `scheduleSource` — `"live"` (scraped this run) · `"cache"` (last-good) ·
  `"curated"` · `"datasf"` (outdoor courts)

Regenerate anytime:

```bash
npm run build:courts
```

### Courts from other sources

Not every gym is an SF Rec & Parks center. `lib/useCourts.js` merges non-sfrecpark
courts into whatever the SF pipeline produced (bundled, cached, or remote), deduped
by `id`, so `npm run build:courts` never touches them. Two flavors:

- **Fully static** courts (no upstream schedule to refresh) are hand-authored in
  **`data/manual-courts.js`**.
- **Refreshable** courts get their own build script + generated file. The **San
  Bruno Recreation & Aquatic Center** is the first: `scripts/build-sanbruno-court.js`
  pulls the city's public *Gymnasium Schedule* Google Sheet (CSV export), parses the
  two-side gym grid into per-sport drop-in blocks (basketball + volleyball), and
  writes **`data/sanbruno-court.js`**. Run it with `npm run build:sanbruno`, or
  `npm run build:data` to rebuild every source together. It mirrors the SF build's
  resilience — last-good cache (`scripts/sanbruno-cache.json`) plus a validation gate
  that keeps the old data if the sheet won't parse.
- **Outdoor courts** (basketball + tennis + pickleball) come from
  `scripts/build-outdoor-courts.js`, which queries the DataSF facilities dataset
  (`ib5c-xgwu`) for the `Basketball Court`, `Tennis Court`, `Pickleball Courts`, and
  `Tennis/Pickleball Court` types, maps each to its sport(s), and groups records by
  park into one pin each (`data/outdoor-courts.js`, `npm run build:outdoor`). These are first-come
  public courts with no posted schedule, so each is modeled as open a fixed daily
  park-hours window (8 AM–8 PM) with its sport(s) available across all of it. Same
  cache + gate resilience as the others (`scripts/outdoor-courts-cache.json`).
- **Reservation occupancy** ("% booked") for tennis + pickleball comes from
  `scripts/build-reservations.js`, which reads SF Rec & Park's reservation platform
  (rec.us, via its public `api.rec.us` per-location endpoint). For each reservable
  court it compares the open-hours schedule against the still-free slots over the
  next 7 days (rec.us only lists future-free times, so this captures who's reserved
  when), geo-matches each rec.us location to one of our courts by proximity + sport
  (closest wins), and writes a court id → `{ sport: { pct, courts, slots, url } }` map
  (`data/reservations.js`, `npm run build:reservations`). `slots` is **point-in-time**
  booked% keyed by actual SF-local datetime (`"YYYY-MM-DD HH:MM"`) — the fraction of the
  location's courts reserved at that 30-min slot — `pct` is the window average, and `url`
  is the court's rec.us page. `lib/useCourts.js` merges it onto courts as `reserved`: the
  court detail card shows a live **"% booked right now"** badge — a red **"Fully booked
  now"** when every court is reserved (also tagged in the Nearby list) — plus a **Reserve
  this court** button (deep-links to that court's rec.us page) and a how-to-book link, and
  the "Plan a game" sheet shows each court's booked% for the picked day+time. The main
  screen also offers multi-select **amenity filters** (Bookable / Lights / Restrooms /
  Nets provided) for tennis + pickleball, each shown only when some court qualifies
  (see `AMENITIES` in `App.js`, fed by the directory + reservation data). Because the slots are
  date-keyed they cover today through the window end, then go stale — so the **weekly cron
  refresh matters** to keep "right now" accurate. Same last-good cache + gate resilience
  (`scripts/reservations-cache.json`).
- **Court directory facts** (court counts, lights, restrooms, nets) for tennis + pickleball
  come from `scripts/build-court-directory.js`, which scrapes SF Rec & Park's public
  [tennis](https://sfrecpark.org/1446/Tennis-Court-Directory) and
  [pickleball](https://sfrecpark.org/1772/Pickleball-Court-Directory) directories (single
  HTML tables, parsed with cheerio), matches each facility to one of our courts by name
  (sport-gated, with a few manual aliases), and writes a court id →
  `{ sport: { total, reservable, walkup, lights, restrooms, nets } }` map
  (`data/court-directory.js`, `npm run build:directory`). `lib/useCourts.js` merges it onto
  courts as `directory`, shown as facility chips on the detail card. Same last-good cache +
  gate resilience (`scripts/directory-cache.json`).

An optional `disclaimer` field on a court overrides the default "verify on
sfrecpark.org" footnote on the court detail screen.

### Auto-refresh (keeping schedules current)

The schedules are **seasonal**, so they're refreshed automatically:

- **Live scrape on every build** via a small cheerio parser. The facility-page
  season label (e.g. "Summer Schedule") is captured and stamped into the file.
- **Weekly GitHub Actions cron** (`.github/workflows/refresh-schedules.yml`)
  re-runs the build and commits `data/courts.js` only if it changed.
- **Resilience:** each center falls back `live → cache → curated`. A
  **validation gate** aborts the run (leaving the old data in place) if fewer
  than `MIN_LIVE_OK` centers scrape — so a site redesign **fails the Action and
  notifies you** instead of silently publishing empty schedules.

### Reviews

Each court's card has a **Reviews** section — a list of comments plus a box to
add one (optional name + text). Stored in `lib/reviews.js` with the same
Supabase-or-local pattern as check-ins; loaded lazily per court.

Guards for free-text content: body capped at 1000 chars, optional name at 50,
and a per-IP rate limit (10 reviews / 10 min) via a Supabase trigger. There's no
in-app delete — **moderate via the Supabase dashboard** (Table Editor → `reviews`)
if needed. A `rating` column exists (unused) so star ratings are an easy add.

**Seed your own initial data** in the Supabase SQL editor:

```sql
insert into public.reviews (court_id, author, body) values
  ('hamilton-recreation-center', 'Kevin', 'Great runs on weekday evenings, competitive.'),
  ('mission-recreation-center',  null,    'Gym can get packed after 6pm.');
```

(`court_id` matches the `id` in `data/courts.js` — e.g. `palega-recreation-center`.)

## Live updates for users (no app release needed)

The app fetches fresh data **on launch** instead of relying only on the bundled
file (`lib/useCourts.js`):

```
bundled data (instant, offline)  →  cached copy (last good)  →  remote fetch (revalidate)
```

1. The weekly cron commits `data/courts.json`.
2. Point the app at that file's hosted URL via an env var (no code change):
   ```
   EXPO_PUBLIC_COURTS_URL=https://raw.githubusercontent.com/<user>/hoopmap/main/data/courts.json
   ```
   (Put it in a `.env` file or your EAS build env. Needs a **public** repo for the
   raw URL; or host `courts.json` on GitHub Pages / any CDN.)
3. On launch the app renders bundled data instantly, then swaps in the cached
   copy, then revalidates from the URL and caches the result. Offline or a failed
   fetch just keeps the last good data — it never blocks or crashes.

Until `EXPO_PUBLIC_COURTS_URL` is set, the app simply uses the bundled data.

### Data caveat

Open-gym times reflect the current season scraped from sfrecpark.org and vary by
program — verify on [sfrecpark.org](https://sfrecpark.org). **Gene Friend** has
no open-gym blocks (facility page offline, likely renovation) and falls back to
curated data.

## Live crowd check-ins

Tap a court → **"How crowded right now?"** → vote **Empty / Moderate / Packed**.
Your pick is highlighted; **tap it again to remove your check-in**, or tap a
different level to switch. The latest check-in shows as e.g. "🔴 Packed · voted
12 min ago", plus a short **history** ("👥 4 check-ins in the last hour" and the
recent votes), and animates the map marker:

- **Empty** → sleepy `z z z` drifting off the basketball
- **Moderate** → no animation
- **Packed** → pulsing glow + a flickering 🔥

Check-ins expire after `FRESH_WINDOW_MS` (2h) — after that the gym's current
state is "unknown" again (no animation), though the last report time still shows.

**Storage is pluggable** (`lib/crowd.js`): it uses **Supabase** (shared across
all users + real-time) when configured, and falls back to **on-device storage**
otherwise. No UI changes between the two.

### Enable shared / real-time check-ins (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor → New query →** paste [`supabase/schema/01_crowd_check_ins.sql`](supabase/schema/01_crowd_check_ins.sql)
   → **Run** (creates the `check_ins` table, public read/insert/delete policies,
   and turns on real-time). The other features each have their own numbered
   `schema/` file — run them in order as you enable each; see
   [`supabase/README.md`](supabase/README.md) for the full layout.
3. **Project Settings → API →** copy the **Project URL** and **anon public key**.
4. Add them to `.env`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
   ```
5. Restart with a cache clear: `npx expo start -c`.

Now check-ins write to Supabase, everyone sees the same counts, and a real-time
subscription pushes other users' check-ins to the map live. Until the env vars
are set, the app uses local on-device check-ins (you see only your own).

**Real-time is incremental:** each new check-in is merged into state by `id`
(`mergeCheckIn`) rather than refetching the whole table — so cost scales with
*check-ins*, not *users × check-ins*.

**Anti-spam (two layers, no cooldown):**
1. *Client* — each device holds a **single vote per court** (switching replaces
   it, tapping your pick again removes it), so taps can't inflate the count and
   misclicks are instantly fixable.
2. *Server* — a Supabase `BEFORE INSERT` trigger caps check-ins per client IP
   (default 30 / 60s; tune in `supabase/schema/01_crowd_check_ins.sql`). Unlike the client guard,
   it can't be bypassed by clearing app storage.

Both are pragmatic backstops, not airtight: the anonymous model means shared
Wi-Fi / mobile CGNAT users share an IP. True per-user protection would need
auth or device attestation.

## Nearby courts

The map's **📍 Nearby** button opens a list of courts **ranked by distance** from
you (straight-line miles via `lib/distance.js` — no routing API). Each row shows
distance and, for open courts, **how much open-gym time is left** ("open · 1h 20m
left", or a red "closing · 15m left" under 30 min) so you don't trek to a gym
that's about to close. An **Open for** filter (**Any / 30m+ / 1h+**) drops courts
with too little time left.

The list reuses the app's current **Open now/then** filter and time picker, so it
respects the selected view time — e.g. nearest court open for 1h+ at Tue 3 PM.
Distance + time-left also show on each court's detail card. Without location
permission the list stays in default order with an "Enable location" prompt. Code:
`components/NearbyList.js` (+ `getBasketballRemaining` in `lib/hours.js`).

## Accounts (optional)

Accounts are the foundation for social features. They're **optional** — the map,
check-ins, and reviews all work signed-out; you only need an account for social.

Sign-in is **email + password** via Supabase Auth (`lib/auth.js`). Tap **Sign in**
in the header to create an account (with a display name) or log in; the session
persists across launches. Profiles live in a `profiles` table (`id → auth.users`,
`display_name`), auto-created on signup by a DB trigger and **public-readable** so
names can show in social features.

The **Account** sheet doubles as the player's **profile**: editable display name,
**age**, **bio**, and **favorite sports** (multi-select of the tracked sports), plus
a **check-ins** summary — a per-sport visit counter and your **favorite (most-
visited) park**. Visits are logged to a `player_check_ins` table (`user_id, court_id,
sport`) whenever a signed-in user reports a court's crowd level *or* taps the
court's **"I played here"** button; a 3-hour per-court/sport window dedupes the two
paths so one session counts once. Stats are aggregated client-side (`lib/playerCheckins.js`).

Setup (on top of the Supabase steps under *Live crowd check-ins*):

1. Run [`supabase/schema/03_profiles.sql`](supabase/schema/03_profiles.sql) (the
   `profiles` table, its policies, the signup trigger, friend codes, and
   `player_check_ins`). On an **existing** DB that predates these profile fields,
   apply [`supabase/migrations/002_add_player_profiles.sql`](supabase/migrations/002_add_player_profiles.sql)
   instead (idempotent — adds the new columns + table only).
2. **Authentication → Providers → Email** is enabled by default. For frictionless
   testing, turn **off "Confirm email"** there; keep it **on** for production
   (sign-up then asks the user to confirm via email before first login).

When Supabase isn't configured, the account button is simply hidden.

## Activity feed

The social front door. The header **📣 Activity** button opens one stream that
merges everything happening with your friends — their **"down to hoop"** signals
(tap to open the session), **confirmed sessions** (court + time locked in, marked
✅), and **upcoming runs** (with **I'm in** / **Leave** / **Cancel**) — sorted
soonest-first. Up top are quick **🏀 I'm down** and **＋ Plan a run** composers, so
the feed is both where you see activity and where you start it.

The Activity button carries an **unread badge**: a count of feed items posted
since you last opened the sheet. "Last seen" is a single timestamp kept on the
device (`AsyncStorage`), so the badge survives restarts and clears when you open
(or close) the feed; your own posts never count. The feed live-updates while open
via Supabase realtime on both the signal and run tables. Code lives in
`lib/feed.js` (merge + unread) and `components/FeedModal.js`.

The **👥 Friends** sheet is now just friend management (code, add, requests,
list), and its badge counts pending **friend requests**.

## Plan a game (pickup games)

Signed-in users **plan a game** from the **＋ Plan** button next to the map's time
picker (no longer buried in each court's card). The form lets you start from
**either end**: pick a **court** and its open-gym days/times light up, or pick a
**day/time** and the court list flags which gyms run open gym then (others are
disabled). Pick the **sport** (any tracked sport), **who can see it** (**Friends**,
the default, or **Anyone**), and an optional note. If the map's time picker is set,
the form opens seeded to that time. Others who can see it tap **I'm in** to join
(from the **Activity** feed); the host sees a roster count and can **Cancel**.
Code lives in `lib/runs.js` + `components/RunModal.js` (internally still the
`hoop_runs` table — only the user-facing wording is "plan / game").

Visibility is enforced by RLS via the `visibility` column (`public` | `friends`):
public games are readable by all, friends-only ones only by the host and accepted
friends (`loadUpcomingRuns` powers the Activity feed across all courts).
Setup: run [`supabase/schema/04_runs.sql`](supabase/schema/04_runs.sql) — it adds
`hoop_runs` / `hoop_run_participants`, policies, real-time, and the host auto-join
trigger. The friends-only visibility policy lives in
[`05_friends.sql`](supabase/schema/05_friends.sql) (it needs the friendships table).
On an **existing** DB, apply [`supabase/migrations/003_generalize_run_sports.sql`](supabase/migrations/003_generalize_run_sports.sql)
to allow all sports (the original constraint only permitted basketball/volleyball).

## Friends

Signed-in users can connect via **friend codes**. The header **👥 Friends** sheet
shows your code (with **Share**), an **add by code** box, incoming **requests**
(accept/decline), and your **friends list**. Adding by code sends a request the
other person accepts; if they'd already requested you, adding them completes it.
Each profile gets a unique 6-char code (no ambiguous characters) via a DB trigger.
(Friends' runs and signals show in the **📣 Activity** feed, not here.) Code lives
in `lib/friends.js` + `components/FriendsModal.js`.

Setup: run [`supabase/schema/05_friends.sql`](supabase/schema/05_friends.sql) — the
`friendships` table, policies, and real-time. (The `friend_code` column + generator
live in [`03_profiles.sql`](supabase/schema/03_profiles.sql).)

## Down to hoop

A location-less availability ping to friends: in the **📣 Activity** sheet tap
**🏀 I'm down** → **Right now** or **At a time** (+ optional note). Friends see it
live in their Activity feed, and the Activity button shows an **unread badge** —
the in-app "notification". Signals are **friends-only** (RLS) and **auto-expire**
2h after they start.

Each signal is a **joinable session**: tap it to open the session sheet, **join**
(**I'm in**), **suggest a court + time**, and — as the host — **confirm** one
(either a participant's suggestion or your own). Suggestions pick a **rec center**
and a time **limited to that court's open-gym blocks** (shared with the run form
via `basketballWeekdays` / `openGymSlots` in `lib/hours.js`). The confirmed
court + time show to everyone and extend the session's expiry. Code lives in
`lib/signals.js`, `components/SignalModal.js` (composer), and
`components/SessionModal.js` (session).

Setup: run [`supabase/schema/06_signals.sql`](supabase/schema/06_signals.sql) — it
adds `hoop_signals` + `hoop_signal_participants` (with the suggested/confirmed court
+ time columns), policies, the auto-join trigger, and real-time.

> **Note:** the in-app feed is real-time. To also **buzz the phone when the app
> is closed**, see *Push notifications* below.

## Push notifications

Real pushes (`expo-notifications`) for the social moments that matter, so they
land even when the app is closed:

| Event | Who gets it |
| --- | --- |
| A friend posts **"down to hoop"** | their friends |
| A friend **plans a run** | their friends |
| Someone **joins** your run / session | the host |
| A session's **court + time is confirmed** | the other participants |
| Your **friend request is accepted** | the requester |

**How it works.** On sign-in the app registers the device's **Expo push token**
in a `device_tokens` table (`lib/push.js`). Postgres triggers on `hoop_signals`,
`hoop_runs`, the participant tables, and `friendships` call a `send_push()`
helper that POSTs to **Expo's push API straight from the database via `pg_net`**
— no Edge Function or server to run. Tapping a push deep-links into the app (the
court for a run, the Activity feed for signals/sessions, the Friends sheet for a
friend accept).

**Setup (one-time):**

1. **EAS project** — `getExpoPushTokenAsync` needs a project id. Run `eas init`
   (it writes `extra.eas.projectId` into `app.json`). Without it, registration
   no-ops and nothing else breaks.
2. **Dev build** — remote push doesn't work in Expo Go (SDK 53+) or on web/
   simulators. Make a development build: `npx expo run:ios` / `npx expo run:android`
   (or an EAS build) and run it on a **physical device**.
3. **Database** — run [`supabase/schema/07_push.sql`](supabase/schema/07_push.sql)
   once. It enables `pg_net`, adds `device_tokens` (+ RLS) and the trigger
   functions. (`pg_net` may need enabling under **Database → Extensions** in the
   Supabase dashboard first.)

**Testing status.** The **backend is verified end to end**: with `pg_net`,
`device_tokens`, and the trigger functions applied, `send_push()` POSTs a
well-formed request to Expo's push API and gets back a `200` (confirmed by
seeding a token and inspecting `net._http_response`). **On-device delivery is
not yet verified** — the iOS Simulator has no APNs and can't receive remote
push, a free Apple developer account can't sign the Push Notifications
capability (it needs the paid `$99/yr` Apple Developer Program), and no Android
device was on hand. Verifying delivery to a screen just needs a physical Android
device/emulator (free) or a paid Apple account.

**Limitations (v1):** pushes are fire-and-forget — Expo delivery receipts aren't
checked, and tokens aren't pruned when a device unregisters at the OS level
(`DeviceNotRegistered`). Both are easy follow-ups (a receipts poller / cleanup).

## Ideas for next

- **Invite links:** wrap a friend code in a deep link to add with one tap.
- **More outdoor sports:** the DataSF facilities dataset also has volleyball,
  skatepark, and other court types — the outdoor pipeline can fold them in next.
- **Per-court hours for outdoor courts:** today they use a fixed park-hours window;
  some SF courts publish real hours / reservation windows worth scraping.
