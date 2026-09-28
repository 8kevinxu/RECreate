-- Push a notification when a chat message arrives. Until now nothing did: the
-- 07_push.sql triggers cover runs, signals, joins and friend requests, but no
-- trigger watched chat_messages, so run chats, signal chats and 1:1 messages
-- were silent unless the app was open. A group chat nobody hears about loses to
-- a group text, which is the thing Groups (docs/groups-phase1.md) replaces.
--
-- One trigger for every thread kind. Recipients are the thread's members minus
-- the sender, minus anyone who muted the thread, minus anyone who blocked the
-- sender. Pushes are coalesced per recipient per thread so a burst of messages
-- is one buzz, not ten: 5 minutes for run/signal group chats, 30 seconds for
-- 1:1 (a back-and-forth where every other reply went silent would read as
-- broken). The window runs from the last push, not the last message.
--
-- Apply once to an existing database in the Supabase SQL editor. Idempotent.
-- Folded into schema/08_chat.sql. Depends on 07 (send_push) and 10
-- (blocked_users).

-- Muting is server-side because the push is. Keyed by the same thread key the
-- client already uses (lib/chat.js keyOf): 'run:<id>' | 'signal:<id>' |
-- 'direct:<a:b>'. Owner-only, like device_tokens.
create table if not exists public.chat_mutes (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  thread_key text        not null check (char_length(thread_key) <= 200),
  created_at timestamptz not null default now(),
  primary key (user_id, thread_key)
);
alter table public.chat_mutes enable row level security;

drop policy if exists "see your chat mutes" on public.chat_mutes;
drop policy if exists "mute a chat" on public.chat_mutes;
drop policy if exists "unmute a chat" on public.chat_mutes;
create policy "see your chat mutes"
  on public.chat_mutes for select using (user_id = auth.uid());
create policy "mute a chat"
  on public.chat_mutes for insert with check (user_id = auth.uid());
create policy "unmute a chat"
  on public.chat_mutes for delete using (user_id = auth.uid());

-- Last push per recipient per thread. No policies: clients get no access; only
-- the SECURITY DEFINER trigger (owner) reads and writes it — the
-- crowd_notify_log pattern (014).
create table if not exists public.chat_notify_log (
  recipient_id uuid        not null references public.profiles (id) on delete cascade,
  thread_key   text        not null,
  sent_at      timestamptz not null default now(),
  primary key (recipient_id, thread_key)
);
alter table public.chat_notify_log enable row level security;

create or replace function public.notify_chat_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  thread     text;
  members    uuid[];
  recipients uuid[];
  cooldown   interval;
  sender     text;
  title      text;
  preview    text;
begin
  if new.run_id is not null then
    -- A cancelled run's chat is dead; don't wake anyone for it.
    if exists (select 1 from public.rec_runs where id = new.run_id and status = 'cancelled') then
      return new;
    end if;
    thread := 'run:' || new.run_id;
    cooldown := interval '5 minutes';
    select array_agg(user_id) into members
      from public.rec_run_participants where run_id = new.run_id;
  elsif new.signal_id is not null then
    thread := 'signal:' || new.signal_id;
    cooldown := interval '5 minutes';
    select array_agg(user_id) into members
      from public.rec_signal_participants where signal_id = new.signal_id;
  else
    thread := 'direct:' || new.direct_key;
    cooldown := interval '30 seconds';
    members := array[split_part(new.direct_key, ':', 1)::uuid,
                     split_part(new.direct_key, ':', 2)::uuid];
  end if;

  select array_agg(m) into recipients
  from unnest(members) as m
  where m <> new.user_id
    and not exists (select 1 from public.chat_mutes cm
                    where cm.user_id = m and cm.thread_key = thread)
    and not exists (select 1 from public.blocked_users b
                    where b.blocker_id = m and b.blocked_id = new.user_id)
    and not exists (select 1 from public.chat_notify_log l
                    where l.recipient_id = m and l.thread_key = thread
                      and l.sent_at > now() - cooldown);

  if recipients is null then return new; end if;

  insert into public.chat_notify_log (recipient_id, thread_key, sent_at)
    select r, thread, now() from unnest(recipients) as r
    on conflict (recipient_id, thread_key) do update set sent_at = excluded.sent_at;

  select display_name into sender from public.profiles where id = new.user_id;
  sender := coalesce(sender, 'Someone');
  title := case
    when new.run_id is not null    then sender || ' · game chat 📅'
    when new.signal_id is not null then sender || ' · session chat 🤙'
    else sender
  end;
  preview := case when char_length(new.body) > 140
                  then left(new.body, 139) || '…' else new.body end;

  perform public.send_push(
    recipients, title, preview,
    jsonb_build_object('type', 'chat', 'thread', thread)
  );
  return new;
-- A push is a courtesy; the message is the point. Nothing here may fail the
-- insert (the 028 report-email trigger takes the same stance).
exception when others then
  raise warning 'notify_chat_message: %', sqlerrm;
  return new;
end; $$;

drop trigger if exists chat_messages_notify on public.chat_messages;
create trigger chat_messages_notify after insert on public.chat_messages
  for each row execute function public.notify_chat_message();
