-- A league created partway through a season now starts on whatever the
-- real current week actually is (see create-league), not hardcoded week 1.
-- That means "is this the league's first week" can no longer be checked via
-- `week = 1` — a league whose real first week is, say, week 5 would
-- otherwise wrongly skip the "Week 1 is fixed at 10 points" rule for what
-- is, for that league, genuinely its first-ever week.

alter table public.leagues
  add column if not exists starting_week int;

-- Backfill: every league created before this migration was, in fact,
-- created with week hardcoded to 1 — so this backfill is accurate, not a guess.
update public.leagues set starting_week = 1 where starting_week is null;

alter table public.leagues
  alter column starting_week set not null,
  alter column starting_week set default 1;