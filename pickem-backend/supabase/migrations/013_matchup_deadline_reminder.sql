alter table public.league_weeks
  add column if not exists selection_reminder_sent_at timestamptz;

create index if not exists league_weeks_selection_reminder_idx
  on public.league_weeks (selection_reminder_sent_at) where selection_reminder_sent_at is null;
