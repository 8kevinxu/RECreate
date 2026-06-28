-- Migration: give planned runs a sport (basketball | volleyball).
-- Apply once to an existing database by pasting into the Supabase SQL editor.
-- Idempotent — safe to re-run. New databases get this from schema/04_runs.sql.

-- 1) Add the column. Existing rows backfill to 'basketball'.
alter table public.hoop_runs
  add column if not exists sport text not null default 'basketball'
  check (sport in ('basketball', 'volleyball'));

-- 2) Make the "friend planned a run" push reflect the sport's emoji.
create or replace function public.notify_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_name text; recipients uuid[]; sport_emoji text;
begin
  select display_name into host_name from public.profiles where id = new.host;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(new.host) as fid;
  sport_emoji := case new.sport when 'volleyball' then '🏐' else '🏀' end;
  perform public.send_push(
    recipients,
    coalesce(host_name, 'A friend') || ' planned a run ' || sport_emoji,
    coalesce(nullif(new.note, ''), 'Tap to see the run and join'),
    jsonb_build_object('type', 'run', 'runId', new.id, 'courtId', new.court_id)
  );
  return new;
end; $$;
