-- RECreate — review what users have reported. Nothing in the app can read
-- content_reports (insert-only RLS), so this is the place they are read: paste a
-- query into the dashboard's SQL Editor and save it as a snippet. Read-only —
-- nothing here changes the database, so it needs no migration.
--
-- Query 1 — "looks wrong" flags, one row per reported entity.
-- Sort by distinct reporters, not raw rows: there is no dedupe on reports, so
-- one person tapping five times is five rows and should not outrank two people
-- independently flagging the same court.

select
  split_part(ref_id, ':', 1)             as entity,       -- court | class | pool
  split_part(ref_id, ':', 2)             as id,
  nullif(split_part(ref_id, ':', 3), '') as sport,        -- courts only
  count(distinct reporter_id)            as reporters,
  count(*)                               as reports,
  min(created_at)                        as first_reported,
  max(created_at)                        as last_reported,
  -- Opens the app on the reported court (on its sport, in its city). Classes
  -- have no per-class deep link, so they land on the city's Classes tab.
  'https://playrecreate.com/?city='
    || case when split_part(ref_id, ':', 2) ~ '^nycp?-' then 'nyc' else 'sf' end
    || case split_part(ref_id, ':', 1)
         when 'court' then '&court=' || split_part(ref_id, ':', 2) || '&sport=' || split_part(ref_id, ':', 3)
         when 'pool'  then '&court=' || split_part(ref_id, ':', 2) || '&sport=swimming'
         else '&tab=classes'
       end                               as open_in_app
from public.content_reports
where kind = 'data'
  and created_at > now() - interval '90 days'
group by ref_id
order by reporters desc, last_reported desc;


-- Query 2 — everything else, newest first: "Report a problem" text (kind
-- 'issue', the text is in reason) and user-content reports (message / review /
-- signal / profile / run / closure; ref_id is the reported row's id).
-- App Store review expects objectionable-content reports to be acted on
-- promptly, so check this one more often than the data flags.

select
  created_at,
  kind,
  reason,
  ref_id,
  reported_user_id,
  reporter_id
from public.content_reports
where kind <> 'data'
  and created_at > now() - interval '90 days'
order by created_at desc;
