-- Player check-ins: stop world-readable SELECT (privacy). The old policy let
-- any caller — including anon, whose key ships in the app bundle — dump every
-- user's full check-in history (which courts they visit and when): a location
-- history keyed to user id. Now a user reads their own rows plus accepted
-- friends' rows, which is all the app ever queries (own stats / dedupe, and
-- the friends activity feed). Realtime applies the same policy, so signed-out
-- or non-friend subscribers no longer receive check-in events either.
-- Mirrors the friends-only-runs pattern (inline exists against friendships;
-- accepted_friend_ids() stays revoked from clients — see 011).
-- Folded into schema/03_profiles.sql + schema/05_friends.sql.

drop policy if exists "player check-ins are readable by everyone" on public.player_check_ins;

create policy "users read their own check-ins"
  on public.player_check_ins for select using (auth.uid() = user_id);

create policy "friends can see friends' check-ins"
  on public.player_check_ins for select
  using (
    exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.requester = auth.uid() and f.addressee = player_check_ins.user_id)
          or (f.addressee = auth.uid() and f.requester = player_check_ins.user_id)
        )
    )
  );
