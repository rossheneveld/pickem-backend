-- Powers basic monitoring: each scheduled function records its own
-- successful completion here. A single aggregating endpoint (see
-- health-check) then reports whether ANY job has gone quiet longer than
-- expected — one thing to point an external monitor at, not seven.

create table if not exists public.job_health (
  job_name text primary key,
  last_success_at timestamptz not null default now(),
  expected_interval_minutes int not null
);

-- Service role only — this is written to by the functions themselves
-- (via the service-role client they already use), never by end users.
alter table public.job_health enable row level security;

revoke all on public.job_health from anon, authenticated;