-- Runs every minute, every day (locks can happen any time, unlike scores
-- which only move on game days) — but each run is cheap: it only does work
-- for games that just crossed their lock threshold since the last run.
select cron.schedule(
  'touch-locked-picks-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://hoptqfccpxdcqhifwkjk.supabase.co/functions/v1/touch-locked-picks',
    headers := jsonb_build_object('Authorization', 'Bearer 134e73efe028bad5639d78d62c11222c24b4ad3629c13013fca77861af48d97a'),
    timeout_milliseconds := 15000
  );
  $$
);
