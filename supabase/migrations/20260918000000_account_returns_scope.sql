-- The XIRR scope lived in localStorage, so it followed the browser rather than
-- the account. Two devices could hold different scopes and report different
-- returns for the same portfolio — not a display difference, different maths,
-- because the scope decides which cash flows are counted at all.
--
-- It belongs on the profile, where the lock PIN already sits, with the local
-- copy kept as a cache so the tab still renders at once and works offline.
alter table public.worthdelta_profiles
  add column if not exists returns_scope jsonb;
