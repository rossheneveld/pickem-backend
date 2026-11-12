// supabase/functions/_shared/leagueJoinEligibility.ts
//
// Whether a league is still open to new members: its STARTING week's first
// game hasn't locked yet. Extracted into a shared helper specifically
// because join-league's original inline version of this check hardcoded
// `week = 1` — which silently did nothing for any league with a
// starting_week other than 1 (leagues created mid-season), since such a
// league has no league_weeks row where week=1 at all. That let someone
// join a late-starting league even after its first game had already
// locked, completely bypassing the intended protection.

export async function isLeagueJoinable(
  admin: any,
  league: { id: string; starting_week: number }
): Promise<boolean> {
  const { data: startingWeek, error } = await admin
    .from("league_weeks")
    .select("id")
    .eq("league_id", league.id)
    .eq("week", league.starting_week)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!startingWeek) return true; // starting week not set up yet at all — nothing has locked

  const { data: games, error: gamesError } = await admin
    .from("league_games")
    .select("games_cache (kickoff)")
    .eq("league_week_id", startingWeek.id);
  if (gamesError) throw new Error(gamesError.message);

  const kickoffs = (games ?? [])
    .map((g: any) => g.games_cache?.kickoff)
    .filter(Boolean)
    .map((k: string) => new Date(k).getTime());
  if (kickoffs.length === 0) return true; // no games populated yet (e.g. NCAA still selecting)

  const earliestKickoff = Math.min(...kickoffs);
  const LOCK_MS = 5 * 60 * 1000;
  return Date.now() < earliestKickoff - LOCK_MS;
}