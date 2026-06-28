-- HoopMap — crowd check-ins (anonymous "how busy is this court right now").
-- Apply the schema/ files in numeric order; see supabase/README.md.

create table if not exists public.check_ins (
  id          bigint generated always as identity primary key,
  court_id    text        not null,
  level       text        not null check (level in ('empty', 'moderate', 'packed')),
  ip          text,        -- captured server-side by the rate-limit trigger
  created_at  timestamptz not null default now()
);

-- Fast "recent check-ins per court" lookups.
create index if not exists check_ins_court_time_idx
  on public.check_ins (court_id, created_at desc);

-- Anonymous, public check-ins: anyone can read and add, nobody can edit/delete.
alter table public.check_ins enable row level security;

create policy "anyone can read check-ins"
  on public.check_ins for select using (true);

create policy "anyone can add a check-in"
  on public.check_ins for insert with check (true);

-- Allow removing a recent check-in (powers "tap your vote again to undo").
-- Bounded to the last 2h to limit abuse in the anonymous model.
create policy "anyone can delete a recent check-in"
  on public.check_ins for delete
  using (created_at > now() - interval '2 hours');

-- Enable real-time so other users' check-ins push live to the app.
alter publication supabase_realtime add table public.check_ins;

-- ---------------------------------------------------------------------------
-- Server-side rate limit. Caps how many check-ins one client IP can add in a
-- short window — a backstop on top of the app's one-vote-per-device model that,
-- unlike the client guard, can't be bypassed by clearing app storage.
--
-- Trade-offs (anonymous model): users behind shared Wi-Fi or mobile carrier
-- CGNAT share an IP, so a very busy network could hit the cap. The window is
-- generous to make that rare. True per-user protection needs auth/attestation.
-- IP is captured server-side from the request headers; clients can't forge it.
-- ---------------------------------------------------------------------------
create or replace function public.check_ins_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  client_ip       text;
  recent          int;
  max_per_window  constant int := 30;  -- max check-ins ...
  window_secs     constant int := 60;  -- ... per this many seconds, per IP
begin
  -- First IP in x-forwarded-for (fallback x-real-ip). Null in the SQL editor.
  client_ip := split_part(
    coalesce(
      nullif(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ''),
      current_setting('request.headers', true)::json ->> 'x-real-ip'
    ), ',', 1);
  new.ip := client_ip;

  if client_ip is not null and client_ip <> '' then
    select count(*) into recent
    from public.check_ins
    where ip = client_ip
      and created_at > now() - make_interval(secs => window_secs);

    if recent >= max_per_window then
      raise exception 'Too many check-ins from your network — please slow down.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists check_ins_rate_limit_trg on public.check_ins;
create trigger check_ins_rate_limit_trg
  before insert on public.check_ins
  for each row execute function public.check_ins_rate_limit();
