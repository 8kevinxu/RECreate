-- RECreate — trust & safety: user blocking + content reports. Required for App
-- Store review of any app with user-generated content (chat, reviews, signals):
-- users must be able to block abusive accounts and report objectionable content.
-- Depends on: 03_profiles.sql.

-- Who you've blocked. Their content is hidden from you client-side (the loaders in
-- lib/* filter on this set); kept here so it syncs across your devices.
create table if not exists public.blocked_users (
  blocker_id uuid        not null references public.profiles (id) on delete cascade,
  blocked_id uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocked_users_not_self check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

-- You only ever see and manage your own block list.
create policy "see your own blocks"
  on public.blocked_users for select using (blocker_id = auth.uid());
create policy "add your own blocks"
  on public.blocked_users for insert with check (blocker_id = auth.uid());
create policy "remove your own blocks"
  on public.blocked_users for delete using (blocker_id = auth.uid());

-- Reports of objectionable content/users. Write-only for users (insert your own);
-- reviewed out-of-band via the service role / dashboard, so there's no SELECT
-- policy (RLS-enabled with no select policy = users can't read the table).
create table if not exists public.content_reports (
  id               uuid        primary key default gen_random_uuid(),
  reporter_id      uuid        references public.profiles (id) on delete set null,
  reported_user_id uuid        references public.profiles (id) on delete set null,
  kind             text        not null check (kind in ('message', 'review', 'signal', 'profile', 'run', 'data', 'issue', 'closure')),
  ref_id           text,                                              -- id of the reported row (message/review/signal/run); 'data' reports name the entity ('court:<id>:<sport>' | 'class:<id>' | 'pool:<id>'); 'issue' reports carry free text in reason; 'closure' reports name a closure_reports id (its public note)
  reason           text        check (reason is null or char_length(reason) <= 500),
  created_at       timestamptz not null default now()
);

create index if not exists content_reports_created_idx on public.content_reports (created_at desc);

alter table public.content_reports enable row level security;

create policy "file your own reports"
  on public.content_reports for insert with check (reporter_id = auth.uid());

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
