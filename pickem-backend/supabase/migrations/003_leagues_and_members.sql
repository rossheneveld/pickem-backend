-- leagues: one row per real league. Replaces the client-side `leagues` array
-- from the prototype. Passwords are never stored in plaintext and never
-- readable by any client — only the create-league and join-league Edge
-- Functions (using the service_role key) ever touch password_hash.

create extension if not exists pgcrypto; -- for gen_random_uuid() and crypto-safe invite codes

create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  sport text not null check (sport in ('nfl', 'ncaa')),
  visibility text not null check (visibility in ('public', 'private')),
  password_hash text, -- null for public leagues; bcrypt hash for private ones

  invite_code text not null unique, -- short shareable code, e.g. "7K2QRM"
  creator_id uuid not null references auth.users(id),

  season int not null,
  week int not null default 1,
  phase text not null default 'picking' check (phase in ('selecting', 'picking', 'revealing')),
  pot_carryover numeric not null default 0,

  created_at timestamptz not null default now()
);

create index if not exists leagues_visibility_idx on public.leagues (visibility);
create index if not exists leagues_creator_id_idx on public.leagues (creator_id);

-- league_members: who's in each league, and their running balance.
-- Rows are only ever inserted by the join-league / create-league Edge
-- Functions — never directly by a client — so membership can't be
-- forged or granted without going through the password check.
create table if not exists public.league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id),

  display_name text not null,
  balance numeric not null,
  alive boolean not null default true,
  is_creator boolean not null default false,

  joined_at timestamptz not null default now(),
  unique (league_id, user_id) -- can't join the same league twice
);

create index if not exists league_members_league_id_idx on public.league_members (league_id);
create index if not exists league_members_user_id_idx on public.league_members (user_id);

alter table public.leagues enable row level security;
alter table public.league_members enable row level security;

-- Anyone can see public leagues (for browsing). Private leagues are only
-- visible to people who are already members of them — so a private league
-- doesn't even appear in a browse/search list to non-members, and its
-- password_hash column is never exposed by this policy regardless (see below).
create policy "leagues visible if public or you're a member"
  on public.leagues for select
  to authenticated
  using (
    visibility = 'public'
    or exists (
      select 1 from public.league_members m
      where m.league_id = leagues.id and m.user_id = auth.uid()
    )
  );

-- Members can see the roster of any league they're in — needed for
-- standings, the points chart, and the Picks tab's "other players" view.
create policy "league_members visible to fellow members"
  on public.league_members for select
  to authenticated
  using (
    exists (
      select 1 from public.league_members m
      where m.league_id = league_members.league_id and m.user_id = auth.uid()
    )
  );

-- Deliberately NO insert/update policy on either table for regular users.
-- Creating a league happens through create-league (hashes the password).
-- Joining a league happens through join-league (checks the password).
-- Both use the service_role key, which bypasses RLS entirely — that's the
-- only path that's allowed to write here.

-- Never expose password_hash to any client-readable view, even for a
-- league's own creator, since the app never needs to read it back —
-- only compare against it, which only join-league does.
revoke select (password_hash) on public.leagues from authenticated, anon;
