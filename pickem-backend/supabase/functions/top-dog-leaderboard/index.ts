// supabase/functions/top-dog-leaderboard/index.ts
//
// Serves the global Top Dog leaderboard (see migration 024) to the Home
// screen: the top N players by underdog-calling accuracy, plus the
// calling user's own rank and stats even when they're outside that list.
//
// Deploy: supabase functions deploy top-dog-leaderboard
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { buildGlobalLeaderboardResponse } from "../_shared/globalLeaderboard.ts";

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
    const myUserId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const result = await buildGlobalLeaderboardResponse(
      admin,
      myUserId,
      "top_dog_leaderboard",
      "user_id, total_underdog_opportunities, correct_underdog_calls, top_dog_percentage",
      "top_dog_percentage",
      "total_underdog_opportunities"
    );

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});