# RECreate — Architecture

RECreate is a mobile-first app for finding places to play sports and recreate in
**San Francisco and New York City**: indoor rec-center gyms, outdoor courts,
swimming pools, and drop-in classes — with live "how busy is it" crowd signals,
court reservation availability, and lightweight social features (friends,
planned runs, "down to play" pings, group chat). It's an **Expo / React Native**
app that ships to iOS and Android and also exports to the web as a static SPA.
The app auto-detects the user's metro (manual switcher in Settings); the
multi-city seam is a **city registry** (`lib/cities.js`) + per-city generated
data (`data/cities/<id>/`) + config-driven scrapers — see `CLAUDE.md` →
*Multi-city* for the full picture.

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
| Assistant (optional) | A separate Python/FastAPI service in `chatbot/` over Ollama or Anthropic |
| Hosting (web) | Vercel — static export of `dist/` + SEO postbuild |
| Data refresh | GitHub Actions crons re-scrape public sources and commit |

The JS app has **no test suite, linter, or typechecker** — "verifying" a change
means running the app (`npx expo start`), plus the `npm run check` CI gate (every
file parses, i18n at key parity, generated data non-trivial). Non-UI logic is
validated by running modules in Node. The **assistant service is the exception**:
`chatbot/` has 429 pytest tests, which `npm run check` does *not* run — see §7.

---

## 2. The big picture

Three layers fit together, each with a clear boundary:

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. UI            App.js (map + shared state) · tab screens ·      │
│                  modals · CourtMap WebView · ✨ AssistantHost     │
├─────────────────────────────────────────────────────────────────┤
│ 2. lib/          one file per feature's data access.              │
│                  Supabase-or-local seam (supabase may be null).   │
├─────────────────────────────────────────────────────────────────┤
│ 3. data/ + scripts/   generated, self-refreshing datasets         │
│                       (courts, classes, pools, occupancy)         │
│                       SF at data/*, other metros at data/cities/  │
└─────────────────────────────────────────────────────────────────┘
        │                        │                         │
   Supabase (RLS)         rec.us / ActiveNet         sfrecpark · DataSF
   accounts + social      live availability          nycgovparks · NYC Open Data
                                                     scraped at build time, per city

        ╎ optional sidecar, off unless self-hosted (§7)
   chatbot/  ◀── export-chatbot-data.js ── the same data/ snapshots
   FastAPI + deterministic retrieval ──▶ Ollama | Anthropic
```

The **central design seam** is `lib/supabase.js`: it exports a configured client
**or `null`** when the `EXPO_PUBLIC_SUPABASE_*` env vars are unset. Every social /
shared feature must degrade gracefully when it's null — the app runs fully
signed-out on bundled data + on-device storage, and account/social features
simply hide. This is what lets the app work offline and without any backend.

The **assistant follows the same shape**: `lib/assistant.js` is gated on
`EXPO_PUBLIC_ASSISTANT_URL`, and unset (what production ships) means the feature
doesn't render at all. Every optional dependency in this app degrades to
*absent*, never to *broken*.

---

## 3. UI layer

### Shell
`index.js` → `Root` wraps `App` in `SafeAreaProvider` + `AuthProvider`, all inside
`I18nProvider`. `App.js` (~1900 lines) is deliberately the hub: it holds the home
**map screen**, all shared cross-feature state, and the `CourtDetail` card.

`BottomNav` switches four tabs via a `tab` state:

- `home` — the map (default)
- `classes` — `ClassesScreen` (drop-in classes catalog)
- `social` — `SocialScreen` (activity feed, recommendations, chats)
- `profile` — account / settings

Swimming pools are a **sport on the map** (not a tab): `lib/poolCourts.js` shapes
`data/pools.js` into `swimming` court records and `components/PoolDetail.js`
renders the schedule/fees block in the `CourtDetail` card.

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
ping pong, badminton, pickleball, tennis, soccer, baseball, **swimming**,
**handball**) that you can plan runs / post signals / favorite. Swimming is a full
sport rather than a tab: `lib/poolCourts.js` shapes **every city's** pools (SF's 9
+ NYC's 92) into `swimming` court records whose open-now comes from their
public-swim sessions. Handball is NYC-only — 1,853 courts there, more than
basketball, and effectively nonexistent in SF — which costs SF nothing because
filters, landing pages and the sport pickers themselves self-hide where no record
qualifies. That last one is `sportsInCourts(list, courts, keep)`: a sport counts
for a city when some court in view carries drop-in hours for it, so the map's
sport dial, the interest pickers (onboarding + profile favorites) and the three
social composers all offer only what the active city has — SF never lists
handball, NYC never lists golf, and switching cities off a sport the new one
lacks falls back to `DEFAULT_SPORT` rather than stranding the map on empty. The
composers derive it from the city-filtered `courts` they already receive; the
dial and interest pickers key off the active city's slice of `courtData`. `keep`
forces ids in regardless, for the two cases where hiding one would be the bug: a
saved favorite (else a pick made in NYC couldn't be undone in SF) and a signal's
own sport (a signal can arrive from another metro).
It also exports `WEIGHT_ROOM`, `GOLF`, and `MAP_SPORTS` (`SPORTS` + both): each is
a *facility view* — the **weight room** spans rec-center weight rooms plus DataSF
outdoor fitness courts, scraped into `dropins.weightroom` like a sport; **golf** is
the 6 SFRPD courses, hand-curated in `data/manual-courts.js` with daylight-hours
`dropins.golf` weeks plus a `golf` block (holes/par/yardage, a short description,
green fees, tee-time booking + official-website links) the court card renders, and
golf-only filter chips (9/18 holes,
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
| `useCourts.js` | Court + occupancy loader: bundled → cached → remote (occupancy also on foreground); merges `reserved`/`directory` |
| `hours.js` | Open-now / open-gym schedule logic (shared by map, Nearby, time pickers) |
| `crowd.js` | Anonymous "how busy" check-ins, keyed **court + sport** (Supabase shared + realtime, or local) |
| `playerCheckins.js` | Personal "I played here" log (per-sport stats, feed) |
| `reservations.js` / `reservationsLive.js` | rec.us booking occupancy: snapshot helpers + live per-court fetch |
| `reviews.js`, `favorites.js` | Court reviews (anonymous); on-device favorites (court→sport) |
| `runs.js`, `signals.js`, `friends.js`, `feed.js`, `chat.js` | Social graph + activities |
| `push.js` | Device push-token registration + tap routing |
| `recommend.js` / `localNotify.js` | "Recommended for you" + interest-based local reminders |
| `blocks.js`, `reports.js` | Trust & safety (block list, content reports) |
| `assistant.js` / `assistantFallback.js` | The only link to the `chatbot/` service (gated on its URL env var) + on-device answers for app questions when it's down |
| `i18n.js`, `datetime.js`, `maps.js`, `distance.js` | Cross-cutting utilities |

**Realtime** features merge incoming rows incrementally by `id` (e.g.
`mergeCheckIn`) rather than refetching.

### Court availability: snapshot + live
Reservation occupancy (tennis/pickleball on rec.us) is bundled as a **snapshot**
(`data/reservations.js`) for instant/offline render, then upgraded to a **live**
reading when a court card opens: `reservationsLive.js` fetches that one rec.us
location and recomputes per-slot booked% with the same math as the build script.
`api.rec.us` sends `access-control-allow-origin: *`, so this works in the browser
too — the card is live on both platforms. The card labels freshness ("Live from
rec.us" vs "as of M/D") and only asserts a hard "Fully booked" when the reading is
live or the snapshot is <6h old.

**The snapshot itself refreshes over the wire** (`EXPO_PUBLIC_RESERVATIONS_URL` →
`data/reservations.json`), and it is the one dataset where that is mandatory
rather than nice to have. Court hours are weekday-indexed (`dropins[sport][dow]`)
and stay correct forever; reservation slots are keyed to **absolute dates** on a
rolling 7-day window, so the copy compiled into a build stops resolving about a
week after it ships — `liveBooked()` returns null for every court and the map,
Nearby list and card go quiet at once. Before this path existed, only a store
release could move it, and the 1.1.0 build ran dark for two weeks.

Same bundled → cached → remote ladder as the court list, with two differences.
It refreshes **on launch and on foreground** (at most hourly): iOS resumes a
suspended app without remounting, so launch alone lets a long-lived process
expire with the network right there. And an incoming payload must be **strictly
newer** than what's held — a CDN can serve a stale copy, and downgrading a live
snapshot to an expired one is the failure the whole path exists to prevent.

When a snapshot does outlive its window, `snapshotExpired()` says so on the card
("Booking data is out of date"). Absence and expiry are indistinguishable to every
other caller, and falling through to the generic reservable line read as "nothing
is booked" when the truth was "we no longer know".

The live per-card fetch only covers the **card**. Map marker rings, the Nearby
list's fully-booked badge and RunModal's court picker all read the snapshot, which
is why refreshing it is what makes the map agree with the card.

**NYC feeds the same `reserved` contract from two unrelated systems**
(`data/cities/nyc/reservations.js`), so one render path serves both cities — the
reservation UI keys off a court *having* `reserved`, not off a city feature flag.
An entry's `kind` distinguishes them, and the distinction is the whole point:

- `permit` — NYC Parks issues season permits to leagues, so the court is simply
  **taken**; you cannot book it. It gets its own vocabulary (`court.permitted*`),
  because telling someone to go reserve a permitted court would be wrong.
- `reserve` — the 8 tennis sites that really do take bookings.

Two shape differences follow from the source. Permit coverage is **sparse**, so
entries carry a `window`: inside it a missing slot is a genuine zero, outside it
is no data. And the payload is **run-length encoded** (`runs: [[start, end,
taken]]`), expanded by `data/cities/index.js` — permits are contiguous by nature,
so 37.8k slot keys / 921 KB of bundled JS become 5.3k runs / ~157 KB, losslessly.
Denominators come from the GIS court count for both halves, so the reading and
the card's court-count chip can't contradict each other.

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

**Check-ins are two different things** that meet on the court card. A **crowd
report** (`check_ins`) is anonymous, world-readable and says how busy a court+sport
is. An **"I'm here"** (`player_check_ins`) is identified, belongs to a user, feeds
the profile counters, and is a *location history* — so `017` scoped its reads to
your own rows plus accepted friends'. Both undo: tapping your crowd level again
removes it, and a check-in is taken back from the card's button or by swiping your
own row in the activity feed. Neither can recall a push that already fired, which
is why the copy says "tap to undo" and never that nobody saw it. A crowd report
silently logs an "I'm here" too, so undoing the report retracts that visit — but
only when the report created it (`via: 'crowd'` in the on-device mirror
`recreate.myvisits.v1`); when an explicit check-in came first the piggyback was
deduped away, so there is nothing to retract and no special case to write.

**The card counts both, which needs an aggregate rather than looser RLS.** Showing
"N check-ins in the last hour" community-wide can't come from reading rows —
that's exactly what `017` closed. `court_checkin_count()` (`025`) is a
SECURITY DEFINER **aggregate**: reading past RLS is safe precisely because it
returns a scalar — no user id, no per-visit timestamp, nothing attributable. Three
limits keep it from being walked back into a history: the window clamps to 24h, it
returns a number and never rows, and court **and** sport are both required so it
can't sweep the table. It's granted to `anon` as well as `authenticated` (the card
renders signed-out, and this is the class of fact the crowd reports already
publish), which is the opposite call from `send_push()`/`accepted_friend_ids()` —
those enable push spam and friend enumeration; a count enables neither. The card
runs both queries because they answer different questions — *who* (RLS rows it may
name) and *how many* (the aggregate) — and where they differ it says so ("+2 more
checked in here") rather than printing a heading that doesn't add up against its
own list. `countCourtVisits` returns **null, not 0**, when the RPC is missing, so a
database that hasn't run `025` falls back to what it can see instead of claiming an
empty court.

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
| `cities/nyc/outdoor-courts.js` | NYC Open Data (Socrata) | ~700 park pins via the config-driven `socrata-outdoor.js` adapter: sport flags, facility facts (lights/accessible/surface), amenity joins (water/restrooms), tennis permit reservable, sport attributes (full/half court, turf/grass, regulation pitch, adult field) |
| `cities/nyc/indoor-courts.js` | nycgovparks.org | rec-center weekly open-gym schedules (open-gym vs class classified by rules + Claude fallback) |
| `cities/nyc/classes.js` | nycgovparks events RSS + PerfectMind | free NYC Parks programs with real openings, full descriptions, multi-tag categories/themes, borough |
| `cities/nyc/reservations.js` | nycgovparks permit API + tennis pages | citywide field/court **permits** (one request returns every unavailable facility, so a 30-min sweep of 7 days is ~217 calls total) + the 8 online tennis grids; also carries the real **dusk** and floodlight times the hours model uses |
| `cities/nyc/directory.js` | NYC Parks `bigapps` feeds + nycpickleball.com | tennis surface/phone/notes, the **official pickleball page** (the only pass that may add a sport to a pin), and community colour (nets/BYON, open play, Slack/TeamReach) |
| `cities/nyc/pools.js` | NYC Parks pools pages + rec-center schedules | 79 free outdoor (one citywide schedule, season-aware) + 13 indoor weekly grids |

**Resilience pattern** (shared by every script via `scripts/lib/courts-common.js`):
each source falls back **live → cache (`scripts/*-cache.json`) → curated**, with a
validation gate that aborts the build (keeping old data) if too few records
scrape — so an upstream redesign fails loudly instead of publishing empty data.

**Select records by identity, never by heuristic**, and gate on *erosion* as well
as collapse. `build-reservations.js` learned both the expensive way. rec.us's
location list is global and alphabetical, and the build paged a hardcoded 80 pages
(2000 rows) — fine against the ~1.6k rows that existed when it was written, a
silent alphabetical cutoff once the list passed 3000. Eight SF Rec & Park venues
fell off the end over two weeks, a few at a time. Meanwhile venues were chosen by
bounding box plus a name regex for test facilities, and rec.us runs a **demo org
geocoded inside SF whose locations are named after real parks** ("Lincoln Park",
"Balboa Parkette"; one court is called `SortaLooksLikeSlots POC`). With the real
Rossi paged out, that fixture sat 470 ft away and the nearest-neighbour matcher
handed it Rossi's pin — shipping a POC court's availability, the demo org's
booking guidelines, and a reserve link to the wrong venue.

Both close the same way: page to the **end** of the list (`ceil(total/pageSize)`,
never a literal page number) and select on **`organizationId`**, which every list
row already carries (SFRP is `17380e28-…`; `/v1/organizations/<id>` resolves the
slug). An identity match can't be fooled by a name or a coordinate. The bounding
box survives only as a tripwire that warns instead of filtering.

The gates were the other half of the failure: a floor of 10 readings against ~37
was set to catch total collapse, so it never fired while a third of the data
drained away. Floors should sit near the real number, with a **relative** check
(>20% drop from the last good run) beside them, because erosion — not collapse —
is how a scraped source usually breaks.

**Multi-city:** `data/cities/index.js` aggregates the per-city modules into
`CITY_COURTS` / `CITY_CLASSES` / `CITY_RESERVATIONS`, merged into the app by
`lib/useCourts.js` / `App.js` and scoped to the active city (+ borough) from
`lib/cities.js`. Records carry a `city` field; SF ids are unchanged. Adding a
Socrata-portal city is config-only (`scripts/cities/<id>.js`); see `CLAUDE.md` →
*Multi-city*.

That aggregator is **not just a re-export** — it's where per-city data becomes
uniform records, so the app never learns a city's quirks: it expands the compact
`sports` array into `{schedule, dropins}`, applies NYC's per-weekday **dusk**
close and per-sport **floodlight** extensions, expands run-length-encoded
occupancy back into slot maps, and unions in sports the official directory adds.

**The join that makes the NYC builds cheap:** `socrata-outdoor.js` emits each
pin's park key (`key` = `gispropnum`), and every later NYC source keys off it —
the permit API's `system` ids and the `bigapps` feeds' `Prop_ID` are both that
same key, so those joins are exact rather than name- or distance-matched.

**Where a source is allowed to be truth.** Official sources may correct the data
(NYC Parks' pickleball page adds a sport to a pin, because pickleball is lined
onto tennis and handball slabs that GIS files under the original sport).
Community sources may only **colour** what an official source already
established, and their times never reach `dropins` — organized open play is
players agreeing to meet, not posted hours. Where two official sources disagree
(court counts differ on ~20% of parks), one is picked as canonical and the
difference is **logged**, never published as a second number.

**Class-title translation:** `build-classes.js` translates *new* distinct titles
to zh/es via Claude Haiku when `ANTHROPIC_API_KEY` is set, caching them in
`scripts/classes-i18n-cache.json` (so each refresh spends ~0 tokens). Without the
key it degrades to English — which means the CI key must be set for new titles to
localize automatically.

**Refresh crons** (`.github/workflows/`): `refresh-schedules.yml` runs the full
build weekly; `refresh-classes.yml` re-scrapes classes every 6h;
`refresh-reservations.yml` re-scrapes rec.us occupancy every 3h (bookings change
hourly); and `refresh-nyc-reservations.yml` re-sweeps NYC permits + tennis daily.
Each commits only when the generated data changed. When adding a new generated
file, also add it to the workflow's commit `FILES` list.

Each source is **its own workflow step**. `reportStale()` exits non-zero when a
build serves a cache past its staleness budget, and chaining the builds with `&&`
in one step meant the first stale source short-circuited every build behind it
and skipped the commit — discarding healthy sources' fresh data. Steps are
guarded `if: !cancelled() && ...` so a failure stops nothing but itself; the job
still reports failure, so the gate stays loud.

nycgovparks.org **405s GitHub's runner IPs by request origin**, so five of the six
NYC builds can never scrape live in CI. `scripts/refresh-nyc-local.sh` (daily
LaunchAgent, working in its own clone) scrapes from an unblocked machine and
pushes the refreshed caches; CI still 405s and still falls back, but now onto a
fresh cache, so `reportStale` stays quiet. A cache feeder, not a second pipeline —
and if it stops, the stale gate going red is the alert.

At launch, `useCourts.js` loads **bundled (instant) → cached → remote**
(`EXPO_PUBLIC_COURTS_URL`), so the app renders offline immediately then
revalidates.

---

## 7. The assistant (optional sidecar)

A natural-language layer over the same data, reachable from a ✨ launcher that
floats over every tab. It is **off unless self-hosted** — production ships with
`EXPO_PUBLIC_ASSISTANT_URL` unset and the launcher never renders.

**It is a separate process, not part of the app bundle.** The app talks to the
service; the service talks to a model. That split is the whole reason it exists
as a service: the provider key stays server-side and never reaches a phone.

### The rule that shapes it
**Retrieval is deterministic Python; the model never decides a fact.** It picks a
tool, fills its arguments, and phrases the result — so it cannot decide whether a
court is open, and therefore cannot invent an opening. Three consequences worth
preserving: payloads are projected narrow (a court's 3KB reserved-slots table
buried the hours next to it), result keys are named for the question they answer
(`percent_booked_at_asked_time`, not `percent_booked` — a well-named key beats a
system-prompt rule a small model obeys inconsistently), and a field that was never
recorded returns an explicit `UNKNOWN` rather than reading as "none".

### Layers
| Piece | Responsibility |
|---|---|
| `chatbot/retrieval.py` + `tools.py` | The seven tools — the only source of facts |
| `chatbot/timeutil.py` | Resolves `when="saturday"` to a moment in the city's tz, so the model does no calendar math |
| `chatbot/llm.py` | One provider seam over Ollama (local, free) and Anthropic |
| `chatbot/agent.py` | Tool-calling loop + guardrails (step ceiling, duplicate-call detection, truncation) |
| `chatbot/app.py` | `GET /health`, `POST /chat` — no state; the conversation lives in the client |
| `scripts/export-chatbot-data.js` | Bridges the app's generated `data/` into the service's snapshots |
| `lib/assistant.js` | The app's only link to it, gated on the URL env var |
| `components/AssistantHost.js` | The launcher + sheet; **owns the conversation** so it survives tab switches |

### Two seams worth knowing
**The export is the only place that knows how a court is assembled.** It
reproduces `useCourts.js`'s merge and then resolves each sport's week by calling
the app's *own* `lib/hours.js` (`resolveDropinWeek()` is exported for exactly
this) — otherwise the service would grow a second copy of the open-play carve-out
rules and the two would drift on first change.

**On-screen context rides the request, as pointers not facts.** `AssistantHost`
sits above the tab switch, so it can send what you're looking at (`screen`,
`court_id`, `sport`) — which is what makes a bare "is *it* open tomorrow?"
answerable. The court id tells the service what to look up; every hour and price
still comes from a tool. Like the timestamp, it's appended to the last user turn
rather than the system prompt, which is the cached prefix.

### Testing
`chatbot/` has **429 pytest tests** (tools, clock, loop, endpoints; time is frozen
so pinned dates stay valid). CI does not run them — `npm run check` gates the JS
app only. Run `cd chatbot && .venv/bin/python -m pytest -q` when touching it.

See [`chatbot/README.md`](chatbot/README.md) for setup, providers, and the
deployment caveats in §10.

---

## 8. Internationalization

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

## 9. Deploy

- **Native**: Expo / EAS build to iOS + Android. Push requires a dev/production
  build (Expo Go can't do remote push).
- **Web**: `npm run build:web` (`expo export --platform web` → `dist/`, then the
  `scripts/postbuild-web.js` SEO pass), a static SPA served by Vercel
  (`vercel.json`), rewriting all paths to `index.html` after real files. Set the
  three `EXPO_PUBLIC_*` vars in the Vercel dashboard. The web
  build can't do the ActiveNet live class fetch (CORS) and falls back to the
  bundled baseline — expected; native isn't bound by CORS. The rec.us live fetch
  *does* work on web (`api.rec.us` allows all origins).

- **Assistant**: not deployed. The web/native builds ship it inert (no
  `EXPO_PUBLIC_ASSISTANT_URL`), and `chatbot/` runs on a laptop for now. It is
  *ready* to be deployed — auth, rate limits and a daily budget exist and are
  configured by env (§10) — but two things must move with it: the App Store
  privacy label (`docs/privacy-nutrition-label.md`, enforced by `npm run check`)
  and a hosted model provider, since a local 8B model needs hardware a small VPS
  doesn't have.

All runtime config is `EXPO_PUBLIC_*` (inlined at build, client-safe — the
Supabase anon key is protected by RLS). `ANTHROPIC_API_KEY` is **not** an app var
and must never reach the client bundle: it's used by `build-classes.js` in
CI/local to translate titles, and by the `chatbot/` service, which holds its own
copy server-side.

---

## 10. Security model (summary)

- **Anon key is public by design** — RLS is the real boundary; every table has
  policies, and writes are scoped to `auth.uid()`.
- **Anonymous data** (crowd check-ins, reviews) has server-side per-IP rate limits
  as an abuse backstop.
- **SECURITY DEFINER functions** set `search_path` and are revoked from
  anon/authenticated unless they must be client-callable. Two are:
  `delete_account()` (acts solely on the caller) and `court_checkin_count()`,
  which is safe to expose *because it returns a scalar* — an aggregate is how you
  publish a number over private rows without unscoping the rows (see §5).
- **Verify RLS with the anon key, don't assume a migration took.** On 2026-08-23
  the anon key could read `player_check_ins` rows — the location history `017`
  exists to prevent — because `017` had never taken effect on the live database
  (`018` and `019` had, so nothing in the app's behaviour hinted at it). The app is
  always signed in, so it never sees what anon sees; one `curl` per table with the
  key from `.env` is the only check that does. Repaired by `026`, which also
  `enable`s RLS and re-asserts the write policies — re-running `017` alone would
  not necessarily have helped, since it only drops and creates policies and assumes
  RLS is already on, and with RLS off anonymous *writes* were accepted too.
- **No secrets in the repo** (`.env` gitignored); no `eval`/`dangerouslySetInnerHTML`;
  all network endpoints are HTTPS (so no iOS ATS exceptions needed).
- **The assistant defends money, not data** — it holds no user records, but every
  request costs a model call, so a shared bearer token, per-IP rate limits and a
  **global daily budget** (`chatbot/limits.py`) gate `/chat`. All default to
  permissive for localhost and log a warning at boot in that posture. The budget
  is the load-bearing one: per-IP limits can't stop a distributed caller. The
  client's token is inlined in the app bundle and therefore **not a secret** — it
  removes drive-by traffic and nothing more. No model provider key ever reaches
  the client; the service holds it, and it belongs in a dedicated Anthropic
  workspace with its own spend limit.
- **The assistant transmits coordinates without collecting them.**
  `lib/assistant.js` posts `lat`/`lng`; the service measures a distance and drops
  them — never persisted, never logged, and never sent to the model (results
  carry `miles_from_user`, and `origin` cannot be model-supplied). That is inside
  Apple's real-time-service exemption, so *Location: Not Collected* survives with
  the assistant on. Since it's a convention rather than a type, it is **enforced
  by tests** (`TestCoordinatesStayInsideTheRequest`, `TestRequestLogging`) — see
  `docs/privacy-nutrition-label.md`. Users' *questions* do reach the model
  provider, so `npm run check` requires the policy to disclose the assistant
  whenever an `eas.json` profile enables it.
