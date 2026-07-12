-- Push a notification when a friend request ARRIVES (pending insert). Before
-- this only the acceptance pushed (notify_friend_accepted), so an incoming
-- request sat invisible until the addressee happened to open Profile → Friends.
-- Tapping the push opens the Friends sheet (data.type = 'friend', same deep
-- link as the acceptance push). Folded into schema/07_push.sql.
--
-- Note: adding someone who already requested YOU auto-accepts (an UPDATE, not
-- an INSERT), so that path fires the acceptance trigger — never both.

create or replace function public.notify_friend_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare requester_name text;
begin
  if new.status <> 'pending' then return new; end if;
  select display_name into requester_name from public.profiles where id = new.requester;
  perform public.send_push(
    array[new.addressee],
    coalesce(requester_name, 'Someone') || ' sent you a friend request 👋',
    'Open Friends to accept',
    jsonb_build_object('type', 'friend')
  );
  return new;
end; $$;
drop trigger if exists friendships_request_notify on public.friendships;
create trigger friendships_request_notify after insert on public.friendships
  for each row execute function public.notify_friend_request();
