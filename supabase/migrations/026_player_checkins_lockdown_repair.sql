-- URGENT: re-assert the player_check_ins lockdown from 017, which is NOT in
-- effect on the live database.
--
-- Verified 2026-08-23 against production with the ANON key — the one that ships
-- inside the web bundle and the app binary, readable by anyone who opens
-- devtools:
--
--   GET /rest/v1/player_check_ins?select=user_id,court_id
--   → [{"user_id":"6ba75b3a-…","court_id":"palega-recreation-center"}, …]
--
-- That is exactly what 017 exists to prevent: "which courts they visit and when,
-- a location history keyed to user id". 018 (profiles) and 019 (run participants)
-- both answered [] on the same database, so this was isolated to 017 rather than
-- a general run of missed migrations.
--
-- Two things could produce that read, and this fixes both, idempotently:
--   · the old world-readable policy is still present — SELECT policies are OR'd,
--     so a single `using (true)` defeats the friends-only pair beside it; or
--   · row level security was never enabled on the table, which makes every policy
--     moot. This is why re-running 017 alone would not necessarily help: it only
--     drops and creates policies, and assumes RLS is already on.
--
-- Safe whether or not 017 ever took. Dropping and recreating a SELECT policy only
-- ever narrows access in the gap, never widens it.

alter table public.player_check_ins enable row level security;

drop policy if exists "player check-ins are readable by everyone" on public.player_check_ins;
drop policy if exists "users read their own check-ins"            on public.player_check_ins;
drop policy if exists "friends can see friends' check-ins"        on public.player_check_ins;

create policy "users read their own check-ins"
  on public.player_check_ins for select using (auth.uid() = user_id);

create policy "friends can see friends' check-ins"
  on public.player_check_ins for select
  using (
    exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = player_check_ins.user_id)
          or (f.addressee = auth.uid() and f.requester = player_check_ins.user_id)
        )
    )
  );

-- Writes stay owner-only (03_profiles.sql). Re-asserted here because a table with
-- RLS disabled accepted anonymous INSERT and DELETE too, and if that was the
-- cause, the policies below are what start enforcing it again.
drop policy if exists "users log their own check-ins"    on public.player_check_ins;
drop policy if exists "users delete their own check-ins" on public.player_check_ins;

create policy "users log their own check-ins"
  on public.player_check_ins for insert with check (auth.uid() = user_id);

create policy "users delete their own check-ins"
  on public.player_check_ins for delete using (auth.uid() = user_id);

-- After running, confirm with the anon key — this must return []:
--   curl "$URL/rest/v1/player_check_ins?select=user_id&limit=1" \
--     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
