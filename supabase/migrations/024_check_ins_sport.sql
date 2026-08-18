-- Crowd check-ins become per-sport.
--
-- A court id is a whole facility: Miraloma Playground is one pin carrying a gym,
-- tennis courts and a ball diamond. Check-ins were keyed by court alone, so
-- reporting the hoops "packed" marked the tennis courts and the diamond packed
-- too — on the pin, on the card, and in the push to friends. Add the sport the
-- report is about and scope everything (reads, the one-vote-per-device toggle,
-- the push cooldown) to court+sport.
--
-- `sport` is nullable: rows written before this ran are genuinely pin-wide, and
-- the client still shows them under every sport until they age out of its 24h
-- window. Length-capped only (like 020), never an enum, so a new sport in
-- lib/sports.js never needs a migration.
--
-- Idempotent: safe to re-run. Folded into schema/01_crowd_check_ins.sql + 07_push.sql.

alter table public.check_ins add column if not exists sport text;

alter table public.check_ins drop constraint if exists check_ins_sport_len;
alter table public.check_ins add constraint check_ins_sport_len
  check (sport is null or char_length(sport) <= 40);

-- Reads are now "recent check-ins for this court + sport".
create index if not exists check_ins_court_sport_time_idx
  on public.check_ins (court_id, sport, created_at desc);
drop index if exists check_ins_court_time_idx;

-- The crowd-push cooldown gets the same treatment: reporting the gym packed and
-- the tennis courts empty are two different facts, and the 10-minute window must
-- not swallow the second. Existing rows take '' (they expire in 10 min anyway).
alter table public.crowd_notify_log add column if not exists sport text not null default '';
alter table public.crowd_notify_log drop constraint if exists crowd_notify_log_pkey;
alter table public.crowd_notify_log add primary key (voter_id, court_id, sport);

-- Recreate the crowd push: cooldown keyed by sport, and the body names what was
-- reported ("A basketball court looks packed") instead of an ambiguous "A court".
create or replace function public.notify_crowd()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  voter uuid; who text; recipients uuid[];
  level_word text; sport_word text; last_sent timestamptz;
begin
  voter := auth.uid();
  if not new.notify or voter is null then return new; end if;

  select sent_at into last_sent from public.crowd_notify_log
    where voter_id = voter and court_id = new.court_id
      and sport = coalesce(new.sport, '');
  if last_sent is not null and last_sent > now() - interval '10 minutes' then
    return new;
  end if;
  insert into public.crowd_notify_log (voter_id, court_id, sport, sent_at)
    values (voter, new.court_id, coalesce(new.sport, ''), now())
    on conflict (voter_id, court_id, sport) do update set sent_at = excluded.sent_at;

  select display_name into who from public.profiles where id = voter;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(voter) as fid;
  level_word := case new.level
    when 'empty'    then 'wide open 🟢'
    when 'moderate' then 'moderately busy 🟡'
    else                 'packed 🔴' end;
  -- Not every tracked sport is played on a "court" (and an unknown/absent sport
  -- falls back to the old wording rather than inventing a noun).
  sport_word := case coalesce(new.sport, '')
    when ''           then 'court'
    when 'any'        then 'court'
    when 'pingpong'   then 'ping pong table'
    when 'weightroom' then 'weight room'
    when 'swimming'   then 'pool'
    when 'golf'       then 'golf course'
    when 'soccer'     then 'soccer field'
    when 'baseball'   then 'ball field'
    else new.sport || ' court' end;
  perform public.send_push(
    recipients,
    coalesce(who, 'A friend') || ' shared a crowd update 👀',
    'A ' || sport_word || ' looks ' || level_word || ' — tap to see',
    jsonb_build_object('type', 'crowd', 'courtId', new.court_id, 'sport', new.sport)
  );
  return new;
end; $$;
