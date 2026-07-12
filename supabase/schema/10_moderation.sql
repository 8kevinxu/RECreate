-- RECreate — trust & safety: user blocking + content reports. Required for App
-- Store review of any app with user-generated content (chat, reviews, signals):
-- users must be able to block abusive accounts and report objectionable content.
-- Depends on: 03_profiles.sql.

-- Who you've blocked. Their content is hidden from you client-side (the loaders in
-- lib/* filter on this set); kept here so it syncs across your devices.
create table if not exists public.blocked_users (
  blocker_id uuid        not null references public.profiles (id) on delete cascade,
  blocked_id uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocked_users_not_self check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

-- You only ever see and manage your own block list.
create policy "see your own blocks"
  on public.blocked_users for select using (blocker_id = auth.uid());
create policy "add your own blocks"
  on public.blocked_users for insert with check (blocker_id = auth.uid());
create policy "remove your own blocks"
  on public.blocked_users for delete using (blocker_id = auth.uid());

-- Reports of objectionable content/users. Write-only for users (insert your own);
-- reviewed out-of-band via the service role / dashboard, so there's no SELECT
-- policy (RLS-enabled with no select policy = users can't read the table).
create table if not exists public.content_reports (
  id               uuid        primary key default gen_random_uuid(),
  reporter_id      uuid        references public.profiles (id) on delete set null,
  reported_user_id uuid        references public.profiles (id) on delete set null,
  kind             text        not null check (kind in ('message', 'review', 'signal', 'profile', 'run')),
  ref_id           text,                                              -- id of the reported row (message/review/signal/run)
  reason           text        check (reason is null or char_length(reason) <= 500),
  created_at       timestamptz not null default now()
);

create index if not exists content_reports_created_idx on public.content_reports (created_at desc);

alter table public.content_reports enable row level security;

create policy "file your own reports"
  on public.content_reports for insert with check (reporter_id = auth.uid());
