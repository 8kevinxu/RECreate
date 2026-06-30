-- Trust & safety: user blocking + content reports (for App Store UGC compliance).
-- Idempotent — safe to run on an existing DB. Mirror of schema/10_moderation.sql.

create table if not exists public.blocked_users (
  blocker_id uuid        not null references public.profiles (id) on delete cascade,
  blocked_id uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocked_users_not_self check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

do $$ begin
  create policy "see your own blocks" on public.blocked_users for select using (blocker_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "add your own blocks" on public.blocked_users for insert with check (blocker_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "remove your own blocks" on public.blocked_users for delete using (blocker_id = auth.uid());
exception when duplicate_object then null; end $$;

create table if not exists public.content_reports (
  id               uuid        primary key default gen_random_uuid(),
  reporter_id      uuid        references public.profiles (id) on delete set null,
  reported_user_id uuid        references public.profiles (id) on delete set null,
  kind             text        not null check (kind in ('message', 'review', 'signal', 'profile')),
  ref_id           text,
  reason           text        check (reason is null or char_length(reason) <= 500),
  created_at       timestamptz not null default now()
);

create index if not exists content_reports_created_idx on public.content_reports (created_at desc);

alter table public.content_reports enable row level security;

do $$ begin
  create policy "file your own reports" on public.content_reports for insert with check (reporter_id = auth.uid());
exception when duplicate_object then null; end $$;
