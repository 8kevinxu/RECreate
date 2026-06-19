# 🏀 HoopMap SF

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
| `scripts/build-indoor-courts.js` | Builds the data files; scrapes live schedules |
| `scripts/schedule-cache.json` | Last-good scraped schedule per facility (fallback) |
| `.github/workflows/refresh-schedules.yml` | Weekly cron that re-scrapes + commits |
| `lib/useCourts.js` | Fetches/caches court data at launch (bundled→cached→remote) |
| `lib/hours.js` | Open-now + basketball open-gym logic from per-weekday schedules |
| `lib/crowd.js` | Crowd check-in store (levels, freshness, "voted X ago") |

## Court data (SF Rec & Parks indoor gyms)

`data/courts.js` is **auto-generated** — don't edit it by hand. It combines three
sources:

1. **Which rec centers have an indoor gym + facility hours** — curated in the
   `CENTERS` table in the build script (rarely changes).
2. **Coordinates, addresses, neighborhoods** — DataSF "Recreation and Parks
   Facilities" dataset (`ib5c-xgwu`), fetched by property name.
3. **Open-gym basketball times** — **scraped live each build** from the
   *Gymnasium* row of each center's sfrecpark.org facility page.

Each court carries:
- `schedule[]` — facility operating hours (one block per day)
- `basketball[]` — drop-in open-gym blocks (can be several per day)
- `scheduleSource` — `"live"` (scraped this run) · `"cache"` (last-good) · `"curated"`

Regenerate anytime:

```bash
npm run build:courts
```

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

### Live updates for users (no app release needed)

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
The latest check-in shows as e.g. "🔴 Packed · voted 12 min ago", plus a short
**history** ("👥 4 check-ins in the last hour" and the recent votes), and animates
the map marker:

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
2. **SQL Editor → New query →** paste [`supabase/schema.sql`](supabase/schema.sql)
   → **Run** (creates the `check_ins` table, public read/insert policies, and
   turns on real-time).
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

**Rate limiting:** check-ins are throttled per device — at most one per court per
minute (`COURT_COOLDOWN_MS`) and ≥4s between any two (`GLOBAL_GAP_MS`), persisted
in AsyncStorage. This is a *soft* guard (cleared by reinstalling). For real abuse
protection before a public launch, also enforce it server-side (a Supabase
policy / edge function keyed on IP or a device token).

## Ideas for next

- **Distance sort:** rank courts by distance from the user.
- **Server-side rate limit:** complement the per-device cooldown with a Supabase
  policy/edge function so it can't be bypassed by clearing app storage.
- **Live availability:** let players check in ("I'm here / how crowded").
- **Outdoor courts / more sports:** the data model has room (`indoor`, `source`
  fields) to bring back outdoor courts or add other sports later.
