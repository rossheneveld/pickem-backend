create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  token text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, token) -- a user can have multiple tokens (multiple devices)
);

alter table public.push_tokens enable row level security;

create policy "users manage their own push tokens"
  on public.push_tokens for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Idempotency guard for the pick-lock reminder job, same pattern as
-- league_games.locked_notified_at.
alter table public.league_games
  add column if not exists lock_reminder_sent_at timestamptz;

create index if not exists league_games_lock_reminder_idx
  on public.league_games (lock_reminder_sent_at) where lock_reminder_sent_at is null;
