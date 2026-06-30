-- HoopMap — account self-deletion. Lets a signed-in user delete their own
-- account from the app with only the anon key. Depends on: 03 (profiles).
--
-- Why a function: the client can't touch the auth schema, and deleting an
-- auth.users row needs elevated rights. This SECURITY DEFINER function runs as
-- its owner (postgres) and removes only the caller's own row (auth.uid()).
-- Every app table foreign-keys to profiles ON DELETE CASCADE, and profiles
-- foreign-keys to auth.users ON DELETE CASCADE — so deleting the auth row
-- cascades away all of the user's data (profile, runs, signals, friends,
-- chat, push tokens, personal check-ins). Anonymous rows that carry no
-- user id (crowd check-ins, reviews) are intentionally left untouched.

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

-- Only a signed-in user may invoke it; it always acts on the caller's own id.
revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
