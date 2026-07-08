-- Trust & safety: bound the length of user-supplied text fields that RLS lets
-- an authenticated user write but that carry NO length constraint. Notes,
-- chat bodies, reviews, and profile name/bio/neighborhood are already capped;
-- these id / sport / place fields and the profile interest arrays were not, so
-- a modified client (authed as a real user, passing every ownership RLS check)
-- could insert megabyte-long strings — DB bloat and broken UI for anyone who
-- renders the value. Caps are generous vs real values (court ids max 42 chars,
-- sport ids max 10, category arrays ~65 chars serialized), so no legitimate
-- write is affected. Length only — deliberately not an enum of valid ids, so
-- adding a new sport/court never needs a migration. Idempotent (named
-- constraints, drop-then-add). Folded into schema/03,04,06.

-- Court-id-shaped strings (data/courts.js ids; real max 42).
alter table public.rec_runs drop constraint if exists rec_runs_court_id_len;
alter table public.rec_runs add constraint rec_runs_court_id_len
  check (char_length(court_id) <= 128);

alter table public.rec_signals drop constraint if exists rec_signals_pref_court_len;
alter table public.rec_signals add constraint rec_signals_pref_court_len
  check (pref_court_id is null or char_length(pref_court_id) <= 128);

alter table public.rec_signals drop constraint if exists rec_signals_planned_court_len;
alter table public.rec_signals add constraint rec_signals_planned_court_len
  check (planned_court_id is null or char_length(planned_court_id) <= 128);

alter table public.rec_signal_participants drop constraint if exists rec_signal_participants_proposed_court_len;
alter table public.rec_signal_participants add constraint rec_signal_participants_proposed_court_len
  check (proposed_court_id is null or char_length(proposed_court_id) <= 128);

alter table public.player_check_ins drop constraint if exists player_check_ins_court_id_len;
alter table public.player_check_ins add constraint player_check_ins_court_id_len
  check (char_length(court_id) <= 128);

-- Sport-id-shaped strings (lib/sports.js ids; real max 10). rec_runs.sport
-- already has an enum check; these three did not.
alter table public.rec_signals drop constraint if exists rec_signals_sport_len;
alter table public.rec_signals add constraint rec_signals_sport_len
  check (char_length(sport) <= 40);

alter table public.rec_signal_participants drop constraint if exists rec_signal_participants_proposed_sport_len;
alter table public.rec_signal_participants add constraint rec_signal_participants_proposed_sport_len
  check (proposed_sport is null or char_length(proposed_sport) <= 40);

alter table public.player_check_ins drop constraint if exists player_check_ins_sport_len;
alter table public.player_check_ins add constraint player_check_ins_sport_len
  check (char_length(sport) <= 40);

-- Signal place preference ('indoor' | 'outdoor'; real max 7).
alter table public.rec_signals drop constraint if exists rec_signals_place_len;
alter table public.rec_signals add constraint rec_signals_place_len
  check (place is null or char_length(place) <= 40);

-- Profile interest arrays. array_to_string is immutable, so bounding the
-- comma-joined length in a CHECK caps total size regardless of how it splits
-- across elements — no subquery/unnest needed (real values ~65 chars).
alter table public.profiles drop constraint if exists profiles_favorite_sports_len;
alter table public.profiles add constraint profiles_favorite_sports_len
  check (favorite_sports is null or char_length(array_to_string(favorite_sports, ',')) <= 2000);

alter table public.profiles drop constraint if exists profiles_favorite_categories_len;
alter table public.profiles add constraint profiles_favorite_categories_len
  check (favorite_categories is null or char_length(array_to_string(favorite_categories, ',')) <= 2000);
