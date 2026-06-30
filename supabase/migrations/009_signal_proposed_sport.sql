-- Let a responder suggest a sport/activity (not just a court + time) when joining
-- a "down to play" signal — needed especially for "Anything" signals that have no
-- sport yet. Confirming a suggestion promotes its sport onto the signal. Idempotent.
alter table public.rec_signal_participants
  add column if not exists proposed_sport text;
