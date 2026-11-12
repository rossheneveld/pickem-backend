// supabase/functions/_shared/revealWeek.ts
//
// The actual scoring logic, extracted out of reveal-week/index.ts so it can
// be called two ways: by a real user tapping "View Week Results" (through
// reveal-week, which is just a thin wrapper around this now), and by
// auto-progress-leagues (a scheduled job with no user session at all,
// calling this directly). Both paths run the exact same code — there's no
// second copy of the scoring logic that could quietly drift out of sync.

import { scorePlayerWeek, distributePot, type Pick, type Game } from "./scoring.ts";
import { sendPushToUsers } from "./push.ts";

export type RevealWeekResult =
  | { ok: true; alreadyScored: true; scoredAt: string }
  | { ok: true; alreadyScored: false; pot: number; totalShares: number; payoutPerShare: number }
  | { ok: false; status: number; error: string; gamesStillPending?: number; totalGames?: number };

export async function revealWeekCore(admin: any, leagueId: string, week: number): Promise<RevealWeekResult> {
  const { data: leagueWeek, error: lwError } = await admin
    .from("league_weeks")
    .select("id, phase, pot_before, scored_at")
    .eq("league_id", leagueId)
    .eq("week", week)
    .maybeSingle();
  if (lwError) return { ok: false, status: 500, error: lwError.message };
  if (!leagueWeek) return { ok: false, status: 404, error: "No such league week" };

  if (leagueWeek.scored_at) {
    return { ok: true, alreadyScored: true, scoredAt: leagueWeek.scored_at };
  }

  const { data: leagueGames, error: lgError } = await admin
    .from("league_games")
    .select("id, game_id, games_cache (id, team_home, team_away, favorite, underdog, spread, status, winner)")
    .eq("league_week_id", leagueWeek.id);
  if (lgError) return { ok: false, status: 500, error: lgError.message };
  if (!leagueGames || leagueGames.length === 0) {
    return { ok: false, status: 400, error: "This week has no games yet" };
  }

  const notFinal = leagueGames.filter((lg: any) => lg.games_cache.status !== "final");
  if (notFinal.length > 0) {
    return {
      ok: false,
      status: 409,
      error: "Not all games have finished yet",
      gamesStillPending: notFinal.length,
      totalGames: leagueGames.length,
    };
  }

  const gamesById: Record<string, Game> = {};
  const outcomes: Record<string, string> = {};
  for (const lg of leagueGames as any[]) {
    gamesById[lg.id] = {
      favorite: lg.games_cache.favorite,
      underdog: lg.games_cache.underdog,
      spread: lg.games_cache.spread,
    };
    outcomes[lg.id] = lg.games_cache.winner;
  }
  const leagueGameIds = (leagueGames as any[]).map((lg) => lg.id);

  const { data: members, error: membersError } = await admin
    .from("league_members")
    .select("id, user_id, balance, alive")
    .eq("league_id", leagueId);
  if (membersError) return { ok: false, status: 500, error: membersError.message };

  const { data: picksRows, error: picksError } = await admin
    .from("picks")
    .select("id, league_game_id, user_id, team, points")
    .in("league_game_id", leagueGameIds);
  if (picksError) return { ok: false, status: 500, error: picksError.message };

  const playerResultsForPot: Record<string, { lost: number; shares: number }> = {};
  const scoredByUser: Record<string, ReturnType<typeof scorePlayerWeek>> = {};

  for (const member of members ?? []) {
    if (!member.alive) {
      playerResultsForPot[member.user_id] = { lost: 0, shares: 0 };
      continue;
    }
    const theirPicks: Pick[] = leagueGameIds.map((lgId) => {
      const row = (picksRows ?? []).find((p: any) => p.league_game_id === lgId && p.user_id === member.user_id);
      if (!row || row.team == null) {
        return { gameId: lgId, team: null, points: row?.points ?? 0, forfeited: true };
      }
      return { gameId: lgId, team: row.team, points: Number(row.points ?? 0), forfeited: false };
    });

    const result = scorePlayerWeek({
      picks: theirPicks,
      gamesById,
      outcomes,
      balance: Number(member.balance),
    });
    scoredByUser[member.user_id] = result;
    playerResultsForPot[member.user_id] = { lost: result.lost, shares: result.shares };
  }

  const potResult = distributePot({
    potCarryover: Number(leagueWeek.pot_before),
    playerResults: playerResultsForPot,
  });

  const pickUpdates: Array<{
    league_game_id: string;
    user_id: string;
    outcome: string;
    shares: number;
    bonus_points: number;
    points_delta: number;
  }> = [];
  const memberUpdates: Array<{ member_id: string; balance: number; alive: boolean }> = [];

  for (const member of members ?? []) {
    if (!member.alive) continue;
    const result = scoredByUser[member.user_id];
    const bonus = potResult.bonusByPlayer[member.user_id] ?? 0;
    const newBalance = result.kept + bonus;

    for (const d of result.detail) {
      const bonusForThisPick = d.correct && d.pickedUnderdog ? Math.floor(d.shares * potResult.payoutPerShare) : 0;
      const pointsDelta = d.forfeited || d.correct === false ? -d.points : d.points + bonusForThisPick;
      const outcome = d.forfeited ? "forfeited" : d.tie ? "push" : d.correct ? "win" : "loss";

      pickUpdates.push({
        league_game_id: d.gameId,
        user_id: member.user_id,
        outcome,
        shares: d.shares,
        bonus_points: bonusForThisPick,
        points_delta: pointsDelta,
      });
    }

    memberUpdates.push({ member_id: member.id, balance: newBalance, alive: newBalance > 0 });
  }

  const { error: commitError } = await admin.rpc("reveal_week_commit", {
    p_league_id: leagueId,
    p_league_week_id: leagueWeek.id,
    p_pot_after: potResult.newCarryover,
    p_pick_updates: pickUpdates,
    p_member_updates: memberUpdates,
  });

  if (commitError) {
    if (commitError.message?.includes("already scored")) {
      return { ok: true, alreadyScored: true, scoredAt: new Date().toISOString() };
    }
    return { ok: false, status: 500, error: commitError.message };
  }

  try {
    const { data: leagueRow } = await admin.from("leagues").select("name").eq("id", leagueId).single();
    const activeUserIds = (members ?? []).filter((m: any) => m.alive).map((m: any) => m.user_id);
    await sendPushToUsers(
      admin,
      activeUserIds,
      "Results are in!",
      `Week ${week} of ${leagueRow?.name ?? "your league"} has been scored — standings have updated, and your shareable results card is ready.`,
      { leagueId, week }
    );
  } catch (_err) {
    // Deliberately swallowed — scoring already succeeded, a push failure shouldn't mask that.
  }

  return { ok: true, alreadyScored: false, pot: potResult.pot, totalShares: potResult.totalShares, payoutPerShare: potResult.payoutPerShare };
}