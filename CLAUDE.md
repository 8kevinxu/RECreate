# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Expo version

This project is on **Expo SDK 54 / React Native 0.81 / React 19**. Expo's APIs change between major versions — read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing native/Expo code (per `AGENTS.md`).

## Commands

```bash
npm install            # install deps
npx expo start         # dev server; press i (iOS sim), a (Android), w (web), or scan QR in Expo Go
npx expo start -c      # same, clearing cache — required after changing .env vars
npm run ios            # native dev build on device/sim (needed for push; Expo Go can't do remote push)
npm run web            # web build (the static export Vercel/Netlify serves)

# Regenerate the bundled court/class/pool data (scrapes live sources):
npm run build:data         # everything below, in order
npm run build:courts       # SF Rec & Parks indoor gyms
npm run build:sanbruno     # San Bruno RAC (Google Sheet)
npm run build:outdoor      # outdoor basketball/tennis/pickleball (DataSF)
npm run build:reservations # tennis/pickleball booked% (rec.us)
npm run build:directory    # court facility facts (sfrecpark directories)
npm run build:classes      # ActiveNet classes catalog (+ Claude title translation if ANTHROPIC_API_KEY set)
npm run build:pools        # swimming pools + schedules parsed from seasonal PDFs (pdfjs-dist)
```

`build:classes` and `build:pools` need network access; `build:classes` optionally calls the Anthropic API (Claude Haiku) to translate new class titles to zh/es when `ANTHROPIC_API_KEY` is set, caching results in `scripts/classes-i18n-cache.json` (degrades gracefully to English without a key).

There is **no test suite, linter, or typechecker** configured — this is a plain JS (not TS) Expo app. "Verifying" a change means running the app (`npx expo start`).

## Architecture

A single-screen Expo/React Native app (also deployed to web as a static export) for finding places to play sports in SF. Three pieces fit together:

### 1. UI — one big `App.js` + a bottom-tab shell

`index.js` → `Root` wraps `App` in `SafeAreaProvider` + `AuthProvider`, all inside `I18nProvider` (see i18n below). `App.js` (~1900 lines) holds the home map screen, all shared state, and the `CourtDetail` card. `BottomNav` switches five tabs via the `tab` state in `App.js`: `home` (map) · `classes` (`ClassesScreen`) · `pools` (`PoolsScreen` — swimming) · `social` (`SocialScreen`) · `profile`. Most other features render as **modals** (`AuthModal`, `RunModal`, `FriendsModal`, `FeedModal`, `SignalModal`, `SessionModal`, …) toggled from `App.js`.

The map is **Leaflet + OpenStreetMap inside a WebView** (no API key/billing). `components/CourtMap.js` is the native (WebView) implementation; `components/CourtMap.web.js` is the web variant — Metro picks `.web.js` automatically on web, so **keep marker/animation logic in sync across both files**.

### 2. `lib/` — feature stores, each with the same Supabase-or-local pattern

`lib/supabase.js` exports a `supabase` client **or `null`** when `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` are unset. This null-check is the core architectural seam: **every social/shared feature must degrade gracefully when `supabase` is null** — crowd check-ins fall back to on-device `AsyncStorage`, and account/social features hide entirely. Don't assume the client exists.

Each file in `lib/` owns one feature's data access (e.g. `crowd.js`, `reviews.js`, `runs.js`, `signals.js`, `friends.js`, `feed.js`, `chat.js`, `push.js`, `playerCheckins.js`, `favorites.js`, `blocks.js`, `reports.js`). **Trust & safety (App Store UGC requirement):** `lib/blocks.js` (`getBlockedIds` — in-memory-cached, invalidated on block/unblock) is filtered into every social loader (`signals`, `chat`, `feed`, `friends`) so a blocked user's content disappears app-wide; `lib/reports.js` files content reports. Report/block surface on chat messages (long-press) and reviews (report-only — reviews have no `user_id`); Settings has a Blocked-users manager, and account creation requires agreeing to the EULA/privacy terms. Realtime features merge incoming rows **incrementally by `id`** (e.g. `mergeCheckIn`) rather than refetching. `lib/auth.js` is the `AuthProvider` context (session + profile). `lib/useCourts.js` is the launch-time data loader. `lib/hours.js` holds the open-now / open-gym schedule logic shared between the map filter, Nearby list, and run/signal time pickers. `lib/favorites.js` (`useFavorites` hook) stores favorites on-device via `AsyncStorage` (works fully signed-out, like crowd check-ins) as a **court id → sport** map: a court is favorited *for the sport you were viewing* when you starred it. The sport speed-dial's ⭐ **Favorites** entry switches the map into a personal view of just those courts, each marker/card judged open **for its favorited sport**; the card's star (`toggle(id, sport)`) saves/removes the court for the displayed sport. `lib/sports.js` defines the tracked sports (basketball, volleyball, ping pong, pickleball, tennis) plus the `ANY_SPORT` (`'any'`) sentinel — "just down for rec", a sport-less **"down to play"** signal (no real schedules key off it, so the session sheet falls back to a default sport for court/time suggestions). Both planned runs and signals carry a `sport`; a run's/signal's sport scopes its court/time suggestions, and signals may be `ANY_SPORT`. Joining a run or signal makes you a member of its `chat_messages` group thread (`lib/chat.js`) — `chat_messages` holds run/signal group chats and 1:1 direct chats in one RLS-scoped table; joining a signal from the session sheet also posts an announcement into that chat.

**i18n (`lib/i18n.js`):** the app is fully localized to English / 中文 / Español. `I18nProvider` holds the chosen language (persisted in `AsyncStorage` under `hoopmap.lang`); React components read `const { t, lang } = useI18n()`. Plain non-React modules (`datetime`, `crowd`, `hours`, the `lib/*` error messages) translate through the module-level `tg(key, vars)` helper, which mirrors the current language into a global so it works without context. All strings live in one `STRINGS` dict keyed by language — **keep en/zh/es at full key parity** (a quick `eval`-based count check catches drift). Composed sentences use `{placeholder}` interpolation, not string concatenation. External data (court/pool names, addresses, scraped class/schedule text) stays in its source language; scraped **class titles** are the exception — they're pre-translated at build time (see `build:classes`).

Supabase DDL lives in `supabase/schema/` (canonical, numbered 01→10 — `09_account_deletion.sql` is the SECURITY DEFINER `delete_account()` RPC behind Settings → Delete account; `10_moderation.sql` is trust & safety: `blocked_users` + `content_reports` — **run in order** on a fresh DB, later domains depend on earlier) and `supabase/migrations/` (deltas for existing DBs). When adding a feature with a new table, add a numbered schema file and document its dependency order in `supabase/README.md`.

### 3. `data/` + `scripts/` — a generated, self-refreshing data pipeline

**`data/courts.js`, `data/courts.json`, `data/outdoor-courts.js`, `data/classes.js`, `data/pools.js`, etc. are GENERATED — never edit them by hand.** Each is produced by the matching `scripts/build-*.js`, which scrapes a live source (sfrecpark.org via cheerio, DataSF `ib5c-xgwu`, rec.us API, a Google Sheet, ActiveNet). The two hand-authored data files are `data/manual-courts.js` (fully-static courts merged in at runtime by `lib/useCourts.js`, deduped by `id`) and the `CENTERS` table inside `scripts/build-indoor-courts.js`.

Build resilience pattern (shared by every script): each source falls back **live → cache → curated**, with a `scripts/*-cache.json` last-good snapshot and a validation gate that aborts the build (keeping old data) if too few records scrape — so an upstream site redesign fails loudly instead of publishing empty data.

**Pools are the unusual one (`scripts/build-pools.js` → `data/pools.js`):** the 9 SF public pools post their weekly swim schedules only as *seasonal PDFs* (re-issued every few months) on their facility pages. The script discovers each pool's current schedule PDF link live, downloads it, extracts positioned text via `pdfjs-dist` (a build-only devDep — not bundled into the app), and reconstructs the weekly grid geometrically (merge text fragments → map cells to day columns by x → pair each activity label with the time below it → classify into a session `kind`). Output is `sessions[dow] = [{ kind, start, end }]` (0=Sun..6=Sat, minutes-from-midnight, same convention as court schedules), plus the city-wide `POOL_FEES` and `POOL_CLOSURES`. Pool coordinates/addresses/phones and the `season`/closure labels are **curated** in the script's `META`/`FEES`/`CLOSURES` tables (pages have no lat/lng; fees change ~annually, not seasonally) — bump these by hand each season. `PoolsScreen` renders a localized label per `kind` and links out to the official PDF as the source of truth.

`lib/useCourts.js` loads data **bundled (instant) → cached → remote** (`EXPO_PUBLIC_COURTS_URL`) so the app renders offline immediately then revalidates. It also merges the auxiliary generated maps onto each court: `reserved` (booked%), `directory` (facility facts).

GitHub Actions crons re-run the builds and commit only when the generated data changed: `refresh-schedules.yml` runs `build:data` weekly (courts, reservations, directory, classes, **pools**) and `refresh-classes.yml` re-scrapes classes every 6h. **When adding a new generated file, also add it to the workflow's `FILES` commit list** or the refresh will run but never commit it. Because reservation/class/pool slots are date- or season-keyed and go stale, this refresh is what keeps "right now" accurate.

## Environment & config

All runtime config is `EXPO_PUBLIC_*` (inlined at build time, client-safe — the Supabase anon key is protected by RLS). Copy `.env.example` → `.env`. The app runs fully **signed-out with no env vars set** (bundled data + local check-ins); env vars progressively enable remote data and social features. Restart with `npx expo start -c` after changing `.env`.

`ANTHROPIC_API_KEY` is **not** an app var — it's used only by `build:classes` (CI/local) to translate class titles. Never expose it to the web build; only the `EXPO_PUBLIC_*` vars belong in the host's env.

## Deploy (web)

The web target is a **static SPA export** (`npx expo export --platform web` → `dist/`), served by Vercel (`vercel.json`) or Netlify (`netlify.toml`) — both mirror the same build command, `dist` output, and SPA rewrite of all paths to `index.html`. Set the three `EXPO_PUBLIC_*` vars in the host dashboard (a CI build has no local `.env`). Don't run both hosts as primary auto-deploys at once. Note: the live ActiveNet class-availability fetch (`lib/classesLive.js`) is blocked by CORS on web and falls back to the bundled baseline — expected; native isn't bound by CORS.
