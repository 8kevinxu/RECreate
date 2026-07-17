# 🏀 RECreate SF
https://recreate-sf.vercel.app/

Find somewhere to play **right now** in San Francisco. RECreate started as an
indoor-basketball finder and has grown into a map of SF Rec & Parks **drop-in
recreation** across five tabs:

- **🏀 Map** — every rec-center gym, outdoor court, and field, across **8 sports**
  (basketball, volleyball, ping pong, badminton, pickleball, tennis, soccer,
  baseball) plus a **weight room** view (rec-center weight rooms + outdoor fitness
  courts) and a **⛳ golf** view (all 6 SFRPD courses with holes/par/yardage, green
  fees, 9/18-hole & beginner filters, and tee-time booking links), with weekly
  **open-gym schedules**, **"open now"** filtering, live
  **crowd check-ins**, and tennis/
  pickleball **reservation occupancy** ("% booked right now"). Pickleball courts show
  **posted open-play schedules** (parsed from SFRP's schedule posters, honest gaps and
  all), and cards carry community color — venue descriptions from pickleballsf.com,
  hitting-wall flags and player ratings from tennissf.com. Each sport has its own
  glyph (down to a drawn perforated pickleball). To keep dense areas legible, nearby
  courts **cluster into count bubbles** when zoomed out (orange = something open now)
  that split as you zoom in, and courts **open now show as full glyphs while closed
  ones recede to faded dots**. Star a court for the sport you're viewing (Parkside for
  pickleball, Palega for basketball) and the sport dial's **⭐ Favorites** view becomes
  a personal map of just your spots, each shown open or closed for the sport you
  favorited it for.
- **📅 Classes** — SF Rec & Park's full ActiveNet program catalog (fitness, dance,
  music, arts, photography, social games, aquatics & swim lessons, sports & rec,
  camps, youth & after-school) with real prices and live openings.
- **🏊 Pools** — the 9 public swimming pools with parsed weekly swim schedules
  (lap / family / senior / lessons …), fees, per-pool descriptions, and "open now".
- **👥 Social** — accounts, friends, "down to play" signals, planned games, an
  activity feed, and chat.
- **👤 Profile** — your profile/stats, plus **Settings** (language, legal &
  support links, activity-sharing, "Report a problem", account). Every schedule
  also carries a one-tap **"looks wrong? report it"** flag so stale data gets
  caught by the people standing at the court.

The whole UI is **localized in English / 中文 / Español**. Built with **Expo /
React Native** (also shipped to the **web** as a static export). The map is
**Leaflet + OpenStreetMap** rendered inside a `WebView` (no API key, no billing).

**Coverage: San Francisco only for now.** The data pipeline (courts, classes,
pools) is SF-specific — more cities are on the way.

## Run it

```bash
npm install        # if you haven't already
npx expo start     # then press 'i' (iOS sim), 'a' (Android), or scan the QR in Expo Go
```

## First-launch onboarding

On first launch the app shows a short, skippable onboarding flow
(`components/Onboarding.js`, a full-screen overlay): value-prop slides → **pick
interests** (favorite sports + class activities) → a **location primer** → an
optional **Create account** step. It's shown once, gated on the
`recreate.onboarded.v1` AsyncStorage flag; returning users skip straight to the
map. Navigation is a top-left back button (no swipe).

Two things make it more than a splash:
- The **location prompt fires in context** — declining a slide never triggers the
  OS dialog, so tapping "Enable location" later still shows the real prompt. If you
  skip it, the map just stays centered on San Francisco and everything else works.
- **Interests picked here work signed-out** — they're stored on-device
  (`lib/interests.js`) and drive "Recommended for you" immediately; the signed-in
  profile's favorites take over once you have an account. **Create account** opens
  the sign-up sheet inline and, on success, drops you on the map.

If location is off, a dismiss-once map banner offers to enable it, and the
"enable location" action is Settings-aware (routes to iOS Settings once the
permission has been hard-denied).

Once on the map, a **one-time coach mark** points at the sport FAB (the map's
least-obvious control — an emoji glyph with no label), explaining that it switches
sport / opens ⭐ Favorites. It's shown once and then never again (persisted under
`recreate.coach.sportfab.v1`), dismissed by tapping it or opening the sport dial.

## Project layout

| File | What it does |
| --- | --- |
| `App.js` | Main screen: header, open-now filter, map, court detail card, geolocation |
| `components/CourtMap.js` · `.web.js` | Leaflet map (native = WebView, web = DOM); markers, **zoom clustering + open/closed hierarchy**, taps — keep the two in sync |
| `components/SportGlyph.js` | Per-sport glyph: emoji for most, a drawn/rasterized ball for **pickleball** (which has no emoji) |
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
| `components/RunModal.js` | Top-level "Plan a game" form — sport, Indoor/Outdoor filter, court + day/time in either order |
| `lib/friends.js` | Friends graph (codes, add/accept/remove) |
| `components/FriendsModal.js` | Friends sheet (your code, add by code, requests, friends list) |
| `lib/feed.js` | Activity feed: merges signals + runs into one stream; unread tracking |
| `components/FeedModal.js` | Activity sheet — friends' signals + upcoming runs, with composers |
| `lib/signals.js` | "Down to play" signals + joinable sessions (friends-only, realtime) |
| `components/SignalModal.js` | "Down to play" composer (now / at a time, optional sport · place · court + note) |
| `components/SessionModal.js` | Session sheet (join, suggest a time, host confirms) |
| `lib/distance.js` | Haversine distance + formatting (miles) |
| `lib/push.js` | Expo push-token registration + notification-tap handling |
| `components/NearbyList.js` | Nearby courts ranked by distance, with a min-open filter |
| `components/BottomNav.js` | Five-tab bottom bar (Home / Classes / Pools / Social / Profile) |
| `components/ClassesScreen.js` | **Classes tab** — browse drop-in programs by category, with filters + live openings |
| `components/ClassDetail.js` | Class/activity detail sheet (schedule, location, cost, ages, availability + Register on ActiveNet) |
| `data/classes.js` · `scripts/build-classes.js` | **Generated** classes catalog + its ActiveNet scraper (with build-time title translation) |
| `lib/classesLive.js` | Runtime ActiveNet fetch for "right now" class openings (native only; CORS-blocked on web) |
| `components/PoolsScreen.js` | **Pools tab** — swimming pools, today's sessions, open-now, fees, schedule PDFs |
| `data/pools.js` · `scripts/build-pools.js` | **Generated** pools + schedules parsed from seasonal PDFs (`pdfjs-dist`) |
| `components/SettingsScreen.js` | Settings sheet — language switch (en/zh/es), Legal & Support links, activity-sharing toggle, delete account |
| `docs/privacy-nutrition-label.md` | Reconciles the Privacy Policy with the App Store Connect privacy label (2.1 reference) |
| `components/SocialScreen.js` · `ChatsScreen.js` · `ChatThread.js` | Social tab shell + 1:1 / group chat |
| `lib/chat.js` | Chat data layer (run / signal / direct threads) |
| `lib/blocks.js` · `lib/reports.js` | Trust & safety: block users (filtered into every social loader) + content reports, incl. one-tap "data looks wrong" flags (court/class/pool) and Settings' free-text "Report a problem" |
| `lib/sports.js` | The tracked sports table (id, label, emoji) |
| `lib/favorites.js` | On-device court→sport favorites (`useFavorites`) behind the ⭐ Favorites map view |
| `lib/recommend.js` · `components/RecommendPane.js` | "Recommended for you" — interest-based games + classes in the Social tab |
| `lib/playerCheckins.js` | Per-user visit stats (per-sport counts, favorite park) |
| `lib/i18n.js` | i18n: `STRINGS` dict (en/zh/es), `I18nProvider`, `useI18n()`, and `tg()` for non-React modules |
| `components/Onboarding.js` · `lib/interests.js` | First-launch onboarding overlay (slides → interests → location → account) + on-device interest store |
| `components/WebAnalytics.js` · `.web.js` | Vercel Analytics, mounted web-only via the `.web.js` platform split |
| `components/ScrollTopFab.js` | Shared back-to-top arrow (`useScrollTop` hook + FAB) used by Classes / Pools / feed |
| `vercel.json` · `scripts/postbuild-web.js` | Web static-export deploy config (build → SEO postbuild → `dist` → SPA rewrite) |

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
  **volleyball**, **ping pong**, **badminton**, **pickleball**, **tennis**,
  **soccer**, **baseball**); the app shows one at a time via the (scrollable)
  sport toggle. Indoor coverage comes from rec-center gyms (basketball broad;
  volleyball/pickleball a handful of centers; ping pong ~10 and badminton at
  Betty Ann Ong, scraped from the multipurpose-room / auditorium rows, not just
  the gym). DataSF adds outdoor public courts & fields (see below): basketball
  ~75 parks, tennis ~65, pickleball ~13, volleyball 4, soccer ~23 (incl.
  multi-use turf), baseball ~39 diamonds, plus 12 outdoor **fitness courts**
  that join the weight-room view. Sports with both settings get an
  Indoor/Outdoor sub-filter; tennis, soccer, and baseball are outdoor-only.
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
  **`data/manual-courts.js`** — today that's the **6 SFRPD golf courses** (⛳ map
  view), each with a curated `golf` block: holes/par/yardage, green fees (as of
  July 2026 — bump ~annually like the pool fee tables), and tee-time booking link.
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
  the "Plan a game" sheet shows each court's booked% for the picked day+time. When you pick
  a time on the main screen, the card, the Nearby tag, and the map all switch from "right
  now" to that exact date+time (e.g. "0% booked at 6 PM"), each court recomputed for the
  picked slot via `bookedAt`. On the map, each reservable court's glyph gets an **occupancy
  halo** keyed to how booked it is at the viewed time — green (free) → light green → yellow
  → orange → red, and a fully-booked court flashes red and hops (see `bookLevel` in
  `components/CourtMap*.js`). The main screen also
  offers multi-select **amenity filters** (Bookable / Lights / Restrooms / Nets provided)
  for tennis + pickleball, each shown only when some court qualifies (see `AMENITIES` in
  `App.js`, fed by the directory + reservation data). Because the slots are
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
- **Classes & activities** (non-court programs) for the **Classes tab** come from
  `scripts/build-classes.js`, which scrapes SF Rec & Park's **ActiveNet** catalog
  (`anc.apm.activecommunities.com/sfrecpark`). It does the ActiveNet CSRF + session
  handshake, pages the activity-search API **one category id at a time** (ActiveNet's
  multi-id search silently drops categories) across the full catalog (33 source
  categories), and re-buckets every item by keyword into **ten** app categories
  (fitness, dance, music, arts & crafts, photography, social & games, aquatics,
  sports & rec, camps, youth & after school), writing `data/classes.js` — each class
  `{ name, category, location, when, dropIn, cost, ages, url, name_zh?, name_es? }`.
  Drop-in series published as one row per date are collapsed into a single card
  spanning the term (keyed by the latest instance id, so delist-hiding doesn't eat
  live series); drop-ins for sports the map already tracks are skipped as
  duplicates; and classes whose list fee is the "View Fee Details" placeholder get
  real prices (or "$lo–$hi" ranges) from the detail-page price-estimate endpoint.
  `npm run build:classes`, same last-good cache + gate resilience (`scripts/classes-cache.json`).
  Class **titles are scraped English**, so the build optionally pre-translates each
  distinct title to zh/es via the Anthropic API (Claude Haiku) when `ANTHROPIC_API_KEY`
  is set — cached by title in `scripts/classes-i18n-cache.json` so each run only spends
  tokens on new titles, and degrading gracefully to English without a key. Live "right
  now" openings are refreshed in-app by `lib/classesLive.js` (a second, more frequent
  ActiveNet fetch; native only — browsers block it via CORS, so web shows the bundled
  baseline).

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

Guards for free-text content (spam + UGC accountability):
- **Sign-in required to post** when reviews are shared (Supabase configured) — the
  card shows a "Sign in to write a review" prompt that routes to the Profile tab,
  and **RLS enforces it server-side** (insert policy is `to authenticated` with
  `auth.uid()` — migration [`016_reviews_require_auth.sql`](supabase/migrations/016_reviews_require_auth.sql),
  also folded into `schema/02_reviews.sql`). Local-only reviews (no backend) stay
  open, since they never leave the device. The **Report** flow is unchanged.
- Body capped at 1000 chars, optional name at 50, and a per-IP rate limit
  (10 reviews / 10 min) via a Supabase trigger, kept as defense-in-depth.

There's no in-app delete — **moderate via the Supabase dashboard** (Table Editor →
`reviews`) if needed. A `rating` column exists (unused) so star ratings are an easy add.

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
   EXPO_PUBLIC_COURTS_URL=https://raw.githubusercontent.com/<user>/RECreate/main/data/courts.json
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
Distance + time-left also show on each court's detail card, alongside **rough
travel times** (drive / bus / walk) derived from straight-line distance — shown
with a leading `~` (e.g. "~12 min") to read as estimates, since the real ETA comes
from tapping **Directions**. Without location
permission the list stays in default order with an "Enable location" prompt. Code:
`components/NearbyList.js` (+ `getBasketballRemaining` in `lib/hours.js`).

## Accounts (optional)

Accounts are the foundation for social features. They're **optional** — the map
and check-ins work signed-out; you need an account for social features and (when a
Supabase backend is configured) to **post a review**. Reading reviews needs no account.

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
merges everything happening with your friends — their **"down to play"** signals
(tap to open the session), **confirmed sessions** (court + time locked in, marked
✅), and **upcoming runs** (with **I'm in** / **Leave** / **Cancel**) — sorted
soonest-first. Up top are quick **🤙 I’m down** and **＋ Plan a run** composers, so
the feed is both where you see activity and where you start it.

The Activity button carries an **unread badge**: a count of feed items posted
since you last opened the sheet. "Last seen" is a single timestamp kept on the
device (`AsyncStorage`), so the badge survives restarts and clears when you open
(or close) the feed; your own posts never count. The feed live-updates while open
via Supabase realtime on both the signal and run tables. Code lives in
`lib/feed.js` (merge + unread) and `components/FeedModal.js`.

The **👥 Friends** sheet is now just friend management (code, add, requests,
list), and its badge counts pending **friend requests**.

## Plan a game

Plan an actual session — a court, a sport, and a time — for whatever you're
organizing (not only casual pickup; any tracked sport at any tracked court).
Signed-in users start from the **＋ Plan** button next to the map's time picker (no
longer buried in each court's card). The form lets you start from **either end**:
pick a **court** and its open-gym days/times light up, or pick a **day/time** and the
court list flags which gyms run open gym then (others are disabled). For sports that
have both, an **Indoor / Outdoor / Either** filter narrows the court list (the same
control the map uses). Pick the **sport** (any tracked sport), **who can see it**
(**Friends**, the default, or **Anyone**), and an optional note. If the map's time
picker is set, the form opens seeded to that time. Others who can see it tap **I'm
in** to join (from the **Activity** feed); the host sees a roster count and can
**Cancel**. Code lives in `lib/runs.js` + `components/RunModal.js` (internally still
the `rec_runs` table — only the user-facing wording is "plan / game").

Visibility is enforced by RLS via the `visibility` column (`public` | `friends`):
public games are readable by all, friends-only ones only by the host and accepted
friends (`loadUpcomingRuns` powers the Activity feed across all courts).
Setup: run [`supabase/schema/04_runs.sql`](supabase/schema/04_runs.sql) — it adds
`rec_runs` / `rec_run_participants`, policies, real-time, and the host auto-join
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

## Down to play

An availability ping to friends: in the **📣 Activity** sheet tap **🤙 I’m down** →
optionally pick a **sport** (or leave it **🤸 Anything** — just down for some
recreation) and **Right now** or **At a time** (+ optional note). You can also seed
the location up front — an optional **Indoor / Outdoor / Either** preference and an
optional **specific court** (or leave it **Anywhere** and let friends decide) — the
same filters the map uses. Anything you set shows on the session sheet as a "Prefers:
…" line; anything you leave blank stays open for friends to suggest. Friends see it
live in their Activity feed, and the Activity button shows an **unread badge** — the
in-app "notification". Signals are **friends-only** (RLS) and **auto-expire** 2h after
they start. The chosen sport rides along on the feed row and the session sheet, and
scopes which courts/times you can suggest (an **Anything** signal falls back to a
default sport for those suggestions).

Each signal is a **joinable session**: tap it to open the session sheet, **join**
(**I'm in**), **suggest an activity → place → time**, and — as the host — **confirm**
one (either a participant's suggestion or your own). You pick the **sport/activity**
first (essential for an *Anything* signal — it has none yet), which scopes the **rec
center** options and a time **limited to that court's open-gym blocks** (shared with
the run form via `dropinWeekdays` / `openGymSlots` in `lib/hours.js`); the host
confirming a suggestion promotes its sport onto the signal. Joining or suggesting
**drops you into the signal's group chat** and posts an announcement there ("I'm in!"
/ "Suggested {sport} · {court} · {when}"), so everyone sees who's in and what they
proposed. The
confirmed court + time show to everyone and extend the session's expiry. Code lives in
`lib/signals.js`, `components/SignalModal.js` (composer), and
`components/SessionModal.js` (session).

Setup: run [`supabase/schema/06_signals.sql`](supabase/schema/06_signals.sql) — it
adds `rec_signals` + `rec_signal_participants` (with the sport, creator place/court
prefs, and suggested/confirmed court + time columns), policies, the auto-join trigger,
and real-time. On an **existing** DB, apply
[`006_signal_sport.sql`](supabase/migrations/006_signal_sport.sql) (the `sport`
column) and [`015_signal_place_court.sql`](supabase/migrations/015_signal_place_court.sql)
(the creator's `place` + `pref_court_id` prefs).

> **Note:** the in-app feed is real-time. To also **buzz the phone when the app
> is closed**, see *Push notifications* below.

## Chat

The **Social → Chats** tab lists every conversation you're in: **group chats** for
runs and "down to play" sessions (you're added when you join) and **1:1 direct
chats** with friends, plus a row of friends to start a new direct chat. A thread
opens a messaging view with colored avatars, **date dividers**, timestamped message
bubbles, and a rounded composer. Swipe a row to hide a chat (restore it from the
**Deleted** view). All three kinds share one `chat_messages` table, scoped by RLS;
read state + hidden threads are tracked locally (`AsyncStorage`). Code lives in
`lib/chat.js`, `components/ChatsScreen.js` (list), and `components/ChatThread.js`
(conversation). Setup: run [`supabase/schema/08_chat.sql`](supabase/schema/08_chat.sql).

## Recommended for you

The top of the **Social** tab shows an auto-revolving card of suggestions tailored
to your **interests** — your **favorite sports** and **class categories** (any of
the Classes tab's ten), both set on your profile. It mixes
**open-gym games** happening today for your sports (“Play basketball at Palega ·
2:00 PM” — tap to open that court **on the matching sport**) with **rec-center
classes that have openings** in your categories (“Zumba at Sunset Rec · Openings” —
tap for a detail sheet, `components/ClassDetail.js`, then register on ActiveNet).
With no interests set it recommends across everything. All computed on-device from the
bundled court + class data (`lib/recommend.js`, `components/RecommendPane.js`); set
interests are stored in `profiles.favorite_categories` (run
[`supabase/migrations/008_add_interests.sql`](supabase/migrations/008_add_interests.sql)).

The same matches drive **interest-based local notifications** (`lib/localNotify.js`):
when you open the app, it schedules on-device reminders ~30 min before today's
matching games and classes, so you get a nudge even if the app is closed (deduped
per day; needs interests + notification permission). Server push for events while
the app has never been opened is a deliberate later addition.

## Trust & safety (report / block)

Because the app carries user-generated content (chat, reviews, signals) — which
the App Store requires apps to moderate — users can **report** objectionable
content and **block** abusive accounts. **Long-press a chat message** to report it
or block the sender; **reviews** have a **Report** link (reviews are anonymous, so
no block). Blocking is stored in `blocked_users` (syncs across your devices) and
filtered into every social loader (`signals`, `chat`, `feed`, `friends`), so a
blocked user's content disappears everywhere; manage/undo from **Settings →
Blocked users**. Reports land in `content_reports` for out-of-band review. Account
creation also requires agreeing to the **Terms (EULA)** and **Privacy Policy**.
Posting a **review** additionally requires sign-in (see *Reviews*). Setup: run
[`supabase/schema/10_moderation.sql`](supabase/schema/10_moderation.sql).

### Accessibility

Every **icon-only control** carries an `accessibilityLabel` (+ `accessibilityRole`)
so VoiceOver announces it instead of reading a raw glyph — the sport & filter FABs,
the recenter button, all ✕ close buttons (card / Settings / Blocked users), the
location-banner dismiss, the bottom-nav tabs (with a `selected` state), and the
review Report action. This is an App Store review consideration as much as a UX one.

## Push notifications

Real pushes (`expo-notifications`) for the social moments that matter, so they
land even when the app is closed:

| Event | Who gets it |
| --- | --- |
| A friend posts **"down to play"** | their friends |
| A friend **plans a run** | their friends |
| Someone **joins** your run / session | the host |
| A session's **court + time is confirmed** | the other participants |
| Your **friend request is accepted** | the requester |

**How it works.** On sign-in the app registers the device's **Expo push token**
in a `device_tokens` table (`lib/push.js`). Postgres triggers on `rec_signals`,
`rec_runs`, the participant tables, `check_ins`, and `friendships` call a
`send_push()` helper that POSTs to **Expo's push API straight from the database
via `pg_net`** — no Edge Function or server to run. `send_push()` sends **one
request per token** (Expo rejects a batch that mixes tokens from different
projects, so one stale token can't silence a broadcast), and crowd-update pushes
are **rate-limited to one per voter+court per 10 min** (`crowd_notify_log`) so
rapid level-switching doesn't spam friends. Tapping a push deep-links into the app (the
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

## 🏊 Swimming pools

The **Pools** tab maps SF's **9 public swimming pools** with their weekly swim
schedules. Each pool only posts its schedule as a **seasonal PDF**, so
`scripts/build-pools.js` discovers each pool's current schedule-PDF link live,
downloads it, extracts the text with **`pdfjs-dist`**, and reconstructs the weekly
grid (merge text fragments → map cells to day columns by x-position → pair each
activity label with the time below it → classify into a session **kind**). Output is
`sessions[dow] = [{ kind, start, end }]` — minutes-from-midnight, `0=Sun..6=Sat`,
same convention as courts. North Beach has **two pools under one roof** with
separate warm-/cool-pool PDFs, so its sessions also carry `pool: "warm" | "cool"`
and render as separately labeled ♨️/❄️ groups.

Session kinds (**lap / family / senior / lessons / adult lessons / parent-child /
water exercise / camps / rentals**) render as color-coded, localized pills. Each
pool card shows **open now / next up**, today's sessions, an expandable **full
week**, a **session-type filter**, distance, phone, and a link to the **official
PDF** (the source of truth). A shared **fees** sheet shows the city-wide aquatics
price schedule. Pool coordinates, addresses, phones, season labels, fees, and
holiday closures are **curated** in the build script (the facility pages have no
lat/lng, and fees change ~annually). `npm run build:pools`, same cache + gate
resilience (`scripts/pools-cache.json`). `pdfjs-dist` is a **build-only** dependency
— it isn't bundled into the app.

> The schedules are machine-parsed from PDFs, so dense multi-lane grids can miss the
> odd concurrent session — the card always links the official PDF to confirm.

## 🌐 Languages (i18n)

The entire UI is localized in **English, 中文, and Español** — switch in **Profile →
⚙️ Settings** (the choice persists in `AsyncStorage`). React components read
`const { t, lang } = useI18n()`; plain non-React modules (date helpers, crowd "X ago",
court/pool hours, data-layer error messages) translate through a module-level
`tg()` that mirrors the active language into a global, so they localize without React
context. All strings live in one `STRINGS` dictionary in `lib/i18n.js`, kept at **full
key parity** across the three languages. External data stays in its source language
(court/pool names, addresses, scraped schedules) — the one exception is scraped **class
titles**, pre-translated at build time (see *Classes & activities* above).

## Settings & account deletion

**Profile → ⚙️ Settings** opens a sheet with the language switch, a **Legal &
Support** section (links to the **Privacy Policy**, **Terms (EULA)**, and **Support**
pages), an optional **Share activity with friends** toggle, and a **Delete my
account** action. Deletion asks the user to type a confirmation word, then calls a
`delete_account()` **SECURITY DEFINER** Postgres RPC that deletes their `auth.users`
row; FK `ON DELETE CASCADE` then clears all of their app data (profile, check-ins,
runs, signals, friendships, chats, push tokens). Setup: run
[`supabase/schema/09_account_deletion.sql`](supabase/schema/09_account_deletion.sql)
(or [`supabase/migrations/005_account_deletion.sql`](supabase/migrations/005_account_deletion.sql)
on an existing DB).

### App Store privacy label

The App Store **privacy nutrition label** (configured in App Store Connect, not the
repo) must match the written [Privacy Policy](public/privacy.html).
[`docs/privacy-nutrition-label.md`](docs/privacy-nutrition-label.md) reconciles the
two: it maps every data type the app actually collects (email, name, user id, push
token, user content — all *linked, not tracking, app-functionality*) to the exact
ASC selections, and flags that **Location must stay "Not Collected"** because it's
used on-device only (declaring it would contradict the policy). The same collected
types are declared in `app.json` → `ios.privacyManifests` so the shipped
`PrivacyInfo.xcprivacy` is consistent too.

## Deploy (web)

The web build is a **static SPA export** — `npm run build:web` (= `expo export
--platform web` → `dist/`, then `scripts/postbuild-web.js`, which injects SEO
metadata into `index.html` and prerenders crawlable landing pages, sitemap, and
robots.txt from the bundled data). `vercel.json` configures that build command,
`dist` as the publish dir, and an SPA rewrite of all routes to `index.html`; set the
three `EXPO_PUBLIC_*` vars in the Vercel dashboard since a CI build has no local `.env`.
**Vercel Analytics** is mounted
web-only (`components/WebAnalytics.web.js`, `@vercel/analytics/react`) and only collects
when served from Vercel. The iOS app is **iPhone-only** (`ios.supportsTablet: false`);
cloud EAS builds don't read the local `.env`, so `EXPO_PUBLIC_*` vars are set in the EAS
**production** environment.

## Ideas for next

- **Invite links:** wrap a friend code in a deep link to add with one tap.
- **More outdoor sports:** the DataSF facilities dataset also has volleyball,
  skatepark, and other court types — the outdoor pipeline can fold them in next.
- **Per-court hours for outdoor courts:** today they use a fixed park-hours window;
  some SF courts publish real hours / reservation windows worth scraping.
