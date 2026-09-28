-- Two fixes to planned runs, found while specifying Groups (docs/groups-phase1.md).
-- Apply once to an existing database in the Supabase SQL editor. Idempotent.
-- Folded into schema/04_runs.sql.
--
-- 1) rec_runs.sport was still migration 003's five-sport enum (basketball,
--    volleyball, pingpong, pickleball, tennis), while RunModal offers every
--    PLAN_SPORTS id — so planning a badminton / soccer / baseball / swimming /
--    handball / weight-room / golf run failed the insert. Replace the enum with
--    the length cap every other sport column already has (020): length only,
--    deliberately not an enum, so adding a sport never needs a migration again.
--
--    The constraint's name depends on the database's history: 003 names it
--    rec_runs_sport_check, but a database that created the column before the
--    010 rename carries hoop_runs_sport_check (renaming a table keeps its
--    constraint names). So drop every CHECK on rec_runs that mentions `sport`,
--    whatever it is called, rather than guessing.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.rec_runs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%sport%'
  loop
    execute format('alter table public.rec_runs drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.rec_runs add constraint rec_runs_sport_len
  check (char_length(sport) <= 40);

-- 2) Joining a run only checked `user_id = auth.uid()`, so anyone holding a
--    run's id could insert themselves into a friends-only run they cannot see —
--    and a participant row is what grants a run's group chat (08_chat.sql).
--    Ids are random UUIDs, so this needed a leaked id, but membership should
--    follow visibility regardless. Require the run to be visible to the caller:
--    rec_runs RLS applies inside the subquery (the pattern 019 uses for
--    rosters, and exactly what rec_signal_participants has always done).
--    The host's own row is unaffected: add_host_as_participant() is SECURITY
--    DEFINER and inserts past RLS.
drop policy if exists "users can join as themselves" on public.rec_run_participants;
drop policy if exists "join visible runs as yourself" on public.rec_run_participants;

create policy "join visible runs as yourself"
  on public.rec_run_participants for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.rec_runs r where r.id = run_id)
  );
