-- Allow reporting a court's posted hours as wrong ("Schedule look wrong?" on the
-- court card's schedule section). ref_id is '<courtId>:<sportId>' — there's no
-- reported user; these flag scraped/transcribed data for re-verification.
-- Folded into schema/10_moderation.sql.

alter table public.content_reports drop constraint if exists content_reports_kind_check;
alter table public.content_reports
  add constraint content_reports_kind_check
  check (kind in ('message', 'review', 'signal', 'profile', 'run', 'schedule'));
