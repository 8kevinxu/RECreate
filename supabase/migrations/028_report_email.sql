-- Email each new content report to the support inbox (support.recreate@gmail.com)
-- via Resend, instead of leaving it in a table nobody opens. Inert until the
-- `resend_api_key` Vault secret exists — see the setup note below.
-- Idempotent: safe to re-run. Independent of 027 (applies with or without it).
-- Folded into schema/10_moderation.sql.

-- Email every new report to the support inbox, so a report reaches a person
-- instead of waiting for someone to open the dashboard (queries/reports.sql is
-- still where they are reviewed in bulk). Sent through Resend's HTTP API with
-- pg_net, the same way 07_push.sql calls Expo.
--
-- Setup (once, in the dashboard SQL Editor — the key never goes in the repo):
--   select vault.create_secret('re_…', 'resend_api_key');
--   -- optional; defaults to Resend's shared sender, which only delivers to the
--   -- address that owns the Resend account:
--   select vault.create_secret('RECreate Reports <reports@playrecreate.com>', 'report_email_from');
-- Without resend_api_key this does nothing, and reports are stored as before.
--
-- Budget: a report is only emailed if its reporter has filed at most 5 in the
-- past hour and at most 50 reports arrived in the past day. Rows past either cap
-- are still stored — the email is a nudge, not the record — and the 50th email
-- says so. The daily cap is what bounds the Resend bill; the per-reporter one
-- stops a single tap-happy user from spending it.
--
-- Only ids are sent, never names or emails: the report says which account filed
-- it and which it names, and the dashboard resolves the rest.

create extension if not exists pg_net;

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
      'All reports: supabase/queries/reports.sql in the dashboard SQL Editor.',
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

-- Trigger-only; clients have no reason to call it.
revoke all on function public.email_content_report() from public, anon, authenticated;

drop trigger if exists content_reports_email on public.content_reports;
create trigger content_reports_email
  after insert on public.content_reports
  for each row execute function public.email_content_report();
