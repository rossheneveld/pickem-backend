// supabase/functions/auto-select-expired-matchups/index.ts
//
// Runs on a schedule (every few minutes is plenty — see the cron entry).
// Finds every league_week still in 'selecting' whose deadline has passed,
// and randomly picks 15 games from that week's NCAA pool on the creator's
// behalf. This is the enforcement mechanism behind "if the creator hasn't
// chosen by 12pm ET Monday, 15 are auto-selected."
//
// Deploy: supabase functions deploy auto-select-expired-matchups
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");
const MATCHUPS_PER_WEEK = 15;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: expiredWeeks, error: findError } = await admin
    .from("league_weeks")
    .select("id, week, league_id, leagues (season)")
    .eq("phase", "selecting")
    .lte("matchup_selection_deadline", new Date().toISOString());

  if (findError) return new Response(JSON.stringify({ error: findError.message }), { status: 500 });

  const results: Array<{ leagueWeekId: string; ok: boolean; gameCount?: number; error?: string }> = [];

  for (const lw of (expiredWeeks ?? []) as any[]) {
    try {
      const { data: pool, error: poolError } = await admin
        .from("games_cache")
        .select("id")
        .eq("sport", "ncaa")
        .eq("season", lw.leagues.season)
        .eq("week", lw.week);
      if (poolError) throw new Error(poolError.message);

      if (!pool || pool.length === 0) {
        results.push({ leagueWeekId: lw.id, ok: false, error: "no candidate games in pool for this week" });
        continue;
      }

      const chosen = shuffle(pool).slice(0, Math.min(MATCHUPS_PER_WEEK, pool.length));

      const { data: didSelect, error: commitError } = await admin.rpc("auto_select_matchups_commit", {
        p_league_week_id: lw.id,
        p_league_id: lw.league_id,
        p_game_ids: chosen.map((g: any) => g.id),
      });
      if (commitError) throw new Error(commitError.message);

      results.push(
        didSelect
          ? { leagueWeekId: lw.id, ok: true, gameCount: chosen.length }
          : { leagueWeekId: lw.id, ok: true, gameCount: 0, error: "already handled (creator confirmed first)" }
      );
    } catch (err) {
      results.push({ leagueWeekId: lw.id, ok: false, error: String(err) });
    }
  }

  await recordHeartbeat(admin, "auto-select-expired-matchups", 5);
  return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
});