-- Class-category interests on the profile (fitness, dance, music, arts, photo,
-- social) — alongside favorite_sports, these drive the "recommended for you"
-- pane and interest-based suggestions. Idempotent.
alter table public.profiles
  add column if not exists favorite_categories text[];
