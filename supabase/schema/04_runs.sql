-- RECreate — social: "plan a run" (scheduled pickup games at a court).
-- Depends on: 03_profiles.sql. Visibility is 'public' or 'friends'; the
-- friends-only SELECT policy lives in 05_friends.sql (it needs the friendships
-- table). The host is auto-added as the first participant.

create table if not exists public.rec_runs (
  id          uuid        primary key default gen_random_uuid(),
  host        uuid        not null references public.profiles (id) on delete cascade,
  court_id    text        not null,
  starts_at   timestamptz not null,
  sport       text        not null default 'basketball'
                          check (sport in ('basketball', 'volleyball', 'pingpong', 'pickleball', 'tennis')),
  note        text        check (note is null or char_length(note) <= 200),
  visibility  text        not null default 'public' check (visibility in ('public', 'friends')),
  status      text        not null default 'open'   check (status in ('open', 'cancelled')),
  notify      boolean     not null default false,  -- notify friends on create (gated by the host's share_activity; see 07_push.sql)
  created_at  timestamptz not null default now()
);

create index if not exists rec_runs_court_time_idx
  on public.rec_runs (court_id, starts_at);

create table if not exists public.rec_run_participants (
  run_id     uuid        not null references public.rec_runs (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (run_id, user_id)
);

alter table public.rec_runs enable row level security;
alter table public.rec_run_participants enable row level security;

-- Runs: public ones are readable by all; the host can always see their own.
create policy "public runs are readable"
  on public.rec_runs for select
  using (visibility = 'public' or host = auth.uid());

create policy "users can create their own runs"
  on public.rec_runs for insert with check (host = auth.uid());

create policy "host can update their run"
  on public.rec_runs for update using (host = auth.uid());

-- Participants: you always see your own rows (chat membership must survive
-- friendship churn on friends-only runs), plus the roster of any run you can
-- see (RLS on rec_runs applies inside the subquery, so friends-only rosters
-- stay friends-only — same pattern as signal participants in 06_signals.sql).
-- Users manage only their own row.
create policy "see your own participation and rosters of visible runs"
  on public.rec_run_participants for select
  using (
    user_id = auth.uid()
    or exists (select 1 from public.rec_runs r where r.id = run_id)
  );

create policy "users can join as themselves"
  on public.rec_run_participants for insert with check (user_id = auth.uid());

create policy "users can leave their own row"
  on public.rec_run_participants for delete using (user_id = auth.uid());

-- Auto-add the host as a participant when a run is created.
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

drop trigger if exists rec_runs_add_host_trg on public.rec_runs;
create trigger rec_runs_add_host_trg
  after insert on public.rec_runs
  for each row execute function public.add_host_as_participant();

-- Real-time so new runs / RSVPs can push live to open court cards (future use).
-- Guarded so re-running doesn't error on "already a member".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rec_runs'
  ) then
    alter publication supabase_realtime add table public.rec_runs;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rec_run_participants'
  ) then
    alter publication supabase_realtime add table public.rec_run_participants;
  end if;
end $$;
