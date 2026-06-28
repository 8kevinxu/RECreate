-- HoopMap — richer player profiles + a personal "I played here" check-in log.
-- Apply once to an existing HoopMap database: Dashboard → SQL Editor → paste → Run.
-- (A fresh setup gets all of this from schema/03_profiles.sql.) Idempotent.

-- 1) Extend profiles with age, bio, and favorite sports.
alter table public.profiles
  add column if not exists age             int,
  add column if not exists bio             text,
  add column if not exists favorite_sports text[];

alter table public.profiles drop constraint if exists profiles_age_check;
alter table public.profiles
  add constraint profiles_age_check check (age is null or age between 13 and 120);

alter table public.profiles drop constraint if exists profiles_bio_check;
alter table public.profiles
  add constraint profiles_bio_check check (bio is null or char_length(bio) <= 280);

-- 2) Personal check-in log: one row per logged visit (court + sport). Powers the
-- account screen's per-sport counters and most-visited ("favorite") park.
create table if not exists public.player_check_ins (
  id         bigint      generated always as identity primary key,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  court_id   text        not null,
  sport      text        not null,
  created_at timestamptz not null default now()
);

create index if not exists player_check_ins_user_idx
  on public.player_check_ins (user_id, created_at desc);

alter table public.player_check_ins enable row level security;

-- Public read (profiles are public, so stats can surface on a future profile
-- view); users write only their own rows.
drop policy if exists "player check-ins are readable by everyone" on public.player_check_ins;
create policy "player check-ins are readable by everyone"
  on public.player_check_ins for select using (true);

drop policy if exists "users log their own check-ins" on public.player_check_ins;
create policy "users log their own check-ins"
  on public.player_check_ins for insert with check (auth.uid() = user_id);

drop policy if exists "users delete their own check-ins" on public.player_check_ins;
create policy "users delete their own check-ins"
  on public.player_check_ins for delete using (auth.uid() = user_id);
