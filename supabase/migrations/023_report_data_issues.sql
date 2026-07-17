-- Community data-quality + general problem reports (supersedes the never-applied
-- 'schedule' draft of this migration):
--   kind 'data'  — one-tap "this looks wrong" flags on the court/class/pool
--                  cards; ref_id names the entity ('court:<id>:<sport>' |
--                  'class:<id>' | 'pool:<id>'). No reported user.
--   kind 'issue' — free-text "Report a problem" in Settings (reason carries
--                  the text, capped at 500 by the existing CHECK).
-- Folded into schema/10_moderation.sql.

alter table public.content_reports drop constraint if exists content_reports_kind_check;
alter table public.content_reports
  add constraint content_reports_kind_check
  check (kind in ('message', 'review', 'signal', 'profile', 'run', 'data', 'issue'));
