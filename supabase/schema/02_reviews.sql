-- RECreate — reviews (free-text comments per court). Anonymous + public, like
-- crowd check-ins. Depends on: nothing.

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

-- Insert requires a signed-in account (spam guardrail + UGC accountability):
-- every review is tied to an authenticated user who agreed to the terms and can
-- be moderated. Length limits enforced server-side. The client shows a
-- "Sign in to review" prompt when Supabase is configured and nobody is signed
-- in. (See migration 016 for existing databases.)
create policy "signed-in users can add a review"
  on public.reviews for insert
  to authenticated
  with check (
    auth.uid() is not null
    and char_length(body) between 1 and 1000
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
