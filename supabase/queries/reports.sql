-- RECreate — the report triage queue. Nothing in the app can read
-- content_reports (insert-only RLS), so this is where reports are worked: paste
-- a query into the dashboard's SQL Editor and save it as a snippet.
--
-- The loop (041): each report is emailed as it arrives, with the `update` that
-- closes it; a digest email each morning lists whatever is still open, overdue
-- first; queries 1 and 2 show only what is open or waiting. A report leaves
-- the queue when you change its status:
--   resolved  — fixed / acted on
--   dismissed — not actionable (wrong, spam, already correct)
--   waiting   — seen, fix pending (an upstream site, the next scrape, a poster to
--               re-transcribe). Stays in the queue but out of the digest's nag.
-- resolved_at is stamped automatically. A new report on the same entity arrives
-- open, so something you closed that is still wrong comes back on its own.


-- Query 1 — people & problems, oldest first: user-content reports (message /
-- review / signal / profile / run / closure; ref_id is the reported row's id) and
-- "Report a problem" text (kind 'issue', the text is in reason). App Store review
-- expects objectionable-content reports to be acted on promptly, so these go
-- overdue after 24 hours, and this is the query to check first.

select
  id,
  status,
  kind,
  reason,
  ref_id,
  reported_user_id,
  reporter_id,
  created_at,
  created_at < now() - interval '24 hours' and status = 'open' as overdue
from public.content_reports
where kind <> 'data'
  and status in ('open', 'waiting')
order by status = 'waiting', created_at;


-- Query 2 — "looks wrong" flags, one row per reported entity, ranked by
-- distinct reporters rather than raw rows: there is no dedupe on filing, so one
-- person tapping five times should not outrank two people independently flagging
-- the same court. last_closed shows how the previous flag on the same entity was
-- closed, so a recurring one is visible as recurring.

select
  split_part(q.ref_id, ':', 1)             as entity,       -- court | class | pool
  split_part(q.ref_id, ':', 2)             as id,
  nullif(split_part(q.ref_id, ':', 3), '') as sport,        -- courts only
  q.status,
  q.reporters,
  q.reports,
  q.notes,
  q.first_reported,
  q.first_reported < now() - interval '7 days' and q.status = 'open' as overdue,
  prev.closed                              as last_closed,
  -- Opens the app on the reported court (on its sport, in its city). Classes
  -- have no per-class deep link, so they land on the city's Classes tab.
  'https://playrecreate.com/?city='
    || case when split_part(q.ref_id, ':', 2) ~ '^nycp?-' then 'nyc' else 'sf' end
    || case split_part(q.ref_id, ':', 1)
         when 'court' then '&court=' || split_part(q.ref_id, ':', 2) || '&sport=' || split_part(q.ref_id, ':', 3)
         when 'pool'  then '&court=' || split_part(q.ref_id, ':', 2) || '&sport=swimming'
         else '&tab=classes'
       end                                 as open_in_app,
  q.ref_id                                 -- paste into the close statement below
from (
  select
    ref_id,
    -- An entity with any open flag is open; otherwise it is waiting.
    case when bool_or(status = 'open') then 'open' else 'waiting' end as status,
    count(distinct reporter_id)                                      as reporters,
    count(*)                                                         as reports,
    string_agg(distinct nullif(reason, ''), ' | ')                   as notes,
    min(created_at)                                                  as first_reported
  from public.content_reports
  where kind = 'data'
    and status in ('open', 'waiting')
  group by ref_id
) q
left join lateral (
  select r.status || ' ' || to_char(r.resolved_at, 'YYYY-MM-DD')
           || coalesce(': ' || nullif(r.resolution, ''), '') as closed
  from public.content_reports r
  where r.kind = 'data' and r.ref_id = q.ref_id and r.status in ('resolved', 'dismissed')
  order by r.resolved_at desc
  limit 1
) prev on true
order by q.status = 'waiting', q.reporters desc, q.first_reported;


-- Closing. resolution is a free-text note (≤ 1000 chars) for the next time the
-- same thing comes up — what was wrong and where the fix went.

-- One report (query 1, or the id in its email):
update public.content_reports
set status = 'resolved', resolution = ''
where id = '…';

-- Every open flag on one entity (query 2's ref_id):
update public.content_reports
set status = 'resolved', resolution = ''
where kind = 'data' and ref_id = 'court:…:…' and status in ('open', 'waiting');

-- Reopen something closed by mistake (clears resolved_at):
update public.content_reports set status = 'open' where id = '…';


-- History — what was closed recently, and how. Useful before deciding a new
-- flag is a repeat.

select resolved_at, status, kind, ref_id, resolution, reason
from public.content_reports
where status in ('resolved', 'dismissed')
  and resolved_at > now() - interval '90 days'
order by resolved_at desc;
