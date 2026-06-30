-- Rebrand HoopMap → RECreate. Renames the four social tables from the `hoop_`
-- prefix to `rec_`. Idempotent: each rename is guarded so re-running is a no-op.
--
-- Renaming a table automatically carries its indexes, constraints, RLS policies,
-- foreign keys, triggers, and realtime-publication membership. What does NOT move
-- is SQL *inside* function bodies that names a table by string — those resolve at
-- call time, so we recreate the five SECURITY DEFINER functions that reference a
-- renamed table. (Index/trigger/constraint object names keep their old `hoop_`
-- spelling on an existing DB — cosmetic only; fresh DBs from schema/ are fully
-- `rec_`.)

-- 1. Rename the tables.
alter table if exists public.hoop_runs                rename to rec_runs;
alter table if exists public.hoop_run_participants    rename to rec_run_participants;
alter table if exists public.hoop_signals             rename to rec_signals;
alter table if exists public.hoop_signal_participants rename to rec_signal_participants;

-- 2. Recreate the functions whose bodies name a renamed table.

create or replace function public.add_host_as_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.rec_run_participants (run_id, user_id)
  values (new.id, new.host)
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.add_poster_as_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.rec_signal_participants (signal_id, user_id)
  values (new.id, new.user_id)
  on conflict do nothing;
  return new;
end;
$$;

create or replace function public.notify_run_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_id uuid; court text; joiner_name text;
begin
  select host, court_id into host_id, court from public.rec_runs where id = new.run_id;
  if host_id is null or host_id = new.user_id then
    return new;
  end if;
  select display_name into joiner_name from public.profiles where id = new.user_id;
  perform public.send_push(
    array[host_id],
    coalesce(joiner_name, 'Someone') || ' is in for your game 🏀',
    'Tap to see who''s going',
    jsonb_build_object('type', 'run', 'runId', new.run_id, 'courtId', court)
  );
  return new;
end; $$;

create or replace function public.notify_signal_join()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_id uuid; joiner_name text;
begin
  select user_id into host_id from public.rec_signals where id = new.signal_id;
  if host_id is null or host_id = new.user_id then
    return new;
  end if;
  select display_name into joiner_name from public.profiles where id = new.user_id;
  perform public.send_push(
    array[host_id],
    coalesce(joiner_name, 'Someone') || ' is in 🤙',
    'They joined your session',
    jsonb_build_object('type', 'signal', 'signalId', new.signal_id)
  );
  return new;
end; $$;

create or replace function public.notify_session_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
declare recipients uuid[];
begin
  if new.planned_at is null or new.planned_at is not distinct from old.planned_at then
    return new;
  end if;
  select array_agg(user_id) into recipients
  from public.rec_signal_participants
  where signal_id = new.id and user_id <> new.user_id;
  perform public.send_push(
    recipients,
    'Session confirmed 🗓️',
    'The host locked in a time — tap for details',
    jsonb_build_object('type', 'signal', 'signalId', new.id)
  );
  return new;
end; $$;
