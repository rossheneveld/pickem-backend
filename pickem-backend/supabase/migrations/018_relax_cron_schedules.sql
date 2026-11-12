-- 1. Reactivate sync-schedule-odds — it was intentionally paused earlier
-- tonight to protect a manual test-data change from being overwritten, and
-- was never turned back on. Left this way, schedule/odds data would simply
-- stop updating forever, silently.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-schedule-odds-every-3h'),
  active => true
);

-- 2. Relax sync-schedule-odds from every 3 hours to every 6. With the real
-- season still a week and a half out, odds for upcoming weeks are being
-- published gradually rather than changing minute-to-minute — 4x/day is
-- still plenty to catch newly-posted lines promptly.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-schedule-odds-every-3h'),
  schedule => '0 */6 * * *'
);

-- 3. Relax sync-live-scores from every 5 minutes to every 15, still only on
-- game days. There's minimal live action to track this far before the real
-- season, and this alone cuts that job's credit usage to roughly a third.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'sync-live-scores-gameday-every-5min'),
  schedule => '*/15 * * * 0,1,4,6'
);

-- NOTE: worth revisiting once the real season starts — every 5 minutes for
-- live scores during actual game windows gives a noticeably snappier
-- experience than every 15, and the 20k/month plan has plenty of headroom
-- for that once there's real, frequent game action to justify it.