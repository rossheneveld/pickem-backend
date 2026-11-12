// supabase/functions/reveal-week/index.ts
//
// Thin HTTP wrapper around revealWeekCore (see ../_shared/revealWeek.ts).
// This function itself has no auth requirement — scoring is deterministic
// and can't be manipulated by who calls it, it just refuses to run early
// (idempotent, and gated on every game actually being final). The real
// scoring logic lives in the shared core so auto-progress-leagues (a
// scheduled job with no user session) can call the identical code path.
//
// Deploy: supabase functions deploy reveal-week
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { revealWeekCore } from "../_shared/revealWeek.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    const { leagueId, week } = (await req.json()) as { leagueId: string; week: number };
    if (!leagueId || !week) {
      return new Response(JSON.stringify({ error: "leagueId and week are required" }), { headers: corsHeaders, status: 400 });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const result = await revealWeekCore(admin, leagueId, week);

    if (!result.ok) {
      return new Response(
        JSON.stringify({ error: result.error, gamesStillPending: result.gamesStillPending, totalGames: result.totalGames }),
        { headers: corsHeaders, status: result.status }
      );
    }
    if (result.alreadyScored) {
      return new Response(JSON.stringify({ alreadyScored: true, scoredAt: result.scoredAt }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ scored: true, pot: result.pot, totalShares: result.totalShares, payoutPerShare: result.payoutPerShare }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});