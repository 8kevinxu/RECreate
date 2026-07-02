-- Harden send_push: send one request PER TOKEN instead of one batched request
-- for all tokens. Expo rejects an entire request that mixes tokens from
-- different projects / experience IDs (PUSH_TOO_MANY_EXPERIENCE_IDS), and any
-- single invalid token can fail a batch — so batching lets one bad token silence
-- a whole broadcast. Per-token, each send is independent.
--
-- Idempotent: safe to re-run. Apply on an existing DB that already has 07_push.sql.

create or replace function public.send_push(
  recipient_ids uuid[],
  title text,
  body text,
  data jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  tok text;
begin
  if recipient_ids is null or array_length(recipient_ids, 1) is null then
    return;
  end if;

  for tok in
    select distinct dt.token
    from public.device_tokens dt
    where dt.user_id = any (recipient_ids)
  loop
    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'to', tok,
        'title', title,
        'body', body,
        'data', coalesce(data, '{}'::jsonb),
        'sound', 'default'
      )
    );
  end loop;
end;
$$;

-- Preserve the lock-down (create or replace keeps grants, but re-assert to be safe).
revoke all on function public.send_push(uuid[], text, text, jsonb) from public, anon, authenticated;
