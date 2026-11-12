-- Fixes a real gap in the original display-name trigger: league_members.
-- display_name is a one-time snapshot taken when someone creates or joins
-- a league, never updated afterward. Every leaderboard, standings table,
-- and picks view reads from that snapshot, not from auth.users directly —
-- so a display name change was correctly enforced for uniqueness and
-- correctly saved to auth.users, but never actually reached anywhere a
-- user would see their own new name reflected.
--
-- Extends the same trigger already firing on every insert/update to
-- auth.users, rather than adding a second, separate mechanism — the
-- propagation happens atomically alongside the uniqueness check itself.

create or replace function public.enforce_unique_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_display_name text;
  new_normalized text;
  conflicting_user uuid;
begin
  new_display_name := new.raw_user_meta_data->>'display_name';
  if new_display_name is null or trim(new_display_name) = '' then
    return new; -- nothing set yet — nothing to validate
  end if;

  new_normalized := lower(trim(new_display_name));

  select user_id into conflicting_user
  from public.display_names
  where normalized_name = new_normalized and user_id != new.id;

  if conflicting_user is not null then
    raise exception 'That display name is already taken. Please choose another.';
  end if;

  insert into public.display_names (user_id, display_name, normalized_name)
  values (new.id, trim(new_display_name), new_normalized)
  on conflict (user_id) do update
    set display_name = excluded.display_name,
        normalized_name = excluded.normalized_name;

  -- Propagate to every league this user belongs to, so standings,
  -- leaderboards, and the picks view all reflect the new name immediately
  -- rather than the name that happened to be current when they first
  -- joined or created each league.
  update public.league_members
  set display_name = trim(new_display_name)
  where user_id = new.id
    and display_name != trim(new_display_name);

  return new;
end;
$$;

-- One-time repair for any account whose league_members rows are already
-- out of sync with their current real display name — this catches the
-- specific user already affected, and anyone else in the same state.
update public.league_members lm
set display_name = trim(u.raw_user_meta_data->>'display_name')
from auth.users u
where lm.user_id = u.id
  and u.raw_user_meta_data->>'display_name' is not null
  and trim(u.raw_user_meta_data->>'display_name') != ''
  and lm.display_name != trim(u.raw_user_meta_data->>'display_name');