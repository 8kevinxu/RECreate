-- Step 1 of 2 in closing profiles to column-level reads. SAFE TO APPLY NOW:
-- it only adds two functions; nothing existing changes.
--
-- The problem (step 2, 033, fixes it): `profiles` is readable column-for-column
-- by any signed-in user (018 only shut out anon), so one scripted `select *`
-- dumps every user's age, bio, neighborhood, interests and friend code. The app
-- itself only ever reads OTHER people's id + display_name, so the fix costs no
-- feature — but two reads the app does make go through columns 033 closes:
--
--   * your own full profile (lib/auth.js), and your own friend code
--     (lib/friends.js getMyCode) → my_profile()
--   * adding a friend by code, which filters on friend_code (a WHERE clause
--     needs SELECT on the column it reads) → find_by_friend_code()
--
-- App builds that use these must reach users BEFORE 033 is applied; an older
-- build that still selects those columns directly fails to load its profile.
-- Apply once in the Supabase SQL editor. Idempotent. Folded into
-- schema/03_profiles.sql.

-- The caller's own profile, every column the app shows or edits. SECURITY
-- DEFINER so it keeps working once 033 narrows the table grant; it can only
-- ever return the caller's own row.
create or replace function public.my_profile()
returns table (
  id                  uuid,
  display_name        text,
  age                 int,
  bio                 text,
  neighborhood        text,
  favorite_sports     text[],
  favorite_categories text[],
  share_activity      boolean,
  friend_code         text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name, p.age, p.bio, p.neighborhood,
         p.favorite_sports, p.favorite_categories, p.share_activity, p.friend_code
  from public.profiles p
  where p.id = auth.uid();
$$;

revoke all on function public.my_profile() from public, anon;
grant execute on function public.my_profile() to authenticated;

-- Look one person up by the exact code they shared. Returns id + name only,
-- and only on an exact match, so codes can't be listed or searched — reading
-- the whole friend_code column is the thing 033 takes away.
create or replace function public.find_by_friend_code(code text)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name
  from public.profiles p
  where auth.uid() is not null
    and p.friend_code = upper(btrim(code));
$$;

revoke all on function public.find_by_friend_code(text) from public, anon;
grant execute on function public.find_by_friend_code(text) to authenticated;
