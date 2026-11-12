-- Account deletion, required by both Apple (since June 2022) and Google
-- (fully enforced since May 2024) for any app that allows account creation.
--
-- Wrapped in a single atomic function for the same reason reveal_week_commit
-- and advance_week_commit are: a partial failure here would be worse than
-- a partial failure almost anywhere else in this app — the entire point of
-- account deletion is COMPLETE removal, so a half-finished deletion that
-- silently leaves some personal data behind is a real privacy failure, not
-- just a UX inconvenience.
--
-- Handles one real edge case explicitly: if the user being deleted created
-- a league that other real people are still playing in, that league
-- shouldn't be destroyed out from under them just because its creator
-- left. Creator status transfers to whoever joined that league earliest
-- (excluding the user being deleted). Only if they were the league's only
-- member does the league itself get removed (which cascades its weeks,
-- games, and picks — there was no one else's data in it to preserve).

create or replace function public.delete_account_commit(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  league_row record;
  new_creator record;
begin
  for league_row in select id from public.leagues where creator_id = p_user_id loop
    select lm.id, lm.user_id into new_creator
    from public.league_members lm
    where lm.league_id = league_row.id and lm.user_id != p_user_id
    order by lm.joined_at asc
    limit 1;

    if found then
      update public.leagues set creator_id = new_creator.user_id where id = league_row.id;
      update public.league_members set is_creator = true where id = new_creator.id;
    else
      -- They were the only member — nothing else to preserve.
      delete from public.leagues where id = league_row.id;
    end if;
  end loop;

  -- Now safe to remove this user's own participation data everywhere else —
  -- any league they created either has a new creator now, or is gone.
  delete from public.picks where user_id = p_user_id;
  delete from public.push_tokens where user_id = p_user_id;
  delete from public.league_members where user_id = p_user_id;
end;
$$;

-- Same security posture as the other *_commit functions: powerful enough to
-- bypass RLS (necessary — a user can't be allowed to delete OTHER people's
-- rows under normal RLS, but this function legitimately needs to touch
-- related rows like league creator reassignment), so only the trusted
-- Edge Function (service_role) may call it, never a regular client directly.
revoke all on function public.delete_account_commit from public, anon, authenticated;
grant execute on function public.delete_account_commit to service_role;