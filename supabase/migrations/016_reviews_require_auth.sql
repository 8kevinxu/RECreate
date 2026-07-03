-- Reviews: require a signed-in account to post (spam guardrail + UGC
-- accountability). Previously any anon caller could insert; now the insert
-- policy also requires auth.uid(), so every review is tied to an authenticated
-- user who agreed to the terms and can be moderated. Reads stay public.
-- The client (CourtDetail) mirrors this by showing a "Sign in to review" prompt
-- when Supabase is configured and no user is signed in. The per-IP rate-limit
-- trigger from schema/02_reviews.sql stays in place as defense-in-depth.

drop policy if exists "anyone can add a review" on public.reviews;

create policy "signed-in users can add a review"
  on public.reviews for insert
  to authenticated
  with check (
    auth.uid() is not null
    and char_length(body) between 1 and 1000
    and (author is null or char_length(author) <= 50)
  );
