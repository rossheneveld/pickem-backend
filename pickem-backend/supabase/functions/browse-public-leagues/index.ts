// supabase/functions/browse-public-leagues/index.ts
//
// Lists public leagues a caller could still join — reusing the exact same
// eligibility check join-league itself uses, so a league that shows up
// here is guaranteed actually joinable, not just "looked eligible from a
// separate, possibly-drifted copy of the same rule."
//
// Deploy: supabase functions deploy browse-public-leagues
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { isLeagueJoinable } from "../_shared/leagueJoinEligibility.ts";

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

    const { data: publicLeagues, error: leaguesError } = await admin
      .from("leagues")
      .select("id, name, sport, invite_code, week, starting_week")
      .eq("visibility", "public");
    if (leaguesError) return new Response(JSON.stringify({ error: leaguesError.message }), { headers: corsHeaders, status: 500 });

    const results: any[] = [];
    for (const league of publicLeagues ?? []) {
      try {
        const joinable = await isLeagueJoinable(admin, league);
        if (!joinable) continue;

        // Already a member? Don't show it in "browse to join" — they'd just
        // hit the idempotent "already a member" response.
        const { data: existingMember } = await admin
          .from("league_members")
          .select("id")
          .eq("league_id", league.id)
          .eq("user_id", myUserId)
          .maybeSingle();
        if (existingMember) continue;

        const { count: memberCount } = await admin
          .from("league_members")
          .select("id", { count: "exact", head: true })
          .eq("league_id", league.id);

        results.push({
          id: league.id,
          name: league.name,
          sport: league.sport,
          invite_code: league.invite_code,
          week: league.week,
          member_count: memberCount ?? 0,
        });
      } catch (_err) {
        // Skip a single league on error rather than fail the whole browse list.
        continue;
      }
    }

    return new Response(JSON.stringify({ leagues: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});