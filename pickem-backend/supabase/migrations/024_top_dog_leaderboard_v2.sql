-- Supersedes 023_top_dog_leaderboard.sql's definition (create or replace
-- view safely overwrites it whether or not 023 was already applied).
--
-- The denominator now counts a game if EITHER of these is true:
--   (a) the underdog actually won (an upset happened) — regardless of
--       what the user picked, including if they played it safe with the
--       favorite and missed it entirely
--   (b) the user picked the underdog — regardless of whether it won
--
-- This closes two separate ways the earlier version could be gamed or
-- could under-penalize: picking every underdog no longer inflates your
-- score (since most of those picks lose and now count against you), and
-- playing it safe with favorites no longer quietly avoids the penalty for
-- missing a real upset.
--
-- The numerator (a correct call) is always a subset of the denominator by
-- construction — if you correctly picked an underdog, that game is both
-- an actual upset AND a game where you picked the underdog, so it's
-- counted by either clause.

create or replace view public.top_dog_leaderboard as
with relevant_games as (
  select
    p.user_id,
    (p.team = gc.underdog and gc.winner = gc.underdog) as correct_underdog_call
  from public.picks p
  join public.league_games lg on lg.id = p.league_game_id
  join public.games_cache gc on gc.id = lg.game_id
  where gc.status = 'final'
    and gc.winner is not null
    and gc.underdog is not null
    and (
      gc.winner = gc.underdog  -- an upset happened, whatever they picked
      or p.team = gc.underdog  -- they picked the underdog, whatever happened
    )
)
select
  user_id,
  count(*) as total_underdog_opportunities,
  count(*) filter (where correct_underdog_call) as correct_underdog_calls,
  round(100.0 * count(*) filter (where correct_underdog_call) / count(*), 1) as top_dog_percentage
from relevant_games
group by user_id;