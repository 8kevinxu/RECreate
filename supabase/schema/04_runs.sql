-- HoopMap — social: "plan a run" (scheduled pickup games at a court).
-- Depends on: 03_profiles.sql. Visibility is 'public' or 'friends'; the
-- friends-only SELECT policy lives in 05_friends.sql (it needs the friendships
-- table). The host is auto-added as the first participant.

create table if not exists public.hoop_runs (
  id          uuid        primary key default gen_random_uuid(),
  host        uuid        not null references public.profiles (id) on delete cascade,
  court_id    text        not null,
  starts_at   timestamptz not null,
  sport       text        not null default 'basketball' check (sport in ('basketball', 'volleyball')),
  note        text        check (note is null or char_length(note) <= 200),
  visibility  text        not null default 'public' check (visibility in ('public', 'friends')),
  status      text        not null default 'open'   check (status in ('open', 'cancelled')),
  created_at  timestamptz not null default now()
);

create index if not exists hoop_runs_court_time_idx
  on public.hoop_runs (court_id, starts_at);

create table if not exists public.hoop_run_participants (
  run_id     uuid        not null references public.hoop_runs (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);

alter table public.hoop_runs enable row level security;
alter table public.hoop_run_participants enable row level security;

-- Runs: public ones are readable by all; the host can always see their own.
create policy "public runs are readable"
  on public.hoop_runs for select
  using (visibility = 'public' or host = auth.uid());

create policy "users can create their own runs"
  on public.hoop_runs for insert with check (host = auth.uid());

create policy "host can update their run"
  on public.hoop_runs for update using (host = auth.uid());

-- Participants: readable by all (rosters/counts); users manage only their own row.
create policy "run participants are readable"
  on public.hoop_run_participants for select using (true);

create policy "users can join as themselves"
  on public.hoop_run_participants for insert with check (user_id = auth.uid());

create policy "users can leave their own row"
  on public.hoop_run_participants for delete using (user_id = auth.uid());

-- Auto-add the host as a participant when a run is created.
create or replace function public.add_host_as_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.hoop_run_participants (run_id, user_id)
  values (new.id, new.host)
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists hoop_runs_add_host_trg on public.hoop_runs;
create trigger hoop_runs_add_host_trg
  after insert on public.hoop_runs
  for each row execute function public.add_host_as_participant();

-- Real-time so new runs / RSVPs can push live to open court cards (future use).
-- Guarded so re-running doesn't error on "already a member".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hoop_runs'
  ) then
    alter publication supabase_realtime add table public.hoop_runs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hoop_run_participants'
  ) then
    alter publication supabase_realtime add table public.hoop_run_participants;
  end if;
end $$;
