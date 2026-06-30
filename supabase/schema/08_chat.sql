-- RECreate — social: chat. One messages table backs three kinds of threads:
--   • run     — group chat for a planned run (members = its participants)
--   • signal  — group chat for a "down to hoop" signal (members = its participants)
--   • direct  — 1:1 chat between two accepted friends
-- Depends on: 03_profiles.sql, 04_runs.sql, 05_friends.sql, 06_signals.sql.
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
