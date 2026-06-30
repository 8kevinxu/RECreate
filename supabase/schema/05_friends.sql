-- RECreate — social: friends graph (request / accept friendships).
-- You add a friend by their friend_code (set in 03_profiles.sql), which creates
-- a pending request the other person accepts. Depends on: 03_profiles.sql, and
-- 04_runs.sql for the friends-only-runs policy at the bottom.

create table if not exists public.friendships (
  id          uuid        primary key default gen_random_uuid(),
  requester   uuid        not null references public.profiles (id) on delete cascade,
  addressee   uuid        not null references public.profiles (id) on delete cascade,
  status      text        not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (requester <> addressee),
  unique (requester, addressee)
);

create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);

alter table public.friendships enable row level security;

-- You can only see, send, answer, and remove friendships you're part of.
create policy "see your friendships"
  on public.friendships for select
  using (requester = auth.uid() or addressee = auth.uid());

create policy "send friend requests"
  on public.friendships for insert
  with check (requester = auth.uid() and requester <> addressee);

create policy "respond to requests you received"
  on public.friendships for update
  using (addressee = auth.uid());

create policy "remove a friendship you're in"
  on public.friendships for delete
  using (requester = auth.uid() or addressee = auth.uid());

-- Real-time so incoming requests / accepts can update the Friends view live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
  ) then
    alter publication supabase_realtime add table public.friendships;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Let friends see friends-only runs (augments 04_runs.sql, which already covers
-- public and own runs). Multiple SELECT policies on a table are OR'd together.
-- ---------------------------------------------------------------------------
create policy "friends can see friends-only runs"
  on public.rec_runs for select
  using (
    visibility = 'friends'
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = rec_runs.host)
          or (f.addressee = auth.uid() and f.requester = rec_runs.host)
        )
    )
  );
