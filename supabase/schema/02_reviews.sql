-- RECreate — reviews (free-text comments per court). Public, and anonymous to
-- readers: the display name is free text and the owner id is not selectable
-- (see the grants below). Depends on: auth (reviews.user_id).

create table if not exists public.reviews (
  id          bigint generated always as identity primary key,
  court_id    text        not null,
  author      text,                                   -- optional display name
  body        text        not null check (char_length(body) between 1 and 1000),
  user_id     uuid        references auth.users(id) on delete cascade
                          default auth.uid(),          -- owner; see 029
  rating      int         check (rating between 1 and 5), -- optional (future stars)
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists reviews_court_time_idx
  on public.reviews (court_id, created_at desc);

create index if not exists reviews_user_idx on public.reviews (user_id);

alter table public.reviews enable row level security;

create policy "anyone can read reviews"
  on public.reviews for select using (true);

-- ...but not every column. Profiles are readable by any signed-in user, so a
-- selectable user_id would deanonymize a review posted as "Anonymous" with one
-- join; `ip` is the rate limiter's business and nobody else's. Postgres can't
-- revoke one column out of a table-wide grant, so the grant is restated as a
-- column list. (See migration 029.)
revoke select on public.reviews from anon, authenticated;
grant select (id, court_id, author, body, rating, created_at)
  on public.reviews to anon, authenticated;

-- Insert requires a signed-in account (spam guardrail + UGC accountability):
-- every review is tied to an authenticated user who agreed to the terms and can
-- be moderated. Length limits enforced server-side. The client shows a
-- "Sign in to review" prompt when Supabase is configured and nobody is signed
-- in. (See migration 016 for existing databases.)
create policy "signed-in users can add a review"
  on public.reviews for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and char_length(body) between 1 and 1000
    and (author is null or char_length(author) <= 50)
  );

-- A user may delete their own review, and only their own. Rows written before
-- 029 carry a null user_id and are nobody's: still readable, not deletable from
-- the app — moderate those via the dashboard (Table Editor), as before.
create policy "users delete their own reviews"
  on public.reviews for delete
  to authenticated
  using (user_id = auth.uid());

-- Which of a court's reviews belong to the caller, so the card can offer Delete
-- on them. Definer because user_id is not selectable by the calling role; safe
-- because it returns ids, and only ever the caller's own (the shape
-- court_checkin_count() uses in 03).
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
