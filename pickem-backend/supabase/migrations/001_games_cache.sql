-- games_cache: the single source of truth for schedule + odds + scores.
-- Every league in the app reads from THIS table. Nothing in the app ever
-- calls The Odds API or API-Sports directly — only the two sync functions
-- (sync-schedule-odds, sync-live-scores) do that, on a fixed schedule.
--
-- This is the architectural piece that keeps cost flat as league count grows:
-- 10 leagues or 10,000 leagues generate the exact same number of calls to the
-- external APIs, because they're all reading the same cached rows.

create table if not exists public.games_cache (
  id uuid primary key default gen_random_uuid(),

  -- Which real-world sport/season/week this game belongs to
  sport text not null check (sport in ('nfl', 'ncaa')),
  season int not null,
  week int not null,

  -- External identifiers, so re-syncing updates the same row instead of duplicating it
  odds_api_event_id text,        -- The Odds API's event id
  sports_api_game_id text,       -- API-Sports' game id

  -- Matchup
  team_home text not null,
  team_away text not null,
  favorite text,                 -- null until odds are available
  underdog text,
  spread numeric(4,1),           -- e.g. 6.5

  kickoff timestamptz not null,

  -- Live/final state — populated by sync-live-scores, null until the game starts
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'final')),
  score_home int,
  score_away int,
  winner text,                   -- team name, or 'TIE'

  odds_updated_at timestamptz,
  score_updated_at timestamptz,
  created_at timestamptz not null default now()
);

-- The app's main read pattern: "give me this week's games for this sport"
create index if not exists games_cache_sport_season_week_idx
  on public.games_cache (sport, season, week);

-- Sync jobs need to quickly find games that are live/about to start, to know
-- which ones need frequent score polling vs. which can wait
create index if not exists games_cache_kickoff_status_idx
  on public.games_cache (kickoff, status);

-- Prevents the sync job from ever creating duplicate rows for the same real game
create unique index if not exists games_cache_odds_api_event_id_key
  on public.games_cache (odds_api_event_id) where odds_api_event_id is not null;

alter table public.games_cache enable row level security;

-- Every authenticated user can READ the cache (it's shared, public sports data —
-- there's nothing league-specific or private in this table)
create policy "games_cache readable by authenticated users"
  on public.games_cache for select
  to authenticated
  using (true);

-- Nothing except the sync functions (using the service_role key, which bypasses
-- RLS entirely) should ever write to this table — no INSERT/UPDATE policy for
-- regular users is intentional.
