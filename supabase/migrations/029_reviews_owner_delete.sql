-- Reviews: let a user delete their own review.
--
-- A review was an ownerless row with an optional free-text display name, so
-- nobody — not even the person who wrote it — could take one back. This adds
-- `user_id`, defaulted from auth.uid() and pinned there by the insert policy,
-- plus a delete policy scoped to the owner.
--
-- The column is deliberately NOT readable by clients. Reads stay world-readable
-- (a review is public), but profiles are readable by every signed-in user
-- (03_profiles.sql), so shipping user_id beside a review posted as "Anonymous"
-- would deanonymize it with one join. Postgres can't revoke a single column out
-- of a table-wide grant, so the table-level SELECT is replaced with a column
-- list that omits user_id — and `ip`, which the rate-limit trigger writes and
-- which clients could read until now. `my_review_ids()` is SECURITY DEFINER for
-- exactly that reason: it reads past the grant to tell the card which reviews
-- are the caller's own, and returns ids, only ever the caller's, so it says
-- nothing about anyone else (the shape 025's court_checkin_count() uses).
--
-- Rows written before this carry a null user_id: still readable, still not
-- deletable from the app. Moderate those in the dashboard as before.

alter table public.reviews
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- Filled server-side so the client never sends (or could forge) an owner.
alter table public.reviews alter column user_id set default auth.uid();

create index if not exists reviews_user_idx on public.reviews (user_id);

revoke select on public.reviews from anon, authenticated;
grant select (id, court_id, author, body, rating, created_at)
  on public.reviews to anon, authenticated;

-- Insert now also pins the owner. The default supplies it; a caller that sends
-- someone else's id fails the check.
drop policy if exists "signed-in users can add a review" on public.reviews;
create policy "signed-in users can add a review"
  on public.reviews for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and char_length(body) between 1 and 1000
    and (author is null or char_length(author) <= 50)
  );

drop policy if exists "users delete their own reviews" on public.reviews;
create policy "users delete their own reviews"
  on public.reviews for delete
  to authenticated
  using (user_id = auth.uid());

-- Which of a court's reviews belong to the caller (ids only, never anyone
-- else's). Definer because user_id is not selectable by the calling role.
create or replace function public.my_review_ids(p_court_id text)
returns setof bigint
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.reviews
  where court_id = p_court_id
    and auth.uid() is not null
    and user_id = auth.uid();
$$;

revoke all on function public.my_review_ids(text) from public, anon;
grant execute on function public.my_review_ids(text) to authenticated;
