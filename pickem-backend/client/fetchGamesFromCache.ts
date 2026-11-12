// client/fetchGamesFromCache.ts
//
// Drop-in replacement for the prototype's generateSlate() / generateNcaaPool().
// The shape returned here matches exactly what the app's existing scoring logic
// (scoring.js) already expects — { id, teamA, teamB, favorite, underdog, spread,
// kickoff } — so nothing else in the app needs to change.
//
// Every league calling this hits the SAME cached rows. No league-specific or
// per-user fetch to The Odds API happens here — that only happens in the
// scheduled sync functions.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);

export type CachedGame = {
  id: string;
  teamA: string;
  teamB: string;
  favorite: string | null;
  underdog: string | null;
  spread: number | null;
  kickoff: number; // epoch ms, matches what attachKickoffs()/isLocked() already expect
};

/** Fetches the full slate/pool for a given sport + season + week from the shared cache. */
export async function fetchWeekGames(
  sport: "nfl" | "ncaa",
  season: number,
  week: number
): Promise<CachedGame[]> {
  const { data, error } = await supabase
    .from("games_cache")
    .select("*")
    .eq("sport", sport)
    .eq("season", season)
    .eq("week", week)
    .order("kickoff", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    teamA: row.team_home,
    teamB: row.team_away,
    favorite: row.favorite,
    underdog: row.underdog,
    spread: row.spread,
    kickoff: new Date(row.kickoff).getTime(),
  }));
}

/**
 * Fetches live/final results for a specific set of games (the 15/16 a league
 * actually locked in) — used at reveal time instead of simulateOutcome()/
 * simulateScore() from the prototype.
 */
export async function fetchResults(
  gameIds: string[]
): Promise<Record<string, { winner: string | null; scoreHome: number | null; scoreAway: number | null; status: string }>> {
  const { data, error } = await supabase
    .from("games_cache")
    .select("id, winner, score_home, score_away, status")
    .in("id", gameIds);

  if (error) throw error;

  const byId: Record<string, { winner: string | null; scoreHome: number | null; scoreAway: number | null; status: string }> = {};
  for (const row of data ?? []) {
    byId[row.id] = {
      winner: row.winner,
      scoreHome: row.score_home,
      scoreAway: row.score_away,
      status: row.status,
    };
  }
  return byId;
}
