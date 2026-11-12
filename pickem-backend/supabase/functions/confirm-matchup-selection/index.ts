// supabase/functions/confirm-matchup-selection/index.ts
//
// The creator's manual path for choosing an NCAA week's 15 matchups (the
// other path is auto-select-expired-matchups, which runs on the deadline).
// Only works while the week is still in 'selecting' phase — if the
// deadline auto-picker already ran, this returns a clear "too late"
// response instead of silently overwriting an automated selection.
//
// Deploy: supabase functions deploy confirm-matchup-selection
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MATCHUPS_PER_WEEK = 15;

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

    const { leagueId, week, gameIds } = (await req.json()) as {
      leagueId: string;
      week: number;
      gameIds: string[];
    };

    if (!leagueId || !week || !Array.isArray(gameIds)) {
      return new Response(JSON.stringify({ error: "leagueId, week, and gameIds are required" }), { headers: corsHeaders, status: 400 });
    }
    const uniqueIds = [...new Set(gameIds)];
    if (uniqueIds.length !== MATCHUPS_PER_WEEK) {
      return new Response(
        JSON.stringify({ error: `Exactly ${MATCHUPS_PER_WEEK} unique games are required, got ${uniqueIds.length}` }),
        { headers: corsHeaders, status: 400 }
      );
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .select("id, sport, season, creator_id")
      .eq("id", leagueId)
      .single();
    if (leagueError) return new Response(JSON.stringify({ error: leagueError.message }), { headers: corsHeaders, status: 500 });
    if (league.creator_id !== user.id) {
      return new Response(JSON.stringify({ error: "Only the league creator can confirm matchups" }), { headers: corsHeaders, status: 403 });
    }
    if (league.sport !== "ncaa") {
      return new Response(JSON.stringify({ error: "This league doesn't use matchup selection" }), { headers: corsHeaders, status: 400 });
    }

    const { data: leagueWeek, error: lwError } = await admin
      .from("league_weeks")
      .select("id, phase")
      .eq("league_id", leagueId)
      .eq("week", week)
      .maybeSingle();
    if (lwError) return new Response(JSON.stringify({ error: lwError.message }), { headers: corsHeaders, status: 500 });
    if (!leagueWeek) return new Response(JSON.stringify({ error: "No such league week" }), { headers: corsHeaders, status: 404 });
    if (leagueWeek.phase !== "selecting") {
      return new Response(
        JSON.stringify({ error: "Selection is already closed for this week (deadline may have already passed)" }),
        { headers: corsHeaders, status: 409 }
      );
    }

    const { data: validGames, error: gamesError } = await admin
      .from("games_cache")
      .select("id")
      .eq("sport", "ncaa")
      .eq("season", league.season)
      .eq("week", week)
      .in("id", uniqueIds);
    if (gamesError) return new Response(JSON.stringify({ error: gamesError.message }), { headers: corsHeaders, status: 500 });
    if (!validGames || validGames.length !== MATCHUPS_PER_WEEK) {
      return new Response(
        JSON.stringify({ error: "One or more selected games are invalid for this league's sport/season/week" }),
        { headers: corsHeaders, status: 400 }
      );
    }

    const { error: commitError } = await admin.rpc("confirm_matchup_selection_commit", {
      p_league_week_id: leagueWeek.id,
      p_game_ids: uniqueIds,
    });
    if (commitError) {
      // The RPC's own phase check (under a row lock) catches the real race:
      // the deadline auto-picker could have fired in the same instant.
      if (commitError.message?.includes("no longer open")) {
        return new Response(
          JSON.stringify({ error: "Selection just closed — the deadline auto-picker may have already run" }),
          { headers: corsHeaders, status: 409 }
        );
      }
      return new Response(JSON.stringify({ error: commitError.message }), { headers: corsHeaders, status: 500 });
    }

    return new Response(JSON.stringify({ confirmed: true, gameCount: uniqueIds.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});
