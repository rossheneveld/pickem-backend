// supabase/functions/auto-progress-leagues/index.ts
//
// Runs every ~5 minutes. For every league currently in 'picking' phase,
// checks whether every game in its current week has actually finished
// (status = 'final'). If so, scores the week (revealWeekCore) and
// immediately advances into the next week (advanceWeekCore) — the same
// thing a user would otherwise have to do by tapping two separate buttons.
//
// This doesn't remove those buttons — they still work as an immediate,
// manual override if someone doesn't want to wait for this job's next run.
// Most of the time, this should beat them to it.
//
// Deploy: supabase functions deploy auto-progress-leagues
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { revealWeekCore } from "../_shared/revealWeek.ts";
import { advanceWeekCore } from "../_shared/advanceWeek.ts";
import { recordHeartbeat } from "../_shared/heartbeat.ts";
import { sendPushToUsers } from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Array<{ leagueId: string; week: number; action: string; detail?: any }> = [];

  const { data: leagues, error: leaguesError } = await admin
    .from("leagues")
    .select("id, sport, season, week, pot_carryover, phase")
    .eq("phase", "picking");
  if (leaguesError) return new Response(JSON.stringify({ error: leaguesError.message }), { status: 500 });

  for (const league of leagues ?? []) {
    try {
      const { data: leagueWeek, error: lwError } = await admin
        .from("league_weeks")
        .select("id, scored_at")
        .eq("league_id", league.id)
        .eq("week", league.week)
        .maybeSingle();
      if (lwError || !leagueWeek || leagueWeek.scored_at) continue; // nothing to do, or already scored

      const { data: leagueGames, error: lgError } = await admin
        .from("league_games")
        .select("games_cache (status)")
        .eq("league_week_id", leagueWeek.id);
      if (lgError || !leagueGames || leagueGames.length === 0) continue;

      const allFinal = leagueGames.every((lg: any) => lg.games_cache?.status === "final");
      if (!allFinal) continue; // this league's week isn't done yet — check again next run

      const revealResult = await revealWeekCore(admin, league.id, league.week);
      if (!revealResult.ok) {
        results.push({ leagueId: league.id, week: league.week, action: "reveal_failed", detail: revealResult.error });
        continue;
      }
      results.push({ leagueId: league.id, week: league.week, action: "revealed", detail: revealResult });

      // Refresh pot_carryover before advancing — revealWeekCore just updated
      // it on the leagues row, but our in-memory `league` object still has
      // the pre-reveal value.
      const { data: refreshedLeague, error: refreshError } = await admin
        .from("leagues")
        .select("id, sport, season, week, pot_carryover")
        .eq("id", league.id)
        .single();
      if (refreshError) {
        results.push({ leagueId: league.id, week: league.week, action: "advance_skipped_refresh_failed", detail: refreshError.message });
        continue;
      }

      const advanceResult = await advanceWeekCore(admin, refreshedLeague);
      results.push({
        leagueId: league.id,
        week: league.week,
        action: advanceResult.ok ? "advanced" : "advance_failed",
        detail: advanceResult,
      });

      if (advanceResult.ok && advanceResult.alreadyAdvanced === false && advanceResult.lateNotice) {
        try {
          const { data: members } = await admin
            .from("league_members")
            .select("user_id")
            .eq("league_id", league.id)
            .eq("alive", true);
          const userIds = (members ?? []).map((m: any) => m.user_id);
          if (userIds.length > 0) {
            await sendPushToUsers(admin, userIds, "This week's matchups were auto-selected", advanceResult.lateNotice, {
              leagueId: league.id,
            });
          }
        } catch (_err) {
          // Advancing the week already succeeded — a push failure shouldn't mask that.
        }
      }
    } catch (err) {
      results.push({ leagueId: league.id, week: league.week, action: "error", detail: String(err) });
    }
  }

  await recordHeartbeat(admin, "auto-progress-leagues", 5);
  return new Response(JSON.stringify({ leaguesChecked: leagues?.length ?? 0, results }), {
    headers: { "Content-Type": "application/json" },
  });
});