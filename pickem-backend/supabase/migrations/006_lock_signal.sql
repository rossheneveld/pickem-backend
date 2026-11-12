-- Realtime only fires on actual row changes — it can't notify anyone that
-- time has passed and a time-based RLS condition (picks.kickoff - 5min <=
-- now()) has newly become true, because nothing about the row changed.
--
-- locked_notified_at solves this: the touch-locked-picks function (see
-- ../functions/touch-locked-picks) sets it exactly once, the moment a game
-- crosses its lock threshold. That write IS a real change event, which
-- Realtime delivers to every subscribed league member — who then know to
-- go re-fetch that game's picks, which RLS now permits them to see.

alter table public.league_games
  add column if not exists locked_notified_at timestamptz;

-- Lets touch-locked-picks efficiently find "games that just locked and
-- haven't been signaled yet" without scanning every league_game every run.
create index if not exists league_games_locked_notified_idx
  on public.league_games (locked_notified_at) where locked_notified_at is null;

alter publication supabase_realtime add table public.league_games;
