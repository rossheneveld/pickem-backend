-- Fixes: "infinite recursion detected in policy for relation league_members"
--
-- The original policy checked "is the requesting user a member of this row's
-- league?" by querying league_members FROM WITHIN a policy defined ON
-- league_members — so evaluating the policy for one row required
-- re-evaluating the same policy for other rows, forever. Postgres correctly
-- detects this as an infinite loop and refuses to run the query at all.
--
-- Fix: do the membership check inside a SECURITY DEFINER function instead.
-- A security-definer function executes with the privileges of its owner
-- (not the requesting user), which means its internal query bypasses RLS
-- entirely — so calling it from the policy no longer re-triggers the same
-- policy. This is the standard, documented fix for this exact pattern.

create or replace function public.is_league_member(p_league_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league_id and user_id = p_user_id
  );
$$;

-- Only needs to be callable as part of policy evaluation (i.e. by
-- authenticated users querying these tables) — not directly by anyone.
revoke all on function public.is_league_member from public, anon;
grant execute on function public.is_league_member to authenticated;

drop policy if exists "league_members visible to fellow members" on public.league_members;

create policy "league_members visible to fellow members"
  on public.league_members for select
  to authenticated
  using (
    public.is_league_member(league_members.league_id, auth.uid())
  );