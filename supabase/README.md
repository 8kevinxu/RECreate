# Supabase setup

The backend for RECreate's shared/social features (crowd check-ins, reviews,
accounts, runs, friends, "down to hoop" signals, and push). Everything is
optional — the app runs fully signed-out without any of this; configure it only
to enable the shared + social features.

## Layout

```
schema/      Canonical, current-state DDL — split by domain, numbered for run order.
migrations/  Ordered deltas to bring an EXISTING database up to the latest schema.
```

## Fresh project

In the Supabase dashboard → **SQL Editor**, run the `schema/` files **in numeric
order** (01 → 10). Order matters: later domains reference earlier tables
(e.g. runs/friends/signals depend on profiles; push depends on all of them).

| File | What it adds | Depends on |
|------|--------------|------------|
| `01_crowd_check_ins.sql` | Anonymous crowd-level check-ins + rate limit | — |
| `02_reviews.sql` | Per-court text reviews + rate limit | — |
| `03_profiles.sql` | Accounts: profiles, friend codes, personal check-ins | auth |
| `04_runs.sql` | "Plan a run" scheduled games | 03 |
| `05_friends.sql` | Friend requests + friends-only run visibility | 03, 04 |
| `06_signals.sql` | "Down to hoop" availability signals | 03, 05 |
| `07_push.sql` | Expo push tokens + notification triggers | all above |
| `08_chat.sql` | Chat: run/signal group chats + 1:1 friend DMs | 03, 04, 05, 06 |
| `09_account_deletion.sql` | `delete_account()` RPC (Settings → Delete account) | 03 |
| `10_moderation.sql` | Trust & safety: user blocking + content reports | 03 |

To run them all at once, concatenate in order:

```bash
cat supabase/schema/*.sql | pbcopy   # paste into the SQL editor
```

The files use plain `create policy` (not idempotent), so run each **once** on a
fresh project. `create table`/`index` and realtime additions are guarded.

Then enable email auth: **Authentication → Providers → Email** (on by default).
Turn **off "Confirm email"** for local testing; keep it **on** in production.

## Existing database

Don't re-run the `schema/` files on a project that already has the older schema.
Instead apply the `migrations/` in order — each is idempotent and only adds what's
new:

| Migration | Brings in |
|-----------|-----------|
| `001_add_run_sport.sql` | `hoop_runs.sport` + sport-aware planning push |
| `002_add_player_profiles.sql` | `profiles.age/bio/favorite_sports` + `player_check_ins` |
| `003_generalize_run_sports.sql` | Widen `hoop_runs.sport` to all sports + per-sport push emoji |
| `004_add_neighborhood.sql` | `profiles.neighborhood` |
| `005_account_deletion.sql` | `delete_account()` RPC |
| `006_signal_sport.sql` | `hoop_signals.sport` |
| `007_moderation.sql` | `blocked_users` + `content_reports` (block / report) |
| `008_add_interests.sql` | `profiles.favorite_categories` (class-category interests) |
| `009_signal_proposed_sport.sql` | `hoop_signal_participants.proposed_sport` (suggest an activity) |
| `010_rename_to_recreate.sql` | Rebrand: rename `hoop_*` tables → `rec_*` (+ recreate dependent functions) |
| `011_lock_down_push_functions.sql` | SECURITY: revoke client EXECUTE on `send_push()` / `accepted_friend_ids()` |
| `012_activity_notifications.sql` | `profiles.share_activity` + per-row `notify` flag; gate signal/run push + add check-in/crowd-vote push |
| `013_push_per_token.sql` | `send_push()` sends one Expo request per token (mixed-project batches 400) |
| `014_crowd_notify_cooldown.sql` | `crowd_notify_log`: rate-limit crowd-update push to 1 per voter+court per 10 min |
| `015_signal_place_court.sql` | `rec_signals.place` + `pref_court_id` (optional location on a signal) |
| `016_reviews_require_auth.sql` | SECURITY: posting a review requires a signed-in account |
| `017_player_checkins_friends_only.sql` | PRIVACY: `player_check_ins` reads scoped to own + accepted friends (was world-readable) |
| `018_profiles_require_auth.sql` | PRIVACY: `profiles` reads require a signed-in user (anon could dump age/bio/neighborhood) |
| `019_run_participants_visibility.sql` | PRIVACY: `rec_run_participants` reads scoped to own rows + rosters of visible runs (was world-readable) |
| `020_length_caps.sql` | T&S: length `CHECK`s on unconstrained user-supplied text (court/sport/place ids, profile interest arrays) |
| `021_friend_request_push.sql` | Push when a friend request arrives (not just when it's accepted) |
| `022_report_runs.sql` | T&S: allow `content_reports.kind = 'run'` (report a planned run from the feed) |
| `023_report_data_issues.sql` | Allow `content_reports.kind` `'data'` ("looks wrong" flags on court/class/pool cards) + `'issue'` (free-text "Report a problem" in Settings) |

> Note: migrations 001–009 were authored before the RECreate rebrand and still
> reference the old `hoop_*` table names. Apply them **in order** — `010` renames
> the tables at the end, so the earlier deltas line up. A fresh DB built from
> `schema/` is already fully `rec_*` and skips all of this.
