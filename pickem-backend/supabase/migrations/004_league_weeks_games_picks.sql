-- league_weeks: one row per (league, week). This is the natural home for
-- anything that's true about a specific week of a specific league — not
-- just "current state" (which `leagues.week`/`leagues.phase` already track
-- for fast lookups) but HISTORY: was week 3 already scored? What was the
-- pot before/after that week? When does NCAA matchup selection close?
--
-- `scored_at` doubles as the idempotency guard the future reveal-week
-- function needs: "have I already scored this week" is just "is scored_at
-- null", with no separate locking mechanism required.
create table if not exists public.league_weeks (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  week int not null,

  phase text not null default 'picking' check (phase in ('selecting', 'picking', 'revealed')),

  -- NCAA only: when auto-randomize kicks in if the creator hasn't confirmed
  matchup_selection_deadline timestamptz,

  pot_before numeric not null default 0,
  pot_after numeric, -- null until this week is scored

  scored_at timestamptz, -- null until reveal-week has run for this week

  created_at timestamptz not null default now(),
  unique (league_id, week)
);

create index if not exists league_weeks_league_id_idx on public.league_weeks (league_id);

-- league_games: which real games (from games_cache) a league is actually
-- playing in a given week. For NFL this is auto-populated with that week's
-- full slate. For NCAA it's whichever 15 the creator picked (or the
-- auto-randomizer picked for them) from the candidate pool.
create table if not exists public.league_games (
  id uuid primary key default gen_random_uuid(),
  league_week_id uuid not null references public.league_weeks(id) on delete cascade,
  game_id uuid not null references public.games_cache(id),

  created_at timestamptz not null default now(),
  unique (league_week_id, game_id)
);

create index if not exists league_games_league_week_id_idx on public.league_games (league_week_id);
create index if not exists league_games_game_id_idx on public.league_games (game_id);

-- picks: one row per (league_game, user). `team` and `points` are both
-- nullable — a row can exist (created the moment a user first touches a
-- game) before either is finalized. A null `team` at scoring time (once
-- that league_game's kickoff has passed) is exactly what "forfeited" means
-- — computed at scoring time, not stored as a separate flag. This is
-- deliberately simpler than the prototype's live auto-forfeit timer: the
-- server doesn't need to "notice" a lock passing, it just checks kickoff
-- against now() whenever it actually needs the answer.
create table if not exists public.picks (
  id uuid primary key default gen_random_uuid(),
  league_game_id uuid not null references public.league_games(id) on delete cascade,
  user_id uuid not null references auth.users(id),

  team text,
  points numeric,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_game_id, user_id)
);

create index if not exists picks_league_game_id_idx on public.picks (league_game_id);
create index if not exists picks_user_id_idx on public.picks (user_id);

alter table public.league_weeks enable row level security;
alter table public.league_games enable row level security;
alter table public.picks enable row level security;

-- league_weeks / league_games: visible to fellow league members only,
-- same membership pattern as league_members itself.
create policy "league_weeks visible to members"
  on public.league_weeks for select
  to authenticated
  using (
    exists (
      select 1 from public.league_members m
      where m.league_id = league_weeks.league_id and m.user_id = auth.uid()
    )
  );

create policy "league_games visible to members"
  on public.league_games for select
  to authenticated
  using (
    exists (
      select 1 from public.league_weeks w
      join public.league_members m on m.league_id = w.league_id
      where w.id = league_games.league_week_id and m.user_id = auth.uid()
    )
  );

-- picks: the actual lock-timing rule, enforced by Postgres, not app code.
--
-- SELECT: always visible to the pick's own owner. Visible to a FELLOW
-- LEAGUE MEMBER only once that specific game's kickoff is within 5 minutes
-- (i.e. already locked) — this is the exact same "picks become visible once
-- locked" rule as the prototype, just enforced where it can't be bypassed
-- by a buggy or malicious client.
create policy "picks visible to owner always, to members once locked"
  on public.picks for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.league_games lg
      join public.league_weeks w on w.id = lg.league_week_id
      join public.league_members m on m.league_id = w.league_id
      join public.games_cache gc on gc.id = lg.game_id
      where lg.id = picks.league_game_id
        and m.user_id = auth.uid()
        and gc.kickoff - interval '5 minutes' <= now()
    )
  );

-- INSERT/UPDATE: only the pick's own owner, and only while the game is
-- still open (kickoff more than 5 minutes away). Once locked, this WITH
-- CHECK blocks any further write — there is no server-side "undo the lock"
-- path, matching the prototype's behavior exactly.
create policy "owner can write picks before lock"
  on public.picks for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.league_games lg
      join public.league_weeks w on w.id = lg.league_week_id
      join public.league_members m on m.league_id = w.league_id
      join public.games_cache gc on gc.id = lg.game_id
      where lg.id = picks.league_game_id
        and m.user_id = auth.uid()
        and gc.kickoff - interval '5 minutes' > now()
    )
  );

create policy "owner can update picks before lock"
  on public.picks for update
  to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.league_games lg
      join public.games_cache gc on gc.id = lg.game_id
      where lg.id = picks.league_game_id
        and gc.kickoff - interval '5 minutes' > now()
    )
  );

-- NOTE ON SCOPE: this RLS deliberately only enforces WHO can see/write a
-- pick and WHEN — not whether someone's total points wagered across a week
-- add up to their balance. That validation (matching the prototype's
-- "points available" logic, plus the "leftover forfeited to pot" rule) is
-- the reveal-week scoring function's job, not an access-control concern —
-- a client could technically write an invalid point total, and reveal-week
-- is the authoritative place that reconciles it, the same way it's the only
-- authoritative place results get computed at all.

-- Enable Realtime on picks so league members' screens update live as picks
-- become visible (once you run this, also toggle "Realtime" on for this
-- table in the Supabase Dashboard, or use `alter publication supabase_realtime add table public.picks;`)
alter publication supabase_realtime add table public.picks;
