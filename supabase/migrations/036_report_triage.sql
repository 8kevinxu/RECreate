-- Report triage: give content_reports a status so a report can be closed, and a
-- daily digest that nags about whatever is still open. Before this, the queue
-- was "everything from the last 90 days", every time — a report you had already
-- dealt with looked exactly like one you hadn't, and nothing ever reminded you
-- of one you forgot.
--
-- The loop:
--   1. A report arrives → per-report email (028), now ending in the one-line
--      `update` that closes it.
--   2. Each morning, if anything is still open, one digest email lists it,
--      overdue items first (people reports > 24h, data flags > 7 days).
--   3. queries/reports.sql shows only open + waiting rows; closing is an update.
--
-- Statuses:
--   open      — nobody has looked at it yet. The digest nags about these.
--   waiting   — seen, and the fix is out of our hands for now (an upstream site
--               to correct, a scrape to re-run, a poster to re-transcribe). Kept
--               out of the nag but counted in the digest, so it can't vanish.
--   resolved  — fixed / acted on.
--   dismissed — not actionable (wrong report, spam, already correct).
-- A later report on the same entity is a new open row, so a "fixed" court that
-- is still wrong comes straight back; the queue shows how the last one closed.
--
-- Clients still cannot read or update the table. Insert now additionally
-- requires a row to arrive open — otherwise a client could file a report
-- already marked resolved and keep it out of the queue.
--
-- Needs pg_cron (Database → Extensions, or the create extension line below —
-- 035 enables it too). Idempotent: safe to re-run. Independent of 034/035.
-- Folded into schema/10_moderation.sql.

alter table public.content_reports
  add column if not exists status      text not null default 'open',
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution  text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'content_reports_status_check') then
    alter table public.content_reports add constraint content_reports_status_check
      check (status in ('open', 'waiting', 'resolved', 'dismissed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_reports_resolution_len') then
    alter table public.content_reports add constraint content_reports_resolution_len
      check (resolution is null or char_length(resolution) <= 1000);
  end if;
end $$;

-- The queue reads only unclosed rows, which stay a small slice of the table.
create index if not exists content_reports_unclosed_idx
  on public.content_reports (created_at desc)
  where status in ('open', 'waiting');

drop policy if exists "file your own reports" on public.content_reports;
create policy "file your own reports"
  on public.content_reports for insert
  with check (reporter_id = auth.uid() and status = 'open' and resolved_at is null and resolution is null);

-- Stamp resolved_at on close and clear it on reopen, so closing a report is just
-- `set status = …` and the timestamp can't be forgotten or left stale.
create or replace function public.content_reports_stamp_resolved()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('resolved', 'dismissed') then
    if old.status not in ('resolved', 'dismissed') or new.resolved_at is null then
      new.resolved_at := now();
    end if;
  else
    new.resolved_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.content_reports_stamp_resolved() from public, anon, authenticated;

drop trigger if exists content_reports_resolved_at on public.content_reports;
create trigger content_reports_resolved_at
  before update of status on public.content_reports
  for each row execute function public.content_reports_stamp_resolved();

-- Per-report email (028), unchanged except for the closing lines: the statement
-- that closes this report, and for a data flag, the one that closes every open
-- flag on the same entity (duplicates are common — there's no dedupe on filing).
create or replace function public.email_content_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  api_key    text;
  sender     text;
  by_them    int;
  today      int;
  entity     text := split_part(coalesce(new.ref_id, ''), ':', 1);
  target     text := split_part(coalesce(new.ref_id, ''), ':', 2);
  sport      text := split_part(coalesce(new.ref_id, ''), ':', 3);
  app_link   text;
  subject    text;
  body       text;
begin
  -- Never let the email fail the insert: a report that isn't emailed is still in
  -- the table, a report that isn't saved is gone.
  begin
    select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
    if api_key is null or api_key = '' then
      return new;
    end if;
    select decrypted_secret into sender from vault.decrypted_secrets where name = 'report_email_from';

    select count(*) into by_them from public.content_reports
      where reporter_id = new.reporter_id and created_at > now() - interval '1 hour';
    select count(*) into today from public.content_reports
      where created_at > now() - interval '1 day';
    if by_them > 5 or today > 50 then
      return new;
    end if;

    if new.kind = 'data' and entity in ('court', 'pool', 'class') then
      app_link := 'https://playrecreate.com/?city='
        || case when target ~ '^nycp?-' then 'nyc' else 'sf' end
        || case entity
             when 'court' then '&court=' || target || '&sport=' || sport
             when 'pool'  then '&court=' || target || '&sport=swimming'
             else '&tab=classes'
           end;
    end if;

    -- ref_id is client-supplied and uncapped, so it is trimmed wherever it's shown.
    subject := '[RECreate] ' || case new.kind
      when 'data'  then 'Wrong info reported: ' || left(entity || ' ' || target || coalesce(nullif(' · ' || sport, ' · '), ''), 100)
      when 'issue' then 'Problem reported'
      else initcap(new.kind) || ' reported'
    end;

    body := concat_ws(E'\n',
      'Kind: ' || new.kind,
      'Reported: ' || left(new.ref_id, 300),
      'Open in app: ' || app_link,
      case when nullif(new.reason, '') is not null then E'\n' || new.reason || E'\n' end,
      'Reported user id: ' || new.reported_user_id,
      'Reporter id: ' || coalesce(new.reporter_id::text, 'unknown'),
      'Filed: ' || to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'),
      '',
      'Close it (status resolved | dismissed | waiting):',
      '  update public.content_reports set status = ''resolved'', resolution = '''' where id = '''
        || new.id || ''';',
      -- Only a short, well-formed data ref is worth echoing back as SQL.
      case when new.kind = 'data' and char_length(new.ref_id) <= 200 then
        E'Close every open flag on this entity:\n'
        || '  update public.content_reports set status = ''resolved'', resolution = '''' where kind = ''data'' and ref_id = '
        || quote_literal(new.ref_id) || ' and status in (''open'', ''waiting'');'
      end,
      '',
      'Open queue: supabase/queries/reports.sql in the dashboard SQL Editor.',
      case when today = 50 then E'\nThis is the 50th report today — no more will be emailed until the count drops. Check the dashboard.' end
    );

    perform net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || api_key
      ),
      body := jsonb_build_object(
        'from', coalesce(nullif(sender, ''), 'RECreate Reports <onboarding@resend.dev>'),
        'to', jsonb_build_array('support.recreate@gmail.com'),
        'subject', subject,
        'text', body
      )
    );
  exception when others then
    raise warning 'email_content_report: % (report % stored, not emailed)', sqlerrm, new.id;
  end;
  return new;
end;
$$;

revoke all on function public.email_content_report() from public, anon, authenticated;

-- The daily digest. Sends nothing when nothing is open — an email that arrives
-- every day regardless is one you stop reading. Same Vault secrets as 028, and
-- inert without them. One email a day, so it needs no budget of its own.
--
-- Overdue thresholds: people reports (messages, reviews, profiles, …) and
-- "Report a problem" are 24h — App Store review expects objectionable content
-- to be acted on promptly; data flags are 7 days, since a fix often waits on a
-- scrape or a rebuild. A waiting row is never overdue.
create or replace function public.email_report_digest()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  api_key   text;
  sender    text;
  n_open    int;
  n_overdue int;
  n_waiting int;
  people    text;
  flags     text;
  body      text;
begin
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
  if api_key is null or api_key = '' then
    return;
  end if;
  select decrypted_secret into sender from vault.decrypted_secrets where name = 'report_email_from';

  select
    count(*) filter (where status = 'open'),
    count(*) filter (where status = 'open' and created_at < now() - case when kind = 'data' then interval '7 days' else interval '24 hours' end),
    count(*) filter (where status = 'waiting')
  into n_open, n_overdue, n_waiting
  from public.content_reports
  where status in ('open', 'waiting');

  if n_open = 0 then
    return;
  end if;

  -- People reports and problems: one line each, oldest first (that's the order
  -- they go overdue in), with the full id so a line can be closed as-is.
  select string_agg(line, E'\n' order by created_at)
  into people
  from (
    select created_at,
      case when created_at < now() - interval '24 hours' then '! ' else '  ' end
        || to_char(created_at at time zone 'UTC', 'MM-DD HH24:MI') || '  '
        || rpad(kind, 8) || '  '
        || left(regexp_replace(coalesce(nullif(reason, ''), ref_id, ''), '\s+', ' ', 'g'), 100)
        || E'\n     id ' || id as line
    from public.content_reports
    where status = 'open' and kind <> 'data'
    order by created_at
    limit 25
  ) t;

  -- Data flags: one line per entity, by distinct reporters (the same ranking as
  -- queries/reports.sql — one person tapping five times is not five people).
  select string_agg(line, E'\n' order by reporters desc, oldest)
  into flags
  from (
    select count(distinct reporter_id) as reporters, min(created_at) as oldest,
      case when min(created_at) < now() - interval '7 days' then '! ' else '  ' end
        || count(distinct reporter_id) || ' reporter' || case when count(distinct reporter_id) = 1 then ' ' else 's' end
        || '  ' || extract(day from now() - min(created_at))::int || 'd  '
        || left(ref_id, 120)
        || coalesce(' — ' || left(regexp_replace(max(reason), '\s+', ' ', 'g'), 80), '') as line
    from public.content_reports
    where status = 'open' and kind = 'data'
    group by ref_id
    order by reporters desc, oldest
    limit 25
  ) t;

  body := concat_ws(E'\n',
    n_open || ' open report' || case when n_open = 1 then '' else 's' end
      || case when n_overdue > 0 then ', ' || n_overdue || ' overdue (marked !)' else '' end
      || case when n_waiting > 0 then '. ' || n_waiting || ' waiting on a fix.' else '.' end,
    case when people is not null then E'\nPEOPLE & PROBLEMS (overdue after 24h)\n' || people end,
    case when flags is not null then E'\nWRONG INFO (overdue after 7 days)\n' || flags end,
    '',
    'Work the queue with supabase/queries/reports.sql. Close a report:',
    '  update public.content_reports set status = ''resolved'', resolution = ''…'' where id = ''…'';',
    'Statuses: resolved · dismissed · waiting (seen, fix pending — leaves this email).'
  );

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || api_key
    ),
    body := jsonb_build_object(
      'from', coalesce(nullif(sender, ''), 'RECreate Reports <onboarding@resend.dev>'),
      'to', jsonb_build_array('support.recreate@gmail.com'),
      'subject', '[RECreate] Triage: ' || n_open || ' open'
        || case when n_overdue > 0 then ', ' || n_overdue || ' overdue' else '' end,
      'text', body
    )
  );
end;
$$;

-- Cron-only; a client calling it could make the inbox send on demand.
revoke all on function public.email_report_digest() from public, anon, authenticated;

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'reports-digest-daily') then
    perform cron.unschedule('reports-digest-daily');
  end if;
end $$;

-- 15:30 UTC = 8:30 AM Pacific in summer, 7:30 in winter: in the inbox before the
-- day starts, off the top of the hour where other jobs cluster.
select cron.schedule(
  'reports-digest-daily',
  '30 15 * * *',
  $$ select public.email_report_digest(); $$
);
