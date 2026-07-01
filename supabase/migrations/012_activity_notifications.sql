-- RECreate — friend activity notifications + a visibility setting.
-- Adds a per-user "share_activity" toggle and a per-row "notify" flag on the four
-- broadcastable actions (crowd vote, check-in, signal, run). The client sets
-- `notify` from the user's share_activity setting (or a per-action prompt when
-- it's off); triggers only push when the flag is set. Signals/runs already had
-- notify triggers — they're now gated on the flag too (previously always fired).
-- Safe to run against an existing DB.

-- 1. Columns -----------------------------------------------------------------
alter table public.profiles          add column if not exists share_activity boolean not null default true;
alter table public.check_ins         add column if not exists notify boolean not null default false;
alter table public.player_check_ins  add column if not exists notify boolean not null default false;
alter table public.rec_runs          add column if not exists notify boolean not null default false;
alter table public.rec_signals       add column if not exists notify boolean not null default false;

-- 2. Gate the existing signal/run broadcast triggers on the flag --------------
create or replace function public.notify_signal()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_name text; recipients uuid[];
begin
  if not new.notify then return new; end if;
  select display_name into host_name from public.profiles where id = new.user_id;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(new.user_id) as fid;
  perform public.send_push(
    recipients,
    coalesce(host_name, 'A friend') || ' is down to hoop 🏀',
    coalesce(nullif(new.note, ''),
      case when new.starts_at is null then 'Down to play right now'
           else 'Down to play soon' end),
    jsonb_build_object('type', 'signal', 'signalId', new.id)
  );
  return new;
end; $$;

create or replace function public.notify_run()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_name text; recipients uuid[]; sport_emoji text;
begin
  if not new.notify then return new; end if;
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

-- 3. New broadcast triggers: check-in + crowd vote ---------------------------
create or replace function public.notify_player_checkin()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text; recipients uuid[];
begin
  if not new.notify then return new; end if;
  select display_name into who from public.profiles where id = new.user_id;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(new.user_id) as fid;
  perform public.send_push(
    recipients,
    coalesce(who, 'A friend') || ' checked in 📍',
    'Tap to see where they''re playing',
    jsonb_build_object('type', 'checkin', 'courtId', new.court_id)
  );
  return new;
end; $$;
drop trigger if exists player_check_ins_notify on public.player_check_ins;
create trigger player_check_ins_notify after insert on public.player_check_ins
  for each row execute function public.notify_player_checkin();

create or replace function public.notify_crowd()
returns trigger language plpgsql security definer set search_path = public as $$
declare voter uuid; who text; recipients uuid[]; level_word text;
begin
  voter := auth.uid();
  if not new.notify or voter is null then return new; end if;
  select display_name into who from public.profiles where id = voter;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(voter) as fid;
  level_word := case new.level
    when 'empty'    then 'wide open 🟢'
    when 'moderate' then 'moderately busy 🟡'
    else                 'packed 🔴' end;
  perform public.send_push(
    recipients,
    coalesce(who, 'A friend') || ' shared a crowd update 👀',
    'A court looks ' || level_word || ' — tap to see',
    jsonb_build_object('type', 'crowd', 'courtId', new.court_id)
  );
  return new;
end; $$;
drop trigger if exists check_ins_notify on public.check_ins;
create trigger check_ins_notify after insert on public.check_ins
  for each row execute function public.notify_crowd();
