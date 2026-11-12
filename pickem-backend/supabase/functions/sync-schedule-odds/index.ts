// supabase/functions/sync-schedule-odds/index.ts
//
// Runs on a schedule (see ../../migrations/002_cron_schedule.sql), NOT per-request.
// Pulls schedule + spreads for NFL and NCAA from The Odds API and upserts into
// games_cache. Every league in the app reads from that table — this function is
// the only thing that ever talks to The Odds API for this data, regardless of
// how many leagues or users exist.
//
// Deploy: supabase functions deploy sync-schedule-odds
// Required secrets (supabase secrets set ...):
//   ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { computeWeek, NFL_WEEK1_START, NCAA_WEEK1_START } from "../_shared/time.ts";
import { recordHeartbeat } from "../_shared/heartbeat.ts";
import { isPowerFourGame } from "../_shared/powerFourTeams.ts";

const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const SPORTS: { key: string; sport: "nfl" | "ncaa" }[] = [
  { key: "americanfootball_nfl", sport: "nfl" },
  { key: "americanfootball_ncaaf", sport: "ncaa" },
];

const SEASON = 2026;

type OddsApiOutcome = { name: string; point?: number };
type OddsApiMarket = { key: string; outcomes: OddsApiOutcome[] };
type OddsApiBookmaker = { markets: OddsApiMarket[] };
type OddsApiEvent = {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: OddsApiBookmaker[];
};

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Array<{ sport: string; ok: boolean; gamesUpserted?: number; error?: string }> = [];

  for (const { key, sport } of SPORTS) {
    try {
      const url =
        `https://api.the-odds-api.com/v4/sports/${key}/odds` +
        `?regions=us&markets=spreads&oddsFormat=american&apiKey=${ODDS_API_KEY}`;

      const res = await fetch(url);
      if (!res.ok) {
        results.push({ sport, ok: false, error: `${res.status} ${await res.text()}` });
        continue;
      }
      const events: OddsApiEvent[] = await res.json();
      const week1Start = sport === "ncaa" ? NCAA_WEEK1_START : NFL_WEEK1_START;

      // NCAA is scoped to Power 4 conferences + Notre Dame — the full FBS
      // slate each week is far too many games for the pick'em pool to make
      // sense from. NFL has no such filter; every real game counts.
      const relevantEvents =
        sport === "ncaa" ? events.filter((e) => isPowerFourGame(e.home_team, e.away_team)) : events;

      const rows = relevantEvents.map((event) => {
        const { favorite, underdog, spread } = extractSpread(event);
        return {
          sport,
          season: SEASON,
          week: computeWeek(event.commence_time, week1Start),
          odds_api_event_id: event.id,
          team_home: event.home_team,
          team_away: event.away_team,
          favorite,
          underdog,
          spread,
          kickoff: event.commence_time,
          odds_updated_at: new Date().toISOString(),
        };
      });

      // Never touch a game whose kickoff has already passed — found the
      // hard way that excluding only status='final' wasn't enough. A game
      // that's 'live' (already started, not yet finished) is just as
      // vulnerable: the Odds API can return a live, in-game betting line
      // for a game already underway — reflecting how the game is actually
      // playing out so far, not the locked pre-game closing line — and
      // that live number silently overwrote the real spread here. The
      // closing line is permanently whatever it was the moment a game
      // kicks off; nothing after that point should ever change it,
      // regardless of what status value the game currently happens to have.
      //
      // New games (never cached before) are always inserted regardless of
      // kickoff time — there's nothing to protect yet, and this may be
      // their only chance to enter the cache at all.
      let rowsToUpsert = rows;
      if (rows.length > 0) {
        const { data: existingGames, error: existingCheckError } = await supabase
          .from("games_cache")
          .select("odds_api_event_id")
          .in("odds_api_event_id", rows.map((r) => r.odds_api_event_id));
        if (existingCheckError) {
          results.push({ sport, ok: false, error: existingCheckError.message });
          continue;
        }
        const existingIds = new Set((existingGames ?? []).map((g: any) => g.odds_api_event_id));
        const now = Date.now();
        rowsToUpsert = rows.filter((r) => {
          const isNew = !existingIds.has(r.odds_api_event_id);
          const hasNotStarted = new Date(r.kickoff).getTime() > now;
          return isNew || hasNotStarted;
        });
      }

      if (rowsToUpsert.length > 0) {
        const { error } = await supabase
          .from("games_cache")
          .upsert(rowsToUpsert, { onConflict: "odds_api_event_id" });
        if (error) {
          results.push({ sport, ok: false, error: error.message });
          continue;
        }
      }
      results.push({ sport, ok: true, gamesUpserted: rowsToUpsert.length });
    } catch (err) {
      results.push({ sport, ok: false, error: String(err) });
    }
  }

  // Now runs every 30 min (see migration 029), not every 6 hours — a real
  // outage should be caught within about an hour, not up to 6.
  await recordHeartbeat(supabase, "sync-schedule-odds", 60);
  return new Response(JSON.stringify({ results }), {
    headers: { "Content-Type": "application/json" },
  });
});

/** Averages the spread across every bookmaker that has a spreads market,
 * rather than using whichever bookmaker happens to appear first in the API
 * response — a genuine consensus, not just "first available," which
 * reduces exposure to any single bookmaker's outlier line. Rounded to the
 * nearest half-point, since spreads are conventionally quoted that way. */
function extractSpread(
  event: OddsApiEvent
): { favorite: string | null; underdog: string | null; spread: number | null } {
  const points: { home: number; away: number }[] = [];

  for (const bookmaker of event.bookmakers ?? []) {
    const market = bookmaker.markets?.find((m) => m.key === "spreads");
    if (!market) continue;
    const homeOutcome = market.outcomes.find((o) => o.name === event.home_team);
    const awayOutcome = market.outcomes.find((o) => o.name === event.away_team);
    if (!homeOutcome || !awayOutcome || homeOutcome.point == null || awayOutcome.point == null) continue;
    points.push({ home: homeOutcome.point, away: awayOutcome.point });
  }

  if (points.length === 0) return { favorite: null, underdog: null, spread: null };

  const avgHome = points.reduce((sum, p) => sum + p.home, 0) / points.length;
  const avgAway = points.reduce((sum, p) => sum + p.away, 0) / points.length;

  // The favorite carries the negative point value (e.g. -6.5)
  const favorite = avgHome < avgAway ? event.home_team : event.away_team;
  const underdog = favorite === event.home_team ? event.away_team : event.home_team;
  const rawSpread = Math.abs(Math.min(avgHome, avgAway));
  const spread = Math.round(rawSpread * 2) / 2; // nearest half-point

  return { favorite, underdog, spread };
}