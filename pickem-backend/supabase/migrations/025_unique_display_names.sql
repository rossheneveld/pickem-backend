-- Prevents two accounts from ever having the same display name — without
-- this, the global Top Dog leaderboard (and any per-league standings) could
-- show two visually-identical entries with no way to tell them apart.
--
-- Display names are set via supabase.auth.signUp() and
-- supabase.auth.updateUser() directly from the client — there's no custom
-- Edge Function in that path to add a uniqueness check to. A Postgres
-- trigger on auth.users itself is the actual enforcement point; a
-- client-side "is this name taken" pre-check is added separately for a
-- fast, friendly error, but this trigger is what makes the guarantee real
-- regardless of what the client does or doesn't check first.

create table if not exists public.display_names (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  normalized_name text not null unique
);

-- Public, read-only for authenticated users — needed for the client-side
-- "is this name already taken" pre-check. Only the trigger function below
-- (running as its definer, not as the calling user) may write to this
-- table; there's no INSERT/UPDATE/DELETE policy for regular users at all.
alter table public.display_names enable row level security;

create policy "anyone signed in can check name availability"
  on public.display_names for select
  to authenticated
  using (true);

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

  return new;
end;
$$;

drop trigger if exists on_auth_user_display_name_change on auth.users;
create trigger on_auth_user_display_name_change
  after insert or update on auth.users
  for each row
  execute function public.enforce_unique_display_name();

-- Backfill: reserve every EXISTING account's current display name before
-- the trigger above starts enforcing anything — otherwise an existing
-- user's name isn't actually protected yet, since the trigger only fires
-- on future inserts/updates, not on rows that already exist. If any
-- pre-existing accounts already share the same name (from before this
-- migration), whichever one this backfill processes first keeps it;
-- run the diagnostic query below afterward to see if that happened.
insert into public.display_names (user_id, display_name, normalized_name)
select
  id,
  raw_user_meta_data->>'display_name',
  lower(trim(raw_user_meta_data->>'display_name'))
from auth.users
where raw_user_meta_data->>'display_name' is not null
  and trim(raw_user_meta_data->>'display_name') != ''
on conflict (normalized_name) do nothing;

-- Diagnostic: run this after the backfill above to see whether any
-- pre-existing accounts were left unprotected because another account
-- already had (and kept) the same name. If this returns any rows, those
-- specific users are still sharing a name with someone else — worth a
-- manual "please update your display name" nudge if it matters to you.
-- select u.id, u.email, u.raw_user_meta_data->>'display_name' as display_name
-- from auth.users u
-- where u.raw_user_meta_data->>'display_name' is not null
--   and trim(u.raw_user_meta_data->>'display_name') != ''
--   and not exists (
--     select 1 from public.display_names d where d.user_id = u.id
--   );