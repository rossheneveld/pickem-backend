alter table public.league_weeks
  add column if not exists selection_method text check (selection_method in ('creator', 'auto'));
