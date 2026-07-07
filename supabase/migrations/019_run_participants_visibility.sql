-- Run participants: stop world-readable SELECT (privacy). The old policy let
-- any caller — including anon — dump every user's run-attendance history
-- (user_id + run_id + joined-at), including participants of friends-only runs
-- whose run row itself is hidden. Now a user sees their own rows (so run-chat
-- membership survives friendship churn on friends-only runs) plus the roster
-- of any run they can see — rec_runs RLS applies inside the subquery, so
-- public rosters stay public (counts in the signed-out feed keep working) and
-- friends-only rosters stay friends-only. Same pattern as signal participants
-- (06_signals.sql). Folded into schema/04_runs.sql.

drop policy if exists "run participants are readable" on public.rec_run_participants;

create policy "see your own participation and rosters of visible runs"
  on public.rec_run_participants for select
  using (
    user_id = auth.uid()
    or exists (select 1 from public.rec_runs r where r.id = run_id)
  );
