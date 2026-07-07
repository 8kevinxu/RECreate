-- Profiles: stop anon SELECT (privacy). The anon key ships in the app bundle,
-- so the old world-readable policy let anyone script-dump every user's
-- age / bio / neighborhood / display name without an account. Signed-in users
-- keep full read access — display names appear across the social features and
-- adding a friend looks up an arbitrary friend_code, so reads can't be
-- friends-scoped. Only signed-out impact: public runs in the Activity feed
-- fall back to "Someone" for the host name (joining already required an
-- account). Folded into schema/03_profiles.sql.

drop policy if exists "profiles are readable by everyone" on public.profiles;

create policy "profiles are readable by signed-in users"
  on public.profiles for select to authenticated using (true);
