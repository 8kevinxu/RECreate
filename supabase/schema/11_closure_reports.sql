-- RECreate — player-reported closures: "this court is closed / under
-- maintenance", shown on the court card as a soft, attributed banner — never as
-- a schedule change. Depends on: 03_profiles.sql (profiles, player_check_ins),
-- 10_moderation.sql (blocked_users; the report-email Vault secrets).
--
-- Two tables, no client policies at all: every read and write goes through the
-- SECURITY DEFINER functions below. That is deliberate, for the same reason as
-- court_checkin_count() (025): a report says "someone was at this court at this
-- time", and a row carrying the reporter's id would be a location history. The
-- read function returns tallies and the report's own text, never a user id.
--
-- The rules the functions enforce (the card mirrors the display half):
--   · a dated report is live through its `until` day;
--   · an undated one is live while confirmed within 10 days — the card asks
--     "still closed?" once 3 days pass, and each "yes" moves the clock;
--   · supporters = the reporter + "support" votes; refuters = "incorrect" votes
--     + anyone else who checked in ("I'm here", which a crowd report also logs)
--     at that court+sport since the last confirmation — nobody checks in at a
--     locked gym;
--   · refuters >= supporters reads as disputed; refuters >= supporters + 2
--     clears the report.

create table if not exists public.closure_reports (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  court_id   text        not null check (char_length(court_id) <= 200),
  sport      text        check (sport is null or char_length(sport) <= 40), -- null = whole facility
  kind       text        not null check (kind in ('maintenance', 'closed', 'partial')),
  until      date,                                                          -- null = reporter didn't know
  note       text        check (note is null or char_length(note) <= 140),
  created_at timestamptz not null default now()
);

create index if not exists closure_reports_court_idx
  on public.closure_reports (court_id, created_at desc);
create index if not exists closure_reports_user_idx
  on public.closure_reports (user_id, created_at desc);

create table if not exists public.closure_votes (
  report_id uuid        not null references public.closure_reports (id) on delete cascade,
  user_id   uuid        not null references public.profiles (id) on delete cascade,
  vote      smallint    not null check (vote in (-1, 1)),
  voted_at  timestamptz not null default now(),
  primary key (report_id, user_id)
);

-- RLS on with no policies = no direct table access for anon or authenticated.
alter table public.closure_reports enable row level security;
alter table public.closure_votes enable row level security;

-- Internal: one report's standing. Not granted to clients.
create or replace function public.closure_tally(p_report_id uuid)
returns table (confirmed_at timestamptz, supporters int, refuters int)
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select * from public.closure_reports where id = p_report_id
  ), c as (
    select greatest(
      r.created_at,
      coalesce((select max(v.voted_at) from public.closure_votes v
                where v.report_id = r.id and v.vote = 1), r.created_at)
    ) as confirmed_at
    from r
  )
  select
    c.confirmed_at,
    (1 + (select count(*) from public.closure_votes v
          where v.report_id = r.id and v.vote = 1))::int,
    ((select count(*) from public.closure_votes v
      where v.report_id = r.id and v.vote = -1)
     + (select count(distinct pc.user_id) from public.player_check_ins pc
        where pc.court_id = r.court_id
          and (r.sport is null or pc.sport = r.sport)
          and pc.created_at > c.confirmed_at
          and pc.user_id <> r.user_id
          and not exists (select 1 from public.closure_votes v
                          where v.report_id = r.id and v.user_id = pc.user_id)))::int
  from r, c;
$$;

revoke all on function public.closure_tally(uuid) from public, anon, authenticated;

-- Internal: is a report with this standing still shown?
create or replace function public.closure_is_live(
  p_until date, p_confirmed_at timestamptz, p_supporters int, p_refuters int
)
returns boolean
language sql
stable
set search_path = public
as $$
  -- `current_date - 1` because the server runs on UTC and the card runs on the
  -- viewer's clock; the card drops a dated report precisely on its own side.
  select (case when p_until is null
               then p_confirmed_at >= now() - interval '10 days'
               else p_until >= current_date - 1 end)
     and p_refuters < p_supporters + 2;
$$;

revoke all on function public.closure_is_live(date, timestamptz, int, int) from public, anon, authenticated;

-- The card's read: live reports for one court that apply to the sport on screen
-- (that sport's, plus whole-facility ones). Hides reports by people you blocked.
create or replace function public.court_closures(p_court_id text, p_sport text)
returns table (
  id           uuid,
  sport        text,
  kind         text,
  until        date,
  note         text,
  created_at   timestamptz,
  confirmed_at timestamptz,
  supporters   int,
  refuters     int,
  my_vote      smallint,
  mine         boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.sport, r.kind, r.until, r.note, r.created_at,
         t.confirmed_at, t.supporters, t.refuters,
         (select v.vote from public.closure_votes v
          where v.report_id = r.id and v.user_id = auth.uid()),
         coalesce(r.user_id = auth.uid(), false)
  from public.closure_reports r
  cross join lateral public.closure_tally(r.id) t
  where r.court_id = p_court_id
    and (r.sport is null or r.sport = p_sport)
    and public.closure_is_live(r.until, t.confirmed_at, t.supporters, t.refuters)
    and not exists (select 1 from public.blocked_users b
                    where b.blocker_id = auth.uid() and b.blocked_id = r.user_id)
  order by t.confirmed_at desc
  limit 10;
$$;

-- Signed-out viewers see the banner too (reviews are public the same way).
revoke all on function public.court_closures(text, text) from public;
grant execute on function public.court_closures(text, text) to anon, authenticated;

-- File a report. One live report per scope (court + sport, or court + whole
-- facility): filing onto a scope that already has one supports it instead —
-- and fills in its end date if it had none — so a card never stacks banners.
-- Your own live report on the scope is updated in place.
create or replace function public.file_closure_report(
  p_court_id text,
  p_sport    text,
  p_kind     text,
  p_until    date,
  p_note     text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  v_note   text := nullif(btrim(coalesce(p_note, '')), '');
  v_id     uuid;
  v_owner  uuid;
  v_until  date;
begin
  if me is null then
    raise exception 'sign in to report a closure' using errcode = '42501';
  end if;
  if p_kind not in ('maintenance', 'closed', 'partial') then
    raise exception 'invalid closure kind';
  end if;
  if p_until is not null and (p_until < current_date - 1 or p_until > current_date + 180) then
    raise exception 'closure end date out of range';
  end if;
  if v_note is not null and char_length(v_note) > 140 then
    raise exception 'note too long';
  end if;
  if (select count(*) from public.closure_reports
      where user_id = me and created_at > now() - interval '1 day') >= 5 then
    raise exception 'too many closure reports today';
  end if;

  select r.id, r.user_id, r.until into v_id, v_owner, v_until
  from public.closure_reports r
  cross join lateral public.closure_tally(r.id) t
  where r.court_id = p_court_id
    and r.sport is not distinct from p_sport
    and public.closure_is_live(r.until, t.confirmed_at, t.supporters, t.refuters)
  order by (r.user_id = me) desc, t.supporters desc, t.confirmed_at desc
  limit 1;

  if v_id is not null then
    if v_owner = me then
      update public.closure_reports
        set kind = p_kind, until = p_until, note = v_note
        where id = v_id;
    else
      insert into public.closure_votes (report_id, user_id, vote)
        values (v_id, me, 1)
        on conflict (report_id, user_id) do update set vote = 1, voted_at = now();
      if v_until is null and p_until is not null then
        update public.closure_reports set until = p_until where id = v_id;
      end if;
    end if;
    return v_id;
  end if;

  insert into public.closure_reports (user_id, court_id, sport, kind, until, note)
    values (me, p_court_id, p_sport, p_kind, p_until, v_note)
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.file_closure_report(text, text, text, date, text) from public, anon;
grant execute on function public.file_closure_report(text, text, text, date, text) to authenticated;

-- Support (1), call incorrect (-1), or take your vote back (0). Reporters can't
-- vote on their own report — filing it was the support.
create or replace function public.vote_closure_report(p_report_id uuid, p_vote smallint)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'sign in to vote' using errcode = '42501';
  end if;
  if not exists (select 1 from public.closure_reports where id = p_report_id and user_id <> me) then
    raise exception 'report not found';
  end if;
  if p_vote = 0 then
    delete from public.closure_votes where report_id = p_report_id and user_id = me;
  elsif p_vote in (-1, 1) then
    insert into public.closure_votes (report_id, user_id, vote)
      values (p_report_id, me, p_vote)
      on conflict (report_id, user_id) do update set vote = excluded.vote, voted_at = now();
  else
    raise exception 'invalid vote';
  end if;
end;
$$;

revoke all on function public.vote_closure_report(uuid, smallint) from public, anon;
grant execute on function public.vote_closure_report(uuid, smallint) to authenticated;

-- Take back your own report (its votes go with it).
create or replace function public.remove_closure_report(p_report_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  delete from public.closure_reports where id = p_report_id and user_id = auth.uid();
$$;

revoke all on function public.remove_closure_report(uuid) from public, anon;
grant execute on function public.remove_closure_report(uuid) to authenticated;

-- Email each new closure report to the support inbox, the way 028 emails
-- content_reports: a closure is public the moment it's filed, so a person should
-- see it without opening the dashboard. Same Resend key and sender from Vault,
-- same "never fail the insert" wrapper; inert until resend_api_key exists.
-- Only inserts are emailed — a second report on a covered scope becomes a
-- support vote and sends nothing. Budget: at most 5 per reporter per hour (the
-- filing RPC already allows only 5 a day) and 50 closures a day.
create extension if not exists pg_net;

create or replace function public.email_closure_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  api_key  text;
  sender   text;
  by_them  int;
  today    int;
  app_link text;
  body     text;
begin
  begin
    select decrypted_secret into api_key from vault.decrypted_secrets where name = 'resend_api_key';
    if api_key is null or api_key = '' then
      return new;
    end if;
    select decrypted_secret into sender from vault.decrypted_secrets where name = 'report_email_from';

    select count(*) into by_them from public.closure_reports
      where user_id = new.user_id and created_at > now() - interval '1 hour';
    select count(*) into today from public.closure_reports
      where created_at > now() - interval '1 day';
    if by_them > 5 or today > 50 then
      return new;
    end if;

    app_link := 'https://playrecreate.com/?city='
      || case when new.court_id ~ '^nycp?-' then 'nyc' else 'sf' end
      || '&court=' || new.court_id
      || coalesce('&sport=' || new.sport, '');

    body := concat_ws(E'\n',
      'Kind: ' || new.kind,
      'Court: ' || new.court_id,
      'Scope: ' || coalesce(new.sport, 'whole facility'),
      'Until: ' || coalesce(to_char(new.until, 'YYYY-MM-DD'), 'not given'),
      case when new.note is not null then E'\n"' || new.note || E'"\n' end,
      'Open in app: ' || app_link,
      'Report id: ' || new.id,
      'Reporter id: ' || new.user_id,
      'Filed: ' || to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'),
      '',
      'This is already showing on the card. To take it down:',
      '  delete from public.closure_reports where id = ''' || new.id || ''';',
      case when today = 50 then E'\nThis is the 50th closure today — no more will be emailed until the count drops.' end
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
        'subject', '[RECreate] Closure reported: ' || left(new.court_id, 100)
          || ' · ' || coalesce(new.sport, 'whole facility'),
        'text', body
      )
    );
  exception when others then
    raise warning 'email_closure_report: % (closure % stored, not emailed)', sqlerrm, new.id;
  end;
  return new;
end;
$$;

revoke all on function public.email_closure_report() from public, anon, authenticated;

drop trigger if exists closure_reports_email on public.closure_reports;
create trigger closure_reports_email
  after insert on public.closure_reports
  for each row execute function public.email_closure_report();
