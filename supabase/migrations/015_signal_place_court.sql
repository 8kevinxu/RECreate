-- RECreate — let the "down to play" creator optionally seed a location preference
-- up front: an indoor/outdoor preference and/or a specific court. Both are nullable
-- — blank means "let friends decide" (the existing suggest/confirm flow still
-- applies). Mirrors the map's Indoor/Outdoor + court filters into the signal
-- composer. See lib/signals.js and components/SignalModal.js.
alter table public.rec_signals
  add column if not exists place         text,   -- 'indoor' | 'outdoor' | null (either)
  add column if not exists pref_court_id text;   -- creator's preferred court (matches data/courts.js ids) | null
