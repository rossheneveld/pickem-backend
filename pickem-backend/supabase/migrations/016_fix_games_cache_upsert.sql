-- Fixes: "there is no unique or exclusion constraint matching the ON
-- CONFLICT specification" — thrown by every call to
-- games_cache.upsert(rows, { onConflict: "odds_api_event_id" }).
--
-- The original index was PARTIAL (`where odds_api_event_id is not null`),
-- and Postgres requires an upsert's ON CONFLICT target to exactly match an
-- existing constraint/index, predicate included. A plain `ON CONFLICT
-- (odds_api_event_id)` — which is what a normal .upsert() call generates —
-- does not match a partial index, even though the columns are the same.
--
-- The partial condition was unnecessary in the first place: Postgres
-- already treats every NULL as distinct from every other NULL under a
-- plain UNIQUE constraint, so multiple NULL odds_api_event_id rows were
-- never actually going to conflict with each other anyway.

drop index if exists public.games_cache_odds_api_event_id_key;

alter table public.games_cache
  add constraint games_cache_odds_api_event_id_key unique (odds_api_event_id);