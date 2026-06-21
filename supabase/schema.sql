-- HoopMap SF — crowd check-ins table.
-- Run this in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.

create table if not exists public.check_ins (
  id          bigint generated always as identity primary key,
  court_id    text        not null,
  level       text        not null check (level in ('empty', 'moderate', 'packed')),
  created_at  timestamptz not null default now()
);

-- Fast "recent check-ins per court" lookups.
create index if not exists check_ins_court_time_idx
  on public.check_ins (court_id, created_at desc);

-- Anonymous, public check-ins: anyone can read and add, nobody can edit/delete.
alter table public.check_ins enable row level security;

create policy "anyone can read check-ins"
  on public.check_ins for select using (true);

create policy "anyone can add a check-in"
  on public.check_ins for insert with check (true);

-- Allow removing a recent check-in (powers "tap your vote again to undo").
-- Bounded to the last 2h to limit abuse in the anonymous model.
create policy "anyone can delete a recent check-in"
  on public.check_ins for delete
  using (created_at > now() - interval '2 hours');

-- Enable real-time so other users' check-ins push live to the app.
alter publication supabase_realtime add table public.check_ins;

-- ---------------------------------------------------------------------------
-- Server-side rate limit (idempotent — safe to run on an existing table).
-- Caps how many check-ins one client IP can add in a short window. This is a
-- backstop on top of the app's one-vote-per-device model; unlike the client
-- guard, it can't be bypassed by clearing app storage. Tune the two constants.
--
-- Trade-offs (anonymous model): users behind shared Wi-Fi or mobile carrier
-- CGNAT share an IP, so a very busy network could hit the cap. The window is
-- generous to make that rare. True per-user protection needs auth/attestation.
-- ---------------------------------------------------------------------------

-- IP is captured server-side from the request headers; clients can't forge it
-- through the app (the column is set by the trigger, ignoring any sent value).
alter table public.check_ins add column if not exists ip text;

create or replace function public.check_ins_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  client_ip       text;
  recent          int;
  max_per_window  constant int := 30;  -- max check-ins ...
  window_secs     constant int := 60;  -- ... per this many seconds, per IP
begin
  -- First IP in x-forwarded-for (fallback x-real-ip). Null in the SQL editor.
  client_ip := split_part(
    coalesce(
      nullif(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
      current_setting('request.headers', true)::json ->> 'x-real-ip'
    ), ',', 1);
  new.ip := client_ip;

  if client_ip is not null and client_ip <> '' then
    select count(*) into recent
    from public.check_ins
    where ip = client_ip
      and created_at > now() - make_interval(secs => window_secs);

    if recent >= max_per_window then
      raise exception 'Too many check-ins from your network — please slow down.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists check_ins_rate_limit_trg on public.check_ins;
create trigger check_ins_rate_limit_trg
  before insert on public.check_ins
  for each row execute function public.check_ins_rate_limit();

-- ===========================================================================
-- Reviews (free-text comments per court).
-- ===========================================================================

create table if not exists public.reviews (
  id          bigint generated always as identity primary key,
  court_id    text        not null,
  author      text,                                   -- optional display name
  body        text        not null check (char_length(body) between 1 and 1000),
  rating      int         check (rating between 1 and 5), -- optional (future stars)
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists reviews_court_time_idx
  on public.reviews (court_id, created_at desc);

alter table public.reviews enable row level security;

create policy "anyone can read reviews"
  on public.reviews for select using (true);

-- Insert allowed with sane length limits enforced server-side.
create policy "anyone can add a review"
  on public.reviews for insert
  with check (
    char_length(body) between 1 and 1000
    and (author is null or char_length(author) <= 50)
  );

-- No client deletes: moderate via the Supabase dashboard (Table Editor) if
-- needed. (A real moderation/auth flow is future work.)

alter publication supabase_realtime add table public.reviews;

-- Per-IP rate limit for reviews (stricter than check-ins since text is heavier).
create or replace function public.reviews_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  client_ip       text;
  recent          int;
  max_per_window  constant int := 10;   -- max reviews ...
  window_secs     constant int := 600;  -- ... per 10 minutes, per IP
begin
  client_ip := split_part(
    coalesce(
      nullif(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
      current_setting('request.headers', true)::json ->> 'x-real-ip'
    ), ',', 1);
  new.ip := client_ip;

  if client_ip is not null and client_ip <> '' then
    select count(*) into recent
    from public.reviews
    where ip = client_ip
      and created_at > now() - make_interval(secs => window_secs);

    if recent >= max_per_window then
      raise exception 'Too many reviews from your network — please slow down.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reviews_rate_limit_trg on public.reviews;
create trigger reviews_rate_limit_trg
  before insert on public.reviews
  for each row execute function public.reviews_rate_limit();

-- ===========================================================================
-- Accounts: profiles (one row per auth user, holds the public display name).
-- Supabase Auth (email + password) manages auth.users; this table adds the
-- app-level profile. Sign-in method: Dashboard → Authentication → Providers →
-- Email (enabled by default). For frictionless local testing you can turn OFF
-- "Confirm email" there; keep it ON for production.
-- ===========================================================================

create table if not exists public.profiles (
  id           uuid        primary key references auth.users (id) on delete cascade,
  display_name text        check (display_name is null or char_length(display_name) between 1 and 50),
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Profiles are public (names show up in social features); users edit only theirs.
create policy "profiles are readable by everyone"
  on public.profiles for select using (true);

create policy "users can insert their own profile"
  on public.profiles for insert with check (auth.uid() = id);

create policy "users can update their own profile"
  on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile row on signup, pulling display_name from the metadata
-- passed to supabase.auth.signUp({ options: { data: { display_name } } }).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- Social: "plan a run" — scheduled pickup games at a court.
-- Requires the profiles table above. Visibility is 'public' for now; the
-- friends graph (future) will add a 'friends' scope + matching RLS policy.
-- ===========================================================================

create table if not exists public.hoop_runs (
  id          uuid        primary key default gen_random_uuid(),
  host        uuid        not null references public.profiles (id) on delete cascade,
  court_id    text        not null,
  starts_at   timestamptz not null,
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
-- Guarded so re-running this section doesn't error on "already a member".
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

-- ===========================================================================
-- Social: friends graph — friend codes + request/accept friendships.
-- Each profile gets a unique short code; you add a friend by their code, which
-- creates a pending request the other person accepts. Builds on profiles above.
-- ===========================================================================

-- Short, shareable, unambiguous friend code (no 0/O/1/I/L) on each profile.
alter table public.profiles add column if not exists friend_code text unique;

create or replace function public.gen_friend_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.profiles where friend_code = code);
  end loop;
  return code;
end;
$$;

-- Assign a code on profile insert when one isn't supplied.
create or replace function public.set_friend_code()
returns trigger
language plpgsql
as $$
begin
  if new.friend_code is null then
    new.friend_code := public.gen_friend_code();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_set_friend_code on public.profiles;
create trigger profiles_set_friend_code
  before insert on public.profiles
  for each row execute function public.set_friend_code();

-- Backfill any existing profiles (one at a time so codes stay unique).
do $$
declare r record;
begin
  for r in select id from public.profiles where friend_code is null loop
    update public.profiles set friend_code = public.gen_friend_code() where id = r.id;
  end loop;
end $$;

create table if not exists public.friendships (
  id          uuid        primary key default gen_random_uuid(),
  requester   uuid        not null references public.profiles (id) on delete cascade,
  addressee   uuid        not null references public.profiles (id) on delete cascade,
  status      text        not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (requester <> addressee),
  unique (requester, addressee)
);

create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);

alter table public.friendships enable row level security;

-- You can only see, send, answer, and remove friendships you're part of.
create policy "see your friendships"
  on public.friendships for select
  using (requester = auth.uid() or addressee = auth.uid());

create policy "send friend requests"
  on public.friendships for insert
  with check (requester = auth.uid() and requester <> addressee);

create policy "respond to requests you received"
  on public.friendships for update
  using (addressee = auth.uid());

create policy "remove a friendship you're in"
  on public.friendships for delete
  using (requester = auth.uid() or addressee = auth.uid());

-- Real-time so incoming requests / accepts can update the Friends view live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end $$;

-- ===========================================================================
-- Social: "down to hoop" signals — location-less availability pings to friends.
-- A signal with no starts_at means "right now"; with starts_at it's "at a time,
-- no place yet". Friends-only (RLS), and auto-expiring. Builds on friendships.
-- ===========================================================================

create table if not exists public.hoop_signals (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.profiles (id) on delete cascade,
  starts_at   timestamptz,                                   -- null = "right now"
  note        text        check (note is null or char_length(note) <= 200),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null                           -- set by the client
);

create index if not exists hoop_signals_expires_idx on public.hoop_signals (expires_at);
create index if not exists hoop_signals_user_idx on public.hoop_signals (user_id);

alter table public.hoop_signals enable row level security;

-- You can see your own signals and those of accepted friends.
create policy "see your own and friends' signals"
  on public.hoop_signals for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = hoop_signals.user_id)
          or (f.addressee = auth.uid() and f.requester = hoop_signals.user_id)
        )
    )
  );

create policy "post your own signal"
  on public.hoop_signals for insert with check (user_id = auth.uid());

create policy "cancel your own signal"
  on public.hoop_signals for delete using (user_id = auth.uid());

-- Real-time so friends' signals appear live (the in-app "notification").
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'hoop_signals'
  ) then
    alter publication supabase_realtime add table public.hoop_signals;
  end if;
end $$;
