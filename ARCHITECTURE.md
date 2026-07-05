# RECreate — Architecture

RECreate is a mobile-first app for finding places to play sports and recreate in
San Francisco: indoor rec-center gyms, outdoor courts, swimming pools, and
drop-in classes — with live "how busy is it" crowd signals, court reservation
availability, and lightweight social features (friends, planned runs, "down to
play" pings, group chat). It's an **Expo / React Native** app that ships to iOS
and Android and also exports to the web as a static SPA.

This document explains how the pieces fit together. For day-to-day contributor
rules and gotchas, see `CLAUDE.md`; for the database, see `supabase/README.md`.

---

## 1. Tech stack

| Concern | Choice |
|---|---|
| App framework | Expo SDK 54 / React Native 0.81 / React 19 (plain JS, not TS) |
| Navigation | A single `tab` state in `App.js` + modals (no router lib) |
| Map | Leaflet + OpenStreetMap inside a `WebView` (no API key / billing) |
| Backend (optional) | Supabase (Postgres + Auth + Realtime + `pg_net` push) |
| Local persistence | `AsyncStorage` |
| i18n | Hand-rolled dictionary in `lib/i18n.js` (English / 中文 / Español) |
| Push | Expo Push, triggered from Postgres via `pg_net` |
| Hosting (web) | Vercel (primary) / Netlify — static export of `dist/` |
| Data refresh | GitHub Actions crons re-scrape public sources and commit |

There is **no test suite, linter, or typechecker** — "verifying" a change means
running the app (`npx expo start`). Non-UI logic is validated by running modules
in Node and by parsing changed files with `@babel/parser`.

---

## 2. The big picture

Three layers fit together, each with a clear boundary:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. UI            App.js (map + shared state) · tab screens ·      │
│                  modals · CourtMap WebView                        │
├─────────────────────────────────────────────────────────────────┤
│ 2. lib/          one file per feature's data access.              │
│                  Supabase-or-local seam (supabase may be null).   │
├─────────────────────────────────────────────────────────────────┤
│ 3. data/ + scripts/   generated, self-refreshing datasets         │
│                       (courts, classes, pools, reservations)      │
└─────────────────────────────────────────────────────────────────┘
        │                        │                         │
   Supabase (RLS)         rec.us / ActiveNet         sfrecpark / DataSF
   accounts + social      live availability          scraped at build time
```

The **central design seam** is `lib/supabase.js`: it exports a configured client
**or `null`** when the `EXPO_PUBLIC_SUPABASE_*` env vars are unset. Every social /
shared feature must degrade gracefully when it's null — the app runs fully
signed-out on bundled data + on-device storage, and account/social features
simply hide. This is what lets the app work offline and without any backend.

---

## 3. UI layer

### Shell
`index.js` → `Root` wraps `App` in `SafeAreaProvider` + `AuthProvider`, all inside
`I18nProvider`. `App.js` (~1900 lines) is deliberately the hub: it holds the home
**map screen**, all shared cross-feature state, and the `CourtDetail` card.

`BottomNav` switches five tabs via a `tab` state:

- `home` — the map (default)
- `classes` — `ClassesScreen` (drop-in classes catalog)
- `pools` — `PoolsScreen` (swim schedules)
- `social` — `SocialScreen` (activity feed, recommendations, chats)
- `profile` — account / settings

Most other features are **modals** toggled from `App.js` (`AuthModal`, `RunModal`,
`SignalModal`, `SessionModal`, `FriendsModal`, `FeedModal`, `NearbyList`, …).

### The map
`components/CourtMap.js` (native, a `WebView` running Leaflet) and
`components/CourtMap.web.js` (the web variant Metro auto-selects) render markers.
**Keep marker/animation logic in sync across both files.** Markers are inline SVG
sport glyphs (`SPORT_SVG`), faded when a court isn't open now, and animate on the
latest fresh crowd check-in. Only numeric/enum fields are injected into the
WebView (ids, coords, sport, open/booked/crowd) — never user text — so there is no
injection surface.

### Sports vs. facility views
`lib/sports.js` defines the **playable** sports (`SPORTS`: basketball, volleyball,
ping pong, badminton, pickleball, tennis, soccer, baseball) that you can plan runs
/ post signals / favorite.
It also exports `WEIGHT_ROOM`, `GOLF`, and `MAP_SPORTS` (`SPORTS` + both): each is
a *facility view* — the **weight room** spans rec-center weight rooms plus DataSF
outdoor fitness courts, scraped into `dropins.weightroom` like a sport; **golf** is
the 6 SFRPD courses, hand-curated in `data/manual-courts.js` with daylight-hours
`dropins.golf` weeks plus a `golf` block (holes/par/yardage, green fees, tee-time
booking link) the court card renders, and golf-only filter chips (9/18 holes,
beginner-friendly, driving range) that surface via the generic amenity-chip
machinery. Both are selectable in the map's sport picker but kept out of
`SPORTS` so they never leak into runs/signals/favorites (`isPlayableSport()` guards
the hand-off to social features), though both are in `PLAN_SPORTS` so the social
composers can plan a lifting session or a round. The picker's ⭐ **Favorites**
entry is a similar non-sport map view.

The map's filtering is fully generic over `dropins[sport]`: `offersSport`,
open-now status (`lib/hours.js`), and the `CourtDetail` card all key off the
selected sport, so a new activity "just works" once its data is populated.

---

## 4. Data layer (`lib/`)

Each file owns one feature's data access and follows the same **Supabase-or-local**
pattern.

| Module | Responsibility |
|---|---|
| `supabase.js` | The client or `null` (the seam) |
| `auth.js` | `AuthProvider` context: session + profile; sign up/in/out, update, delete |
| `useCourts.js` | Launch-time court loader: bundled → cached → remote; merges `reserved`/`directory` |
| `hours.js` | Open-now / open-gym schedule logic (shared by map, Nearby, time pickers) |
| `crowd.js` | Anonymous "how busy" check-ins (Supabase shared + realtime, or local) |
| `playerCheckins.js` | Personal "I played here" log (per-sport stats, feed) |
| `reservations.js` / `reservationsLive.js` | rec.us booking occupancy: snapshot helpers + live per-court fetch |
| `reviews.js`, `favorites.js` | Court reviews (anonymous); on-device favorites (court→sport) |
| `runs.js`, `signals.js`, `friends.js`, `feed.js`, `chat.js` | Social graph + activities |
| `push.js` | Device push-token registration + tap routing |
| `recommend.js` / `localNotify.js` | "Recommended for you" + interest-based local reminders |
| `blocks.js`, `reports.js` | Trust & safety (block list, content reports) |
| `i18n.js`, `datetime.js`, `maps.js`, `distance.js` | Cross-cutting utilities |

**Realtime** features merge incoming rows incrementally by `id` (e.g.
`mergeCheckIn`) rather than refetching.

### Court availability: snapshot + live
Reservation occupancy (tennis/pickleball on rec.us) is bundled as a **snapshot**
(`data/reservations.js`) for instant/offline render, then, on native, upgraded to
a **live** reading when a court card opens: `reservationsLive.js` fetches that one
rec.us location and recomputes per-slot booked% with the same math as the build
script. Web can't reach rec.us (CORS) and keeps the snapshot. The card labels
freshness ("Live from rec.us" vs "as of M/D") and only asserts a hard "Fully
booked" when the reading is live or the snapshot is <6h old.

---

## 5. Accounts, social & trust/safety (Supabase)

Auth is Supabase email+password; `handle_new_user` auto-creates a `profiles` row.
The DDL lives in `supabase/schema/` (canonical, numbered `01→10`, run in order)
with `supabase/migrations/` as deltas for existing databases.

**Row-Level Security is the security boundary** — the anon key ships in the client,
so every table has RLS: public/anonymous data (crowd check-ins, reviews) allows
read+insert with server-side rate limits; owned data (profiles, runs, signals,
friendships, chat, device tokens, blocks) scopes writes to `auth.uid()`.
Friends-only visibility (signals, friends-only runs) is enforced by RLS subqueries
against the `friendships` table.

**Trust & safety** (App Store UGC requirement): `blocks.js` filters a blocked
user's content out of every social loader app-wide; `reports.js` files content
reports; Settings has a block manager and account self-deletion
(`delete_account()` SECURITY DEFINER RPC that cascades all user data).

### Notifications
Server push (while the app is closed) is handled entirely in Postgres:
`schema/07_push.sql` triggers call Expo's push API via `pg_net` (`send_push()`).

- **Direct pings** — someone joined your run/signal, a session was confirmed, a
  friend request was accepted — always fire.
- **Broadcasts** — you checked in, reported a court's crowd level, posted "down to
  play", or planned a run — are gated on a per-row `notify` flag the client sets
  from `profiles.share_activity` (Settings → "Share activity with friends",
  default on). When that setting is off, the client prompts per-action
  (`lib/activityShare.js`). The crowd-vote trigger takes the voter from
  `auth.uid()` (crowd check-ins are otherwise anonymous), so who-voted can't be
  spoofed.

`send_push()` and `accepted_friend_ids()` are `SECURITY DEFINER` and **revoked from
anon/authenticated** — only the trigger functions (running as owner) call them —
so a client can't push spam or enumerate friend lists. On-device **local**
notifications (`localNotify.js`) remind you ~30 min before matching games/classes,
independent of the server.

---

## 6. Generated data pipeline (`data/` + `scripts/`)

The `data/*.js` datasets are **generated — never hand-edited**. Each
`scripts/build-*.js` scrapes a live public source and writes a bundled module:

| Dataset | Source | Notes |
|---|---|---|
| `courts.js` | sfrecpark.org gym schedules + DataSF coords | indoor rec centers; also weight-room drop-in hours |
| `outdoor-courts.js` | DataSF | outdoor courts & fields (basketball/volleyball/tennis/pickleball/soccer/baseball) + fitness courts; greater-SF bounds only (Camp Mather excluded) |
| `reservations.js` | rec.us API | tennis/pickleball booked% per court+slot |
| `court-directory.js` | sfrecpark directories | facility facts |
| `classes.js` | ActiveNet | full catalog (33 source categories → 10 app categories, one id per query — multi-id search drops categories); real prices via the detail price-estimate endpoint; titles pre-translated to zh/es |
| `pools.js` | seasonal PDFs (pdfjs-dist) | weekly swim grids reconstructed geometrically |

**Resilience pattern** (shared by every script): each source falls back
**live → cache (`scripts/*-cache.json`) → curated**, with a validation gate that
aborts the build (keeping old data) if too few records scrape — so an upstream
redesign fails loudly instead of publishing empty data.

**Class-title translation:** `build-classes.js` translates *new* distinct titles
to zh/es via Claude Haiku when `ANTHROPIC_API_KEY` is set, caching them in
`scripts/classes-i18n-cache.json` (so each refresh spends ~0 tokens). Without the
key it degrades to English — which means the CI key must be set for new titles to
localize automatically.

**Refresh crons** (`.github/workflows/`): `refresh-schedules.yml` runs the full
build weekly; `refresh-classes.yml` re-scrapes classes every 6h; and
`refresh-reservations.yml` re-scrapes rec.us occupancy every 3h (bookings change
hourly). Each commits only when the generated data changed. When adding a new
generated file, also add it to the workflow's commit `FILES` list.

At launch, `useCourts.js` loads **bundled (instant) → cached → remote**
(`EXPO_PUBLIC_COURTS_URL`), so the app renders offline immediately then
revalidates.

---

## 7. Internationalization

The app is fully localized to **English / 中文 / Español**. `I18nProvider` holds
the language (persisted in `AsyncStorage`); React components read `const { t } =
useI18n()`, and plain modules translate through the module-level `tg(key)` helper
(which mirrors the current language into a global). All strings live in one
`STRINGS` dict keyed by language — **keep en/zh/es at full key parity**.

External scraped text (court/pool names, addresses) stays in its source language,
with two exceptions handled for the user: scraped **class titles** are
pre-translated at build time, and **weekday tokens** in class schedule strings
(e.g. "Tue & Thu · … - Noon") are localized at render time by
`datetime.localizeWhen()`.

---

## 8. Deploy

- **Native**: Expo / EAS build to iOS + Android. Push requires a dev/production
  build (Expo Go can't do remote push).
- **Web**: `npx expo export --platform web` → `dist/`, a static SPA served by
  Vercel (`vercel.json`) or Netlify (`netlify.toml`), both rewriting all paths to
  `index.html`. Set the three `EXPO_PUBLIC_*` vars in the host dashboard. The web
  build can't do the rec.us / ActiveNet live fetches (CORS) and falls back to the
  bundled snapshots — expected; native isn't bound by CORS.

All runtime config is `EXPO_PUBLIC_*` (inlined at build, client-safe — the
Supabase anon key is protected by RLS). `ANTHROPIC_API_KEY` is **not** an app var;
it's used only by `build-classes.js` in CI/local to translate titles and must
never reach the client bundle.

---

## 9. Security model (summary)

- **Anon key is public by design** — RLS is the real boundary; every table has
  policies, and writes are scoped to `auth.uid()`.
- **Anonymous data** (crowd check-ins, reviews) has server-side per-IP rate limits
  as an abuse backstop.
- **SECURITY DEFINER functions** set `search_path` and are revoked from
  anon/authenticated unless they must be client-callable (only `delete_account()`
  is, and it acts solely on the caller).
- **No secrets in the repo** (`.env` gitignored); no `eval`/`dangerouslySetInnerHTML`;
  all network endpoints are HTTPS (so no iOS ATS exceptions needed).
