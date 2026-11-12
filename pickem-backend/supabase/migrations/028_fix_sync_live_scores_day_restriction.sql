-- Fixes a real, meaningful gap: sync-live-scores only ran on UTC days
-- 0,1,4,6 (Sun/Mon/Thu/Sat), on the assumption those match real NFL/NCAA
-- game days. They don't, reliably — UTC calendar days and US game days
-- diverge for any evening kickoff. A game kicking off at 8:20 PM ET is
-- already 00:20 UTC the NEXT calendar day; its kickoff, and likely its
-- entire duration, fall on a UTC day that was never in the covered set at
-- all, despite being an ordinary Monday-night game to everyone watching
-- it. This isn't a narrow edge case — most primetime evening games (the
-- most-watched games of any given week) kick off late enough in ET to
-- cross this exact boundary.
--
-- Trying to patch this by adding a couple more UTC days back is the wrong
-- shape of fix — it's still guessing at a mapping that doesn't hold
-- reliably. Removing the day restriction entirely means every real game,
-- regardless of what UTC day its kickoff or finish happens to land on,
-- gets tracked correctly.
--
-- Honest tradeoff, not a free fix: this function calls the external odds
-- API unconditionally on every run, for both sports, regardless of
-- whether anything is actually live — it only skips individual games
-- within that response, not the API call itself. Going from ~4 covered
-- days/week to 7 raises this function's own usage by roughly 75%, to
-- somewhere around 5,800 calls/month. Against a 20k/month plan, that's a
-- real but affordable share (~29%), still leaving comfortable room for
-- sync-schedule-odds and everything else — but it's a genuine cost, not
-- a rounding error, and worth knowing precisely rather than assuming
-- it's negligible.

select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-live-scores-gameday-every-5min'),
  schedule => '*/15 * * * *'
);