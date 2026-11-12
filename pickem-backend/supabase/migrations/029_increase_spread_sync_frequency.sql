-- The 6-hour sync interval was too infrequent to reliably capture the true
-- closing line — a real, verified issue: 6 games in NCAA week 1 had spreads
-- off by 2+ points from the actual closing line, with 2 of those having
-- the wrong favorite entirely. Betting lines move meaningfully in the
-- hours before kickoff (injury news, weather, betting action); a 6-hour
-- gap could leave the stored spread almost 6 hours stale relative to what
-- the line actually closed at — more than enough time for a 2+ point move,
-- occasionally enough to cross zero and flip the favorite.
--
-- Honest tradeoff, not a free fix: going from every 6 hours to every 30
-- minutes is a 12x increase in this function's own call volume. At ~240
-- calls/month before, this goes to roughly 2,880/month. Combined with the
-- sync-live-scores day-restriction fix from migration 028 (~5,800/month on
-- its own), total usage lands somewhere around 9,000-10,000/month against
-- the 20k/month plan — comfortably under half, with real headroom left,
-- but a genuine, non-trivial cost worth knowing precisely rather than
-- assuming it's negligible.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-schedule-odds-every-3h'),
  schedule => '*/30 * * * *'
);