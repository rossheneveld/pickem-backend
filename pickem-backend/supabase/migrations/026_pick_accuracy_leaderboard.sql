-- Global "best overall pick accuracy" leaderboard — the cross-league
-- counterpart to top_dog_leaderboard (024), same idea applied to plain
-- win rate instead of underdog-calling specifically.
--
-- Only decided picks (outcome 'win' or 'loss') count in either the
-- numerator or denominator — same reasoning as the per-league accuracy
-- leaderboard already built: a push isn't a clear right-or-wrong call, and
-- a pick whose game hasn't been scored yet shouldn't drag the percentage
-- down while its outcome is still unknown. GROUP BY only produces a row
-- for users with at least one decided pick, so there's no division-by-zero
-- case to guard against — a user with zero decided picks simply doesn't
-- appear in the view at all.

create or replace view public.pick_accuracy_leaderboard as
select
  user_id,
  count(*) as total_decided_picks,
  count(*) filter (where outcome = 'win') as correct_picks,
  round(100.0 * count(*) filter (where outcome = 'win') / count(*), 1) as pick_accuracy_percentage
from public.picks
where outcome in ('win', 'loss')
group by user_id;