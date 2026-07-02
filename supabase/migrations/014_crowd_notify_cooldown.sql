-- Rate-limit crowd-update pushes. Reporting a court's crowd level inserts a
-- check-in that pushes to the voter's friends; spam-tapping / switching levels
-- (which inserts a new row and deletes the old each time) sent a push per tap.
-- Add a per-voter-per-court cooldown log and gate notify_crowd on it: at most one
-- crowd push per voter+court per 10 minutes.
--
-- Idempotent: safe to re-run. Apply on an existing DB that already has 07_push.sql.

create table if not exists public.crowd_notify_log (
  voter_id uuid        not null references public.profiles (id) on delete cascade,
  court_id text        not null,
  sent_at  timestamptz not null default now(),
  primary key (voter_id, court_id)
);
alter table public.crowd_notify_log enable row level security;
-- No policies: clients get no access; only the SECURITY DEFINER trigger (owner) writes it.

create or replace function public.notify_crowd()
returns trigger language plpgsql security definer set search_path = public as $$
declare voter uuid; who text; recipients uuid[]; level_word text; last_sent timestamptz;
begin
  voter := auth.uid();
  if not new.notify or voter is null then return new; end if;

  select sent_at into last_sent from public.crowd_notify_log
    where voter_id = voter and court_id = new.court_id;
  if last_sent is not null and last_sent > now() - interval '10 minutes' then
    return new;
  end if;
  insert into public.crowd_notify_log (voter_id, court_id, sent_at)
    values (voter, new.court_id, now())
    on conflict (voter_id, court_id) do update set sent_at = excluded.sent_at;

  select display_name into who from public.profiles where id = voter;
  select array_agg(fid) into recipients
  from public.accepted_friend_ids(voter) as fid;
  level_word := case new.level
    when 'empty'    then 'wide open 🟢'
    when 'moderate' then 'moderately busy 🟡'
    else                 'packed 🔴' end;
  perform public.send_push(
    recipients,
    coalesce(who, 'A friend') || ' shared a crowd update 👀',
    'A court looks ' || level_word || ' — tap to see',
    jsonb_build_object('type', 'crowd', 'courtId', new.court_id)
  );
  return new;
end; $$;
