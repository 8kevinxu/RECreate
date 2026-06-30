-- RECreate — push notifications. A device registers its Expo push token here;
-- triggers on runs / signals / friendships send pushes to the relevant users'
-- tokens via Expo's push API, called straight from Postgres with pg_net (no Edge
-- Function). Depends on: every section above (it references all of those tables).

create extension if not exists pg_net;

-- One row per device (Expo push token), owned by the signed-in user. The token
-- is the PK so re-registering the same device just re-points it at the user.
create table if not exists public.device_tokens (
  token      text        primary key,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  platform   text,
  updated_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on public.device_tokens (user_id);

alter table public.device_tokens enable row level security;

-- Users manage only their own device tokens.
create policy "see your device tokens"
  on public.device_tokens for select using (user_id = auth.uid());
create policy "register your device token"
  on public.device_tokens for insert with check (user_id = auth.uid());
create policy "update your device token"
  on public.device_tokens for update using (user_id = auth.uid());
create policy "remove your device token"
  on public.device_tokens for delete using (user_id = auth.uid());

-- Accepted friends of `uid` (the other side of each accepted friendship).
create or replace function public.accepted_friend_ids(uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when f.requester = uid then f.addressee else f.requester end
  from public.friendships f
  where f.status = 'accepted'
    and (f.requester = uid or f.addressee = uid);
$$;

-- Fire-and-forget Expo push to a set of users (all their registered devices).
-- Silently does nothing when there are no recipients or no tokens.
create or replace function public.send_push(
  recipient_ids uuid[],
  title text,
  body text,
  data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tokens text[];
begin
  if recipient_ids is null or array_length(recipient_ids, 1) is null then
    return;
  end if;

  select array_agg(distinct dt.token) into tokens
  from public.device_tokens dt
  where dt.user_id = any (recipient_ids);

  if tokens is null or array_length(tokens, 1) is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'to', to_jsonb(tokens),
      'title', title,
      'body', body,
      'data', coalesce(data, '{}'::jsonb),
      'sound', 'default'
    )
  );
end;
$$;

-- A friend posts a "down to hoop" signal → notify their accepted friends.
create or replace function public.notify_signal()
returns trigger language plpgsql security definer set search_path = public as $$
declare host_name text; recipients uuid[];
begin
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
drop trigger if exists rec_signals_notify on public.rec_signals;
create trigger rec_signals_notify after insert on public.rec_signals
  for each row execute function public.notify_signal();

-- A friend plans a game → notify their accepted friends (public + friends-only;
-- public plans are visible to friends too).
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
drop trigger if exists rec_runs_notify on public.rec_runs;
create trigger rec_runs_notify after insert on public.rec_runs
  for each row execute function public.notify_run();

-- Someone joins your run → notify the host. Skips the host's own auto-join row.
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
drop trigger if exists rec_run_participants_notify on public.rec_run_participants;
create trigger rec_run_participants_notify after insert on public.rec_run_participants
  for each row execute function public.notify_run_join();

-- Someone joins your session → notify the host. Skips the poster's auto-join.
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
drop trigger if exists rec_signal_participants_notify on public.rec_signal_participants;
create trigger rec_signal_participants_notify after insert on public.rec_signal_participants
  for each row execute function public.notify_signal_join();

-- Host confirms a session's court + time → notify the other participants.
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
drop trigger if exists rec_signals_confirm_notify on public.rec_signals;
create trigger rec_signals_confirm_notify after update on public.rec_signals
  for each row execute function public.notify_session_confirmed();

-- Your friend request is accepted → notify the requester. The accepter is the
-- addressee (they received and accepted the request).
create or replace function public.notify_friend_accepted()
returns trigger language plpgsql security definer set search_path = public as $$
declare accepter_name text;
begin
  if new.status <> 'accepted' or new.status is not distinct from old.status then
    return new;
  end if;
  select display_name into accepter_name from public.profiles where id = new.addressee;
  perform public.send_push(
    array[new.requester],
    coalesce(accepter_name, 'Someone') || ' accepted your friend request 🤝',
    'You''re now friends on RECreate',
    jsonb_build_object('type', 'friend')
  );
  return new;
end; $$;
drop trigger if exists friendships_accept_notify on public.friendships;
create trigger friendships_accept_notify after update on public.friendships
  for each row execute function public.notify_friend_accepted();
