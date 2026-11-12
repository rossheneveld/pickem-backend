// supabase/functions/sync-live-scores/index.ts
//
// Runs frequently (every ~15 min), every day — see migration 028. This
// previously ran only on a fixed Thu/Sat/Sun/Mon UTC-day schedule, which
// silently missed real games whose kickoff or finish crossed a UTC
// calendar-day boundary (any evening US kickoff, effectively). Updates
// score_home, score_away, status, and winner on existing games_cache
// rows. Does not create new rows (sync-schedule-odds owns that) — if a
// game isn't already cached, its score update is skipped.
//
// Deploy: supabase functions deploy sync-live-scores
// Required secrets: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const SPORTS: { key: string; sport: "nfl" | "ncaa" }[] = [
  { key: "americanfootball_nfl", sport: "nfl" },
  { key: "americanfootball_ncaaf", sport: "ncaa" },
];

type OddsApiScoreEntry = { name: string; score: string };
type OddsApiScoreEvent = {
  id: string;
  home_team: string;
  away_team: string;
  completed: boolean;
  scores: OddsApiScoreEntry[] | null;
};

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Array<{ sport: string; ok: boolean; gamesUpdated?: number; error?: string }> = [];

  for (const { key, sport } of SPORTS) {
    try {
      // daysFrom=2 includes games that finished up to 2 days ago, plus anything live now
      const url = `https://api.the-odds-api.com/v4/sports/${key}/scores?daysFrom=2&apiKey=${ODDS_API_KEY}`;

      const res = await fetch(url);
      if (!res.ok) {
        results.push({ sport, ok: false, error: `${res.status} ${await res.text()}` });
        continue;
      }
      const events: OddsApiScoreEvent[] = await res.json();

      let updated = 0;
      for (const event of events) {
        if (!event.scores) continue; // game hasn't started yet — nothing to update

        const homeEntry = event.scores.find((s) => s.name === event.home_team);
        const awayEntry = event.scores.find((s) => s.name === event.away_team);
        if (!homeEntry || !awayEntry) continue;

        const homeScore = Number(homeEntry.score);
        const awayScore = Number(awayEntry.score);
        const status = event.completed ? "final" : "live";
        const winner = !event.completed
          ? null
          : homeScore === awayScore
          ? "TIE"
          : homeScore > awayScore
          ? event.home_team
          : event.away_team;

        const { error, count } = await supabase
          .from("games_cache")
          .update({
            score_home: homeScore,
            score_away: awayScore,
            status,
            winner,
            score_updated_at: new Date().toISOString(),
          })
          .eq("odds_api_event_id", event.id)
          .select("id", { count: "exact", head: true });

        if (!error && (count ?? 0) > 0) updated++;
      }
      results.push({ sport, ok: true, gamesUpdated: updated });
    } catch (err) {
      results.push({ sport, ok: false, error: String(err) });
    }
  }

  // Now runs every day (see migration 028 — the old day-restricted schedule
  // was missing real games whose kickoff or finish crossed a UTC calendar
  // boundary), so there's no longer an expected multi-day gap to tolerate.
  // A real outage should be caught within roughly an hour, not days.
  await recordHeartbeat(supabase, "sync-live-scores", 60);
  return new Response(JSON.stringify({ results }), {
    headers: { "Content-Type": "application/json" },
  });
});