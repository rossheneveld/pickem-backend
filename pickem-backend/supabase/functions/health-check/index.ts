// supabase/functions/health-check/index.ts
//
// One URL to monitor instead of seven. Point a free external uptime
// monitor (UptimeRobot's free tier works well) at this endpoint, checking
// every 5 minutes. Returns 200 if every scheduled job has reported a
// successful run within its own expected interval (plus a grace window),
// and 503 the moment any single one hasn't — which is exactly what
// triggers an alert email from most uptime monitors.
//
// Deploy: supabase functions deploy health-check --no-verify-jwt
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Extra buffer beyond a job's own expected interval before flagging it —
// avoids false alarms from a job that's merely running a couple minutes
// late, while still catching genuine failures promptly.
const GRACE_MINUTES = 10;

Deno.serve(async (_req) => {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: jobs, error } = await admin.from("job_health").select("job_name, last_success_at, expected_interval_minutes");
  if (error) {
    return new Response(JSON.stringify({ healthy: false, error: error.message }), { status: 503 });
  }

  const now = Date.now();
  const results = (jobs ?? []).map((job) => {
    const lastSuccess = new Date(job.last_success_at).getTime();
    const maxAgeMs = (job.expected_interval_minutes + GRACE_MINUTES) * 60 * 1000;
    const ageMinutes = Math.round((now - lastSuccess) / 60000);
    return {
      job: job.job_name,
      healthy: now - lastSuccess <= maxAgeMs,
      lastSuccessMinutesAgo: ageMinutes,
      expectedIntervalMinutes: job.expected_interval_minutes,
    };
  });

  const allHealthy = results.every((r) => r.healthy);

  return new Response(JSON.stringify({ healthy: allHealthy, jobs: results }), {
    status: allHealthy ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
});