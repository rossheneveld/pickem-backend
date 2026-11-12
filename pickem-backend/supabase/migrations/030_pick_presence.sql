-- Corrects a real mistake in an earlier draft of this migration: a second,
-- broader RLS policy on picks would have granted full ROW access (Postgres
-- RLS controls row visibility, not column visibility) — meaning anyone
-- could then read the actual team/points for any pick, completely
-- undermining the lock-based hiding this app depends on. This uses a
-- security definer function instead: it can see every row internally
-- (bypassing RLS, since it runs as its owner, not the caller), but only
-- ever returns the two safe columns — league_game_id and user_id — never
-- team, points, or anything else. Membership is checked explicitly inside
-- the function itself before returning anything.
create or replace function public.pick_presence_for_week(p_league_week_id uuid)
returns table (league_game_id uuid, user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.league_weeks w
    join public.league_members m on m.league_id = w.league_id
    where w.id = p_league_week_id
      and m.user_id = auth.uid()
  ) then
    raise exception 'Not a member of this league';
  end if;

  return query
    select p.league_game_id, p.user_id
    from public.picks p
    join public.league_games lg on lg.id = p.league_game_id
    where lg.league_week_id = p_league_week_id
      and p.team is not null;
end;
$$;

revoke all on function public.pick_presence_for_week from public;
grant execute on function public.pick_presence_for_week to authenticated;