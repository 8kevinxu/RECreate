-- RECreate — SECURITY hardening for existing databases.
-- Locks down two SECURITY DEFINER functions that were left callable by clients
-- (Postgres grants EXECUTE to PUBLIC by default). Both are only ever meant to be
-- called internally by the notify_* triggers, which run as the function owner and
-- are therefore unaffected by these revokes.
--
--   • send_push(...)          — a direct rpc() caller could send arbitrary Expo
--                               push notifications to ANY user with a device token
--                               (bypasses device_tokens RLS) — phishing/spam.
--   • accepted_friend_ids(..) — a direct rpc() caller could dump ANY user's friend
--                               list (bypasses friendships RLS) — privacy leak.
--
-- Safe to run repeatedly. Apply once against an existing DB; fresh DBs get this
-- from schema/07_push.sql directly.

revoke all on function public.send_push(uuid[], text, text, jsonb) from public, anon, authenticated;
revoke all on function public.accepted_friend_ids(uuid) from public, anon, authenticated;
