-- Migration: let planned games use any tracked sport (was basketball/volleyball
-- only) and generalize the planning push to all sports' emoji + wording.
-- Apply once to an existing database in the Supabase SQL editor. Idempotent.
-- New databases get this from schema/04_runs.sql + schema/07_push.sql.

-- 1) Widen the hoop_runs.sport check to every sport in lib/sports.js.
alter table public.hoop_runs drop constraint if exists hoop_runs_sport_check;
alter table public.hoop_runs
  add constraint hoop_runs_sport_check
  check (sport in ('basketball', 'volleyball', 'pingpong', 'pickleball', 'tennis'));

-- 2) Generalize the "friend planned a game" push (emoji per sport + wording).
create or replace function public.notify_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_name text; recipients uuid[]; sport_emoji text;
begin
  select display_name into host_name from public.profiles where id = new.host;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(new.host) as fid;
  sport_emoji := case new.sport
    when 'volleyball' then '🏐'
    when 'pingpong'   then '🏓'
    when 'pickleball' then '🥒'
    when 'tennis'     then '🎾'
    else '🏀' end;
  perform public.send_push(
    recipients,
    coalesce(host_name, 'A friend') || ' planned a game ' || sport_emoji,
    coalesce(nullif(new.note, ''), 'Tap to see the plan and join'),
    jsonb_build_object('type', 'run', 'runId', new.id, 'courtId', new.court_id)
  );
  return new;
end; $$;
