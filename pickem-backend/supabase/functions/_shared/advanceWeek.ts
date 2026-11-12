// supabase/functions/_shared/advanceWeek.ts
//
// Core "move a league into its next week" logic, extracted out of
// advance-week/index.ts so auto-progress-leagues (no user session) can call
// it directly, without needing the creator-only auth check that the
// user-facing wrapper still enforces.
//
// Takes an already-fetched `league` row rather than a leagueId, since both
// callers (the wrapper, which already fetched it for the creator check; and
// auto-progress-leagues, which fetches a batch of leagues to check) already
// have it in hand.

import { nextMondayNoonEastern } from "./time.ts";
import { determineNcaaWeekSetup } from "./ncaaWeekSetup.ts";

export type AdvanceWeekResult =
  | { ok: true; alreadyAdvanced: true; leagueWeek: any }
  | { ok: true; alreadyAdvanced: false; leagueWeek: any; gamesPopulated?: number; selectionDeadline?: string }
  | { ok: false; status: number; error: string };

export async function advanceWeekCore(
  admin: any,
  league: { id: string; sport: "nfl" | "ncaa"; season: number; week: number; pot_carryover: number }
): Promise<AdvanceWeekResult> {
  const nextWeekNum = league.week + 1;

  const { data: existingNext } = await admin
    .from("league_weeks")
    .select("*")
    .eq("league_id", league.id)
    .eq("week", nextWeekNum)
    .maybeSingle();
  if (existingNext) {
    return { ok: true, alreadyAdvanced: true, leagueWeek: existingNext };
  }

  if (league.sport === "nfl") {
    const { data: slate, error: slateError } = await admin
      .from("games_cache")
      .select("id, kickoff")
      .eq("sport", "nfl")
      .eq("season", league.season)
      .eq("week", nextWeekNum);
    if (slateError) return { ok: false, status: 500, error: slateError.message };
    if (!slate || slate.length === 0) {
      return {
        ok: false,
        status: 409,
        error: "Next week's NFL schedule isn't cached yet — try again once sync-schedule-odds has run for it",
      };
    }

    // Same fix as create-league: exclude games that have already locked by
    // the time this week actually gets advanced into (e.g. a creator delays
    // clicking "advance" — or now, the automated job delays a bit — until
    // after some of the new week's games have already started). Including
    // them would guarantee forfeited points with zero chance to play.
    const LOCK_MS = 5 * 60 * 1000;
    const lockThreshold = Date.now() + LOCK_MS;
    const pickableGames = slate.filter((g: any) => new Date(g.kickoff).getTime() > lockThreshold);
    const gameIds = pickableGames.length > 0 ? pickableGames.map((g: any) => g.id) : slate.map((g: any) => g.id);

    const { data: newWeek, error: commitError } = await admin.rpc("advance_week_commit", {
      p_league_id: league.id,
      p_next_week: nextWeekNum,
      p_phase: "picking",
      p_pot_before: league.pot_carryover,
      p_selection_deadline: null,
      p_game_ids: gameIds,
    });
    if (commitError) return { ok: false, status: 500, error: commitError.message };

    return { ok: true, alreadyAdvanced: false, leagueWeek: newWeek, gamesPopulated: gameIds.length };
  }

  // NCAA path — normally opens a selection window, but auto-assigns
  // directly once the real pool is too small to support picking 15 (see
  // determineNcaaWeekSetup for the full reasoning).
  const setup = await determineNcaaWeekSetup(admin, league.season, nextWeekNum);

  if (setup.mode === "auto") {
    const { data: newWeek, error: commitError } = await admin.rpc("advance_week_commit", {
      p_league_id: league.id,
      p_next_week: nextWeekNum,
      p_phase: "picking",
      p_pot_before: league.pot_carryover,
      p_selection_deadline: null,
      p_game_ids: setup.gameIds,
    });
    if (commitError) return { ok: false, status: 500, error: commitError.message };
    return { ok: true, alreadyAdvanced: false, leagueWeek: newWeek, gamesPopulated: setup.gameIds.length };
  }

  const deadline = nextMondayNoonEastern(new Date());
  const { data: newWeek, error: commitError } = await admin.rpc("advance_week_commit", {
    p_league_id: league.id,
    p_next_week: nextWeekNum,
    p_phase: "selecting",
    p_pot_before: league.pot_carryover,
    p_selection_deadline: deadline.toISOString(),
    p_game_ids: null,
  });
  if (commitError) return { ok: false, status: 500, error: commitError.message };

  return { ok: true, alreadyAdvanced: false, leagueWeek: newWeek, selectionDeadline: deadline.toISOString() };
}