-- Result columns on picks, written exclusively by the reveal-week Edge
-- Function once a week is scored. Nothing here is writable by a regular
-- client — the existing insert/update policies from migration 004 only
-- ever let an owner set `team`/`points`, never these columns, since those
-- policies don't grant column-level write access to them and reveal-week
-- itself runs as service_role (bypasses RLS entirely).

alter table public.picks
  add column if not exists outcome text check (outcome in ('win', 'loss', 'push', 'forfeited')),
  add column if not exists shares numeric not null default 0,
  add column if not exists bonus_points numeric not null default 0,
  add column if not exists points_delta numeric; -- signed total effect on balance: kept/lost + bonus, or -points if forfeited

comment on column public.picks.outcome is 'Null until scored. Set once by reveal-week.';
comment on column public.picks.points_delta is 'Signed contribution to balance: +points for a win or a push (both are "kept"), +points+bonus_points for a correct underdog win, -points for a loss or forfeit. This is the exact number the app displays as "+72 pts" / "-8 pts".';
