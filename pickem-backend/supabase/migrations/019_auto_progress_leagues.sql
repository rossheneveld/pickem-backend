-- Every 5 minutes is enough resolution to catch a week finishing shortly
-- after it actually does, without being wasteful — this only does real
-- work for leagues whose week just became fully final; everything else is
-- a handful of cheap, empty checks.
select cron.schedule(
  'auto-progress-leagues-every-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hoptqfccpxdcqhifwkjk.supabase.co/functions/v1/auto-progress-leagues',
    headers := jsonb_build_object('Authorization', 'Bearer 134e73efe028bad5639d78d62c11222c24b4ad3629c13013fca77861af48d97a'),
    timeout_milliseconds := 30000
  );
  $$
);