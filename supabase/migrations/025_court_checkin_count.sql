-- Community count of "I'm here" check-ins at one court + sport, WITHOUT
-- reopening what 017 closed.
--
-- 017 scoped player_check_ins reads to your own rows plus accepted friends',
-- because the world-readable policy it replaced let any caller — anon included,
-- whose key ships inside the app bundle — dump a location history keyed to user
-- id. That is still the right call for ROWS. But the court card wants a NUMBER
-- ("3 check-ins in the last hour"), and a number names nobody: no user id, no
-- per-visit timestamp, no way to attribute a visit to a person. So this is a
-- SECURITY DEFINER aggregate that reads past RLS and can only ever return a
-- count. The named rows the card lists ("You", "Sam") still come through RLS,
-- so you see WHO only among your own friends.
--
-- Three limits keep "just an aggregate" from being walked back into a history:
--   · the window is clamped to 24h, so it can't build an all-time per-court
--     popularity dataset, and can't be aimed at a specific day in the past;
--   · it returns a scalar, never rows;
--   · court AND sport are required, so it can't be swept over the whole table.

create or replace function public.court_checkin_count(
  p_court_id text,
  p_sport    text,
  p_minutes  int default 60
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.player_check_ins
  where court_id = p_court_id
    and sport = p_sport
    and created_at >= now()
      - make_interval(mins => least(greatest(coalesce(p_minutes, 60), 1), 1440));
$$;

-- Readable by everyone the card renders for, signed in or not — the count is the
-- same class of fact the anonymous crowd reports already publish. Unlike
-- send_push()/accepted_friend_ids() (revoked in 011), there is nothing here a
-- client can abuse: no rows, no identities, no writes.
revoke all on function public.court_checkin_count(text, text, int) from public;
grant execute on function public.court_checkin_count(text, text, int) to anon, authenticated;

-- The card asks per court+sport on every open; the existing index is keyed by
-- user, which this access path can't use.
create index if not exists player_check_ins_court_idx
  on public.player_check_ins (court_id, sport, created_at desc);
