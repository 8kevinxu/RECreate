-- Public "down to play" signals — the Discover feed.
-- Apply once to an existing database in the Supabase SQL editor. Idempotent.
-- Folded into schema/06_signals.sql.
--
-- Every social feature needed friends first, and friends are added by a code
-- handed over in person — so a new account's Social tab had nothing on it and no
-- way forward. A public signal is the one post that reaches someone you haven't
-- met. This mirrors rec_runs.visibility (04_runs.sql) with one deliberate
-- difference: the default is 'friends', not 'public'. Every existing signal was
-- posted under a friends-only expectation, and this migration must not publish
-- them retroactively.
--
-- Push is unchanged on purpose: notify_signal() (07_push.sql) still fans out to
-- the poster's accepted friends only. Public widens who can SEE a signal, never
-- who gets pushed — do not "fix" the trigger to notify strangers.
--
-- Joining needs no change either: "join visible signals as yourself" already
-- requires the signal to be visible, and chat membership is a participant row
-- (08_chat.sql). Widening SELECT widens join + chat by exactly the same amount.

alter table public.rec_signals add column if not exists visibility text not null default 'friends';

-- Drop any visibility CHECK by catalog lookup, not by guessed name — 030 found a
-- live constraint still carrying its pre-rename (hoop_*) name. Then add ours.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.rec_signals'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%visibility%'
  loop
    execute format('alter table public.rec_signals drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.rec_signals add constraint rec_signals_visibility_check
  check (visibility in ('public', 'friends'));

-- Discover reads across every poster by expiry, not by user id.
create index if not exists rec_signals_visibility_idx
  on public.rec_signals (visibility, expires_at);

-- Signed-in users may also read public signals. The anon key ships in the
-- bundle, so the public branch requires a session (as profiles do, 018).
drop policy if exists "see your own and friends' signals" on public.rec_signals;
drop policy if exists "see your own, friends' and public signals" on public.rec_signals;

create policy "see your own, friends' and public signals"
  on public.rec_signals for select
  using (
    (visibility = 'public' and auth.uid() is not null)
    or user_id = auth.uid()
    or exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = rec_signals.user_id)
          or (f.addressee = auth.uid() and f.requester = rec_signals.user_id)
        )
    )
  );
