-- Each function below wraps a set of writes that were previously done as
-- several separate PostgREST calls from an Edge Function — meaning a crash
-- or network blip partway through could leave things half-updated. A
-- single plpgsql function call is one real Postgres transaction: it either
-- fully applies or fully rolls back, with no partial-write state possible.
--
-- SECURITY: `security definer` makes each function run with the DB owner's
-- privileges (bypassing RLS) regardless of who calls it — so execute
-- privileges are explicitly locked down to service_role only. A regular
-- authenticated user calling one of these directly would otherwise be able
-- to write arbitrary scores/balances, which is exactly what RLS on the
-- underlying tables is supposed to prevent.

-- ============================================================
-- reveal_week_commit — used by reveal-week
-- ============================================================
create or replace function public.reveal_week_commit(
  p_league_id uuid,
  p_league_week_id uuid,
  p_pot_after numeric,
  p_pick_updates jsonb,   -- [{league_game_id, user_id, outcome, shares, bonus_points, points_delta}]
  p_member_updates jsonb  -- [{member_id, balance, alive}]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already_scored timestamptz;
  pick_row jsonb;
  member_row jsonb;
begin
  -- Lock the row and re-check idempotency INSIDE the transaction. This is
  -- the actual fix for the race the Edge Function's earlier check alone
  -- couldn't close: two concurrent reveal-week calls could both pass a
  -- pre-check before either had written anything. Only one caller can hold
  -- this lock at a time; the second sees scored_at already set and aborts.
  select scored_at into v_already_scored
  from public.league_weeks
  where id = p_league_week_id
  for update;

  if v_already_scored is not null then
    raise exception 'league_week % already scored', p_league_week_id;
  end if;

  for pick_row in select * from jsonb_array_elements(p_pick_updates)
  loop
    update public.picks
    set
      outcome = pick_row->>'outcome',
      shares = (pick_row->>'shares')::numeric,
      bonus_points = (pick_row->>'bonus_points')::numeric,
      points_delta = (pick_row->>'points_delta')::numeric,
      updated_at = now()
    where league_game_id = (pick_row->>'league_game_id')::uuid
      and user_id = (pick_row->>'user_id')::uuid;
  end loop;

  for member_row in select * from jsonb_array_elements(p_member_updates)
  loop
    update public.league_members
    set
      balance = (member_row->>'balance')::numeric,
      alive = (member_row->>'alive')::boolean
    where id = (member_row->>'member_id')::uuid;
  end loop;

  update public.league_weeks
  set phase = 'revealed', pot_after = p_pot_after, scored_at = now()
  where id = p_league_week_id;

  update public.leagues
  set pot_carryover = p_pot_after, phase = 'revealing'
  where id = p_league_id;
end;
$$;

revoke all on function public.reveal_week_commit from public, anon, authenticated;
grant execute on function public.reveal_week_commit to service_role;

-- ============================================================
-- advance_week_commit — used by advance-week
-- ============================================================
create or replace function public.advance_week_commit(
  p_league_id uuid,
  p_next_week int,
  p_phase text, -- 'picking' (NFL) or 'selecting' (NCAA)
  p_pot_before numeric,
  p_selection_deadline timestamptz, -- null for NFL
  p_game_ids uuid[] -- populated for NFL (full slate), null/empty for NCAA
)
returns public.league_weeks
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.league_weeks;
  v_new public.league_weeks;
  v_game_id uuid;
begin
  -- Lock the league row so two concurrent "advance" calls (e.g. a
  -- double-tap) serialize here rather than both trying to create the week.
  perform 1 from public.leagues where id = p_league_id for update;

  select * into v_existing
  from public.league_weeks
  where league_id = p_league_id and week = p_next_week;

  if found then
    return v_existing; -- already advanced — idempotent no-op, not an error
  end if;

  insert into public.league_weeks (league_id, week, phase, pot_before, matchup_selection_deadline)
  values (p_league_id, p_next_week, p_phase, p_pot_before, p_selection_deadline)
  returning * into v_new;

  if p_game_ids is not null and array_length(p_game_ids, 1) > 0 then
    foreach v_game_id in array p_game_ids
    loop
      insert into public.league_games (league_week_id, game_id) values (v_new.id, v_game_id);
    end loop;
  end if;

  update public.leagues set week = p_next_week, phase = p_phase where id = p_league_id;

  return v_new;
end;
$$;

revoke all on function public.advance_week_commit from public, anon, authenticated;
grant execute on function public.advance_week_commit to service_role;

-- ============================================================
-- confirm_matchup_selection_commit — used by confirm-matchup-selection
-- ============================================================
create or replace function public.confirm_matchup_selection_commit(
  p_league_week_id uuid,
  p_game_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phase text;
  v_game_id uuid;
begin
  select phase into v_phase from public.league_weeks where id = p_league_week_id for update;
  if v_phase is null then
    raise exception 'league_week % not found', p_league_week_id;
  end if;
  if v_phase != 'selecting' then
    raise exception 'league_week % is no longer open for selection (phase is %)', p_league_week_id, v_phase;
  end if;

  foreach v_game_id in array p_game_ids
  loop
    insert into public.league_games (league_week_id, game_id) values (p_league_week_id, v_game_id);
  end loop;

  update public.league_weeks set phase = 'picking', selection_method = 'creator' where id = p_league_week_id;
end;
$$;

revoke all on function public.confirm_matchup_selection_commit from public, anon, authenticated;
grant execute on function public.confirm_matchup_selection_commit to service_role;

-- ============================================================
-- auto_select_matchups_commit — used by auto-select-expired-matchups
-- ============================================================
-- Same row-lock-and-recheck pattern as confirm_matchup_selection_commit —
-- this closes the exact race where a creator confirms manually in the same
-- instant the deadline cron fires. Whichever one gets the lock first wins;
-- the other sees phase already changed and quietly does nothing (this is
-- an automated background job, not a user-facing action, so a silent no-op
-- is correct here rather than raising an exception).
create or replace function public.auto_select_matchups_commit(
  p_league_week_id uuid,
  p_league_id uuid,
  p_game_ids uuid[]
)
returns boolean -- true if it actually made the selection, false if it was already handled
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phase text;
  v_game_id uuid;
begin
  select phase into v_phase from public.league_weeks where id = p_league_week_id for update;
  if v_phase is null or v_phase != 'selecting' then
    return false;
  end if;

  foreach v_game_id in array p_game_ids
  loop
    insert into public.league_games (league_week_id, game_id) values (p_league_week_id, v_game_id);
  end loop;

  update public.league_weeks set phase = 'picking', selection_method = 'auto' where id = p_league_week_id;
  update public.leagues set phase = 'picking' where id = p_league_id;

  return true;
end;
$$;

revoke all on function public.auto_select_matchups_commit from public, anon, authenticated;
grant execute on function public.auto_select_matchups_commit to service_role;
