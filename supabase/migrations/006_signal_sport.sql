-- Add a sport to "down to hoop" signals so the composer can pick one (basketball,
-- volleyball, etc.). Existing rows default to basketball. Idempotent.
alter table public.rec_signals
  add column if not exists sport text not null default 'basketball';
