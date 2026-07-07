-- RECreate — accounts: player profiles, friend codes, and personal check-ins.
-- Supabase Auth (email + password) manages auth.users; this adds the app-level
-- profile that the social features build on. Depends on: auth (built-in).
--
-- Sign-in method: Dashboard → Authentication → Providers → Email (on by default).
-- Turn OFF "Confirm email" for frictionless local testing; keep it ON in prod.

create table if not exists public.profiles (
  id              uuid        primary key references auth.users (id) on delete cascade,
  display_name    text        check (display_name is null or char_length(display_name) between 1 and 50),
  age             int         check (age is null or age between 13 and 120),
  bio             text        check (bio is null or char_length(bio) <= 280),
  neighborhood    text        check (neighborhood is null or char_length(neighborhood) <= 60),
  favorite_sports     text[], -- sport ids from lib/sports.js
  favorite_categories text[], -- class-category ids from data/classes.js (interests)
  friend_code     text        unique,  -- short shareable code, set by trigger below
  share_activity  boolean     not null default true,  -- broadcast my check-ins/signals/runs/votes to friends (07_push.sql)
  created_at      timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Profiles are readable by any signed-in user (names show up across the social
-- features, and friend-code lookup must search all profiles) but not by anon —
-- the anon key ships in the app bundle, so a world-readable policy would let
-- anyone script-dump every user's age/bio/neighborhood. Users edit only theirs.
create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated using (true);

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

-- ---------------------------------------------------------------------------
-- Friend codes: a short, shareable, unambiguous code (no 0/O/1/I/L) per profile.
-- You add a friend by their code (see 05_friends.sql).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Personal "I played here" check-in log: one row per logged visit (court + sport).
-- Powers the account screen's per-sport counters and most-visited ("favorite")
-- park. Distinct from public.check_ins (anonymous crowd-level reports).
-- ---------------------------------------------------------------------------
create table if not exists public.player_check_ins (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  court_id   text        not null,
  sport      text        not null,
  notify     boolean     not null default false,  -- opt-in "tell my friends I checked in" (07_push.sql)
  created_at timestamptz not null default now()
);

create index if not exists player_check_ins_user_idx
  on public.player_check_ins (user_id, created_at desc);

alter table public.player_check_ins enable row level security;

-- Check-ins are a location history, so reads are private: your own rows here,
-- plus accepted friends' rows via the augmenting policy in 05_friends.sql
-- (multiple SELECT policies are OR'd). Users write only their own rows.
create policy "users read their own check-ins"
  on public.player_check_ins for select using (auth.uid() = user_id);

create policy "users log their own check-ins"
  on public.player_check_ins for insert with check (auth.uid() = user_id);

create policy "users delete their own check-ins"
  on public.player_check_ins for delete using (auth.uid() = user_id);
