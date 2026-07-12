-- Allow reporting a planned run (long-press → report on Activity-feed run rows,
-- alongside the existing signal/message/review/profile kinds). Folded into
-- schema/10_moderation.sql.

alter table public.content_reports drop constraint if exists content_reports_kind_check;
alter table public.content_reports
  add constraint content_reports_kind_check
  check (kind in ('message', 'review', 'signal', 'profile', 'run'));
