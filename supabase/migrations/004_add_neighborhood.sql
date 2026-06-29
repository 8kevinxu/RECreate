-- Adds an optional neighborhood to player profiles (shown on the profile page).
-- Safe to run on an existing database; new installs get it from 03_profiles.sql.
alter table public.profiles
  add column if not exists neighborhood text
  check (neighborhood is null or char_length(neighborhood) <= 60);
