-- RECreate — social: "down to hoop" signals (location-less availability pings to
-- friends). A signal with no starts_at means "right now"; with starts_at it's "at
-- a time, no place yet". Friends can join, suggest a time/court, and the host
-- confirms one (planned_at / planned_court_id). Friends-only via RLS, auto-expiring.
-- Depends on: 03_profiles.sql, 05_friends.sql (the SELECT policy is friend-scoped).

create table if not exists public.rec_signals (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references public.profiles (id) on delete cascade,
  starts_at        timestamptz,                                   -- null = "right now"
  sport            text        not null default 'basketball',     -- tracked sport id (see lib/sports.js)
  note             text        check (note is null or char_length(note) <= 200),
  place            text,                                          -- creator's 'indoor' | 'outdoor' pref (null = either)
  pref_court_id    text,                                          -- creator's preferred court (matches data/courts.js ids; null = anywhere)
  planned_at       timestamptz,                                   -- host-confirmed time (null until confirmed)
  planned_court_id text,                                          -- host-confirmed court (matches data/courts.js ids)
  notify           boolean     not null default false,            -- notify friends on post (gated by share_activity; see 07_push.sql)
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null                          -- set by the client
);

create index if not exists rec_signals_expires_idx on public.rec_signals (expires_at);
create index if not exists rec_signals_user_idx on public.rec_signals (user_id);

alter table public.rec_signals enable row level security;

-- You can see your own signals and those of accepted friends.
create policy "see your own and friends' signals"
  on public.rec_signals for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = rec_signals.user_id)
          or (f.addressee = auth.uid() and f.requester = rec_signals.user_id)
        )
    )
  );

create policy "post your own signal"
  on public.rec_signals for insert with check (user_id = auth.uid());

create policy "cancel your own signal"
  on public.rec_signals for delete using (user_id = auth.uid());

-- Host can confirm/clear the session time + court (set planned_at / planned_court_id).
create policy "host can update their signal"
  on public.rec_signals for update using (user_id = auth.uid());

create table if not exists public.rec_signal_participants (
  signal_id         uuid        not null references public.rec_signals (id) on delete cascade,
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  proposed_at       timestamptz,                                  -- optional "I suggest this time"
  proposed_court_id text,                                         -- optional "I suggest this court"
  proposed_sport    text,                                         -- optional "I suggest this sport/activity"
  created_at        timestamptz not null default now(),
  primary key (signal_id, user_id)
);

alter table public.rec_signal_participants enable row level security;

-- You can see participants of any signal you're allowed to see (RLS on
-- rec_signals applies inside this subquery, so it's friend-scoped).
create policy "see participants of visible signals"
  on public.rec_signal_participants for select
  using (exists (select 1 from public.rec_signals s where s.id = signal_id));

create policy "join visible signals as yourself"
  on public.rec_signal_participants for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.rec_signals s where s.id = signal_id)
  );

create policy "update your own participation"
  on public.rec_signal_participants for update using (user_id = auth.uid());

create policy "leave (delete your own row)"
  on public.rec_signal_participants for delete using (user_id = auth.uid());

-- Auto-add the poster as a participant when a signal is created.
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

drop trigger if exists rec_signals_add_poster_trg on public.rec_signals;
create trigger rec_signals_add_poster_trg
  after insert on public.rec_signals
  for each row execute function public.add_poster_as_participant();

-- Real-time so friends' signals + joins appear live (the in-app "notification").
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rec_signals'
  ) then
    alter publication supabase_realtime add table public.rec_signals;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rec_signal_participants'
  ) then
    alter publication supabase_realtime add table public.rec_signal_participants;
  end if;
end $$;
