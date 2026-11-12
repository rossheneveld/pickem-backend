-- Tracks which (league_week, date) combinations have already had their
-- 8am game-day reminder sent. The unique constraint does the real
-- idempotency work: an insert attempt for an already-sent combination
-- fails with a conflict, which the function treats as "nothing more to
-- do" rather than an error.
create table if not exists public.game_day_reminders_sent (
  id uuid primary key default gen_random_uuid(),
  league_week_id uuid not null references public.league_weeks(id) on delete cascade,
  reminder_date date not null,
  sent_at timestamptz not null default now(),
  unique (league_week_id, reminder_date)
);

-- Only Edge Functions (service role, which bypasses RLS) ever touch this
-- table. Row level security with no policies keeps it closed to everyone
-- else — without it, anyone holding the app's public key could read,
-- insert or delete rows through the API, e.g. to silence reminders.
-- (An earlier draft of this migration left this out.)
alter table public.game_day_reminders_sent enable row level security;

-- Runs every 15 minutes, every day — but the function itself only does
-- real work during the 8:00-8:44 AM ET window, checked in Eastern Time
-- rather than a fixed UTC cron time, which would drift an hour across the
-- November DST change (same class of bug fixed earlier in sync-live-scores).
--
-- The job's command is copied from the existing notify-upcoming-locks job
-- with the function name swapped, so it picks up the real project URL and
-- cron secret already in use — nothing to fill in by hand, and no
-- placeholder that could ever be scheduled by mistake. If no
-- notify-upcoming-locks job exists, this selects no rows and schedules
-- nothing. Safe to run more than once (scheduling by an existing name
-- replaces that job).
select cron.schedule(
  'notify-game-day-every-15min',
  '*/15 * * * *',
  replace(command, 'functions/v1/notify-upcoming-locks', 'functions/v1/notify-game-day')
)
from cron.job
where command like '%functions/v1/notify-upcoming-locks%'
limit 1;