-- RECreate — social: chat. One messages table backs three kinds of threads:
--   • run     — group chat for a planned run (members = its participants)
--   • signal  — group chat for a "down to hoop" signal (members = its participants)
--   • direct  — 1:1 chat between two accepted friends
-- Depends on: 03_profiles.sql, 04_runs.sql, 05_friends.sql, 06_signals.sql,
-- 07_push.sql (send_push). The push trigger at the bottom also reads
-- blocked_users (10_moderation.sql) — plpgsql resolves it at call time, so run
-- the files in order before any message is sent.
--
-- Membership is *derived*, not stored: access to a run/signal chat is exactly the
-- run/signal's participant rows, so joining a run (which inserts a participant)
-- automatically grants its group chat — no extra table or trigger needed. A
-- direct thread is keyed by the two user ids sorted + joined ("least:greatest").

create table if not exists public.chat_messages (
  id         uuid        primary key default gen_random_uuid(),
  run_id     uuid        references public.rec_runs (id)    on delete cascade,
  signal_id  uuid        references public.rec_signals (id) on delete cascade,
  direct_key text,                                            -- 'uuidA:uuidB' (sorted) for 1:1
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  body       text        not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now(),
  -- exactly one thread target
  constraint chat_messages_one_target check (num_nonnulls(run_id, signal_id, direct_key) = 1)
);

create index if not exists chat_messages_run_idx    on public.chat_messages (run_id, created_at);
create index if not exists chat_messages_signal_idx on public.chat_messages (signal_id, created_at);
create index if not exists chat_messages_direct_idx on public.chat_messages (direct_key, created_at);

alter table public.chat_messages enable row level security;

-- Helpers: am I a member of this thread?
-- (Run/signal membership = a participant row; direct = one of the two ids.)
-- Read: any thread you belong to.
create policy "read messages in your threads"
  on public.chat_messages for select
  using (
    (run_id is not null and exists (
      select 1 from public.rec_run_participants p
      where p.run_id = chat_messages.run_id and p.user_id = auth.uid()
    ))
    or (signal_id is not null and exists (
      select 1 from public.rec_signal_participants p
      where p.signal_id = chat_messages.signal_id and p.user_id = auth.uid()
    ))
    or (direct_key is not null and (
      split_part(direct_key, ':', 1) = auth.uid()::text
      or split_part(direct_key, ':', 2) = auth.uid()::text
    ))
  );

-- Send: as yourself, into a thread you belong to. Direct chats additionally
-- require the two of you to be accepted friends.
create policy "send messages to your threads"
  on public.chat_messages for insert
  with check (
    user_id = auth.uid()
    and (
      (run_id is not null and exists (
        select 1 from public.rec_run_participants p
        where p.run_id = chat_messages.run_id and p.user_id = auth.uid()
      ))
      or (signal_id is not null and exists (
        select 1 from public.rec_signal_participants p
        where p.signal_id = chat_messages.signal_id and p.user_id = auth.uid()
      ))
      or (direct_key is not null
        and (split_part(direct_key, ':', 1) = auth.uid()::text
             or split_part(direct_key, ':', 2) = auth.uid()::text)
        and exists (
          select 1 from public.friendships f
          where f.status = 'accepted'
            and (
              (f.requester::text = split_part(direct_key, ':', 1) and f.addressee::text = split_part(direct_key, ':', 2))
              or (f.requester::text = split_part(direct_key, ':', 2) and f.addressee::text = split_part(direct_key, ':', 1))
            )
        )
      )
    )
  );

-- You can delete your own messages.
create policy "delete your own messages"
  on public.chat_messages for delete using (user_id = auth.uid());

-- Real-time so open threads update live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Push on new messages (031): coalesced per recipient per thread, skips muted
-- threads and blocked senders.
-- ---------------------------------------------------------------------------

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
