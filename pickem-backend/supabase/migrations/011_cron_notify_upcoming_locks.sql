-- Every 10 minutes gives plenty of resolution for a 30-minute-lead reminder.
select cron.schedule(
  'notify-upcoming-locks-every-10min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://hoptqfccpxdcqhifwkjk.supabase.co/functions/v1/notify-upcoming-locks',
    headers := jsonb_build_object('Authorization', 'Bearer 134e73efe028bad5639d78d62c11222c24b4ad3629c13013fca77861af48d97a'),
    timeout_milliseconds := 20000
  );
  $$
);
