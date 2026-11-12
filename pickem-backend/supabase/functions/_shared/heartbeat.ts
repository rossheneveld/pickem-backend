// One line added to each scheduled function's success path records that
// it actually ran — powers the single aggregating health-check endpoint
// instead of needing seven separate external monitors.
export async function recordHeartbeat(admin: any, jobName: string, expectedIntervalMinutes: number) {
  await admin.from("job_health").upsert({
    job_name: jobName,
    last_success_at: new Date().toISOString(),
    expected_interval_minutes: expectedIntervalMinutes,
  });
}