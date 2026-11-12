-- Every 5 minutes is plenty — a missed 12pm ET Monday deadline being
-- enforced a few minutes late is a non-issue in practice.
select cron.schedule(
  'auto-select-expired-matchups-every-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://hoptqfccpxdcqhifwkjk.supabase.co/functions/v1/auto-select-expired-matchups',
    headers := jsonb_build_object('Authorization', 'Bearer 134e73efe028bad5639d78d62c11222c24b4ad3629c13013fca77861af48d97a'),
    timeout_milliseconds := 15000
  );
  $$
);
