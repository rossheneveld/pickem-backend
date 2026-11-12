// supabase/functions/advance-week/index.ts
//
// User-facing wrapper: keeps the creator-only auth check and the "current
// week must already be revealed" gate, then delegates the actual work to
// advanceWeekCore (see ../_shared/advanceWeek.ts) — the same core logic
// auto-progress-leagues calls automatically, with no user session at all.
//
// Deploy: supabase functions deploy advance-week
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { advanceWeekCore } from "../_shared/advanceWeek.ts";
import { sendPushToUsers } from "../_shared/push.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { headers: corsHeaders, status: 401 });

    const callerClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return new Response("Unauthorized", { headers: corsHeaders, status: 401 });
    const user = userData.user;

    const { leagueId } = (await req.json()) as { leagueId: string };
    if (!leagueId) return new Response(JSON.stringify({ error: "leagueId is required" }), { headers: corsHeaders, status: 400 });

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .select("id, sport, season, week, pot_carryover, creator_id")
      .eq("id", leagueId)
      .single();
    if (leagueError) return new Response(JSON.stringify({ error: leagueError.message }), { headers: corsHeaders, status: 500 });

    if (league.creator_id !== user.id) {
      return new Response(JSON.stringify({ error: "Only the league creator can advance the week" }), { headers: corsHeaders, status: 403 });
    }

    const { data: currentWeek, error: cwError } = await admin
      .from("league_weeks")
      .select("id, phase, scored_at")
      .eq("league_id", leagueId)
      .eq("week", league.week)
      .maybeSingle();
    if (cwError) return new Response(JSON.stringify({ error: cwError.message }), { headers: corsHeaders, status: 500 });
    if (!currentWeek || currentWeek.phase !== "revealed") {
      return new Response(
        JSON.stringify({ error: "This week hasn't been scored yet — run reveal-week first" }),
        { headers: corsHeaders, status: 409 }
      );
    }

    const result = await advanceWeekCore(admin, league);

    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.error }), { headers: corsHeaders, status: result.status });
    }

    if (result.alreadyAdvanced === false && result.lateNotice) {
      try {
        const { data: members } = await admin
          .from("league_members")
          .select("user_id")
          .eq("league_id", leagueId)
          .eq("alive", true);
        const userIds = (members ?? []).map((m: any) => m.user_id);
        if (userIds.length > 0) {
          await sendPushToUsers(admin, userIds, "This week's matchups were auto-selected", result.lateNotice, { leagueId });
        }
      } catch (_err) {
        // Advancing the week already succeeded — a push failure shouldn't mask that.
      }
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});