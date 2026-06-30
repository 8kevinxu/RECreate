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
npm run web            # web build (also how the Netlify deploy renders)

# Regenerate the bundled court/class data (scrapes live sources):
npm run build:data         # everything below, in order
npm run build:courts       # SF Rec & Parks indoor gyms
npm run build:sanbruno     # San Bruno RAC (Google Sheet)
npm run build:outdoor      # outdoor basketball/tennis/pickleball (DataSF)
npm run build:reservations # tennis/pickleball booked% (rec.us)
npm run build:directory    # court facility facts (sfrecpark directories)
npm run build:classes      # ActiveNet classes catalog
```

There is **no test suite, linter, or typechecker** configured — this is a plain JS (not TS) Expo app. "Verifying" a change means running the app (`npx expo start`).

## Architecture

A single-screen Expo/React Native app (also deployed to web via Netlify) for finding places to play sports in SF. Three pieces fit together:

### 1. UI — one big `App.js` + a bottom-tab shell

`index.js` → `Root` wraps `App` in `SafeAreaProvider` + `AuthProvider`. `App.js` (~1900 lines) holds the home map screen, all shared state, and the `CourtDetail` card. `BottomNav` switches four tabs via the `tab` state in `App.js`: `home` (map) · `classes` (`ClassesScreen`) · `social` (`SocialScreen`) · `profile`. Most other features render as **modals** (`AuthModal`, `RunModal`, `FriendsModal`, `FeedModal`, `SignalModal`, `SessionModal`, …) toggled from `App.js`.

The map is **Leaflet + OpenStreetMap inside a WebView** (no API key/billing). `components/CourtMap.js` is the native (WebView) implementation; `components/CourtMap.web.js` is the web variant — Metro picks `.web.js` automatically on web, so **keep marker/animation logic in sync across both files**.

### 2. `lib/` — feature stores, each with the same Supabase-or-local pattern

`lib/supabase.js` exports a `supabase` client **or `null`** when `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` are unset. This null-check is the core architectural seam: **every social/shared feature must degrade gracefully when `supabase` is null** — crowd check-ins fall back to on-device `AsyncStorage`, and account/social features hide entirely. Don't assume the client exists.

Each file in `lib/` owns one feature's data access (e.g. `crowd.js`, `reviews.js`, `runs.js`, `signals.js`, `friends.js`, `feed.js`, `chat.js`, `push.js`, `playerCheckins.js`). Realtime features merge incoming rows **incrementally by `id`** (e.g. `mergeCheckIn`) rather than refetching. `lib/auth.js` is the `AuthProvider` context (session + profile). `lib/useCourts.js` is the launch-time data loader. `lib/hours.js` holds the open-now / open-gym schedule logic shared between the map filter, Nearby list, and run/signal time pickers. `lib/sports.js` defines the tracked sports (basketball, volleyball, ping pong, pickleball, tennis).

Supabase DDL lives in `supabase/schema/` (canonical, numbered 01→08, **run in order** on a fresh DB — later domains depend on earlier) and `supabase/migrations/` (deltas for existing DBs). When adding a feature with a new table, add a numbered schema file and document its dependency order in `supabase/README.md`.

### 3. `data/` + `scripts/` — a generated, self-refreshing data pipeline

**`data/courts.js`, `data/courts.json`, `data/outdoor-courts.js`, `data/classes.js`, etc. are GENERATED — never edit them by hand.** Each is produced by the matching `scripts/build-*.js`, which scrapes a live source (sfrecpark.org via cheerio, DataSF `ib5c-xgwu`, rec.us API, a Google Sheet, ActiveNet). The two hand-authored data files are `data/manual-courts.js` (fully-static courts merged in at runtime by `lib/useCourts.js`, deduped by `id`) and the `CENTERS` table inside `scripts/build-indoor-courts.js`.

Build resilience pattern (shared by every script): each source falls back **live → cache → curated**, with a `scripts/*-cache.json` last-good snapshot and a validation gate that aborts the build (keeping old data) if too few records scrape — so an upstream site redesign fails loudly instead of publishing empty data.

`lib/useCourts.js` loads data **bundled (instant) → cached → remote** (`EXPO_PUBLIC_COURTS_URL`) so the app renders offline immediately then revalidates. It also merges the auxiliary generated maps onto each court: `reserved` (booked%), `directory` (facility facts).

GitHub Actions crons (`.github/workflows/refresh-schedules.yml`, `refresh-classes.yml`) re-run the builds weekly and commit only when the generated data changed. Because reservation/class slots are date-keyed and go stale, this refresh is what keeps "right now" accurate.

## Environment & config

All runtime config is `EXPO_PUBLIC_*` (inlined at build time, client-safe — the Supabase anon key is protected by RLS). Copy `.env.example` → `.env`. The app runs fully **signed-out with no env vars set** (bundled data + local check-ins); env vars progressively enable remote data and social features. Restart with `npx expo start -c` after changing `.env`.
