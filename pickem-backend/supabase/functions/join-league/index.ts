// supabase/functions/join-league/index.ts
//
// The actual join-flow: given an invite code (and a password, if the league
// is private), verifies everything server-side and adds the caller as a
// league_member. This is the only path by which a league_members row can
// ever be created for a non-creator — there is no client-side insert policy
// for this table (see migrations/003_leagues_and_members.sql).
//
// Deploy: supabase functions deploy join-league
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { isLeagueJoinable } from "../_shared/leagueJoinEligibility.ts";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

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

    const body = await req.json();
    const { inviteCode, password, displayName } = body as {
      inviteCode: string;
      password?: string;
      displayName: string;
    };

    if (!inviteCode?.trim()) {
      return new Response(JSON.stringify({ error: "Invite code is required" }), { headers: corsHeaders, status: 400 });
    }

    // service_role client — this is the only place allowed to read
    // password_hash (see the column-level REVOKE in the migration) and the
    // only place allowed to write to league_members.
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .select("id, name, sport, visibility, password_hash, week, starting_week, phase")
      .eq("invite_code", inviteCode.trim().toUpperCase())
      .maybeSingle();

    if (leagueError) return new Response(JSON.stringify({ error: leagueError.message }), { headers: corsHeaders, status: 500 });
    if (!league) return new Response(JSON.stringify({ error: "No league found with that invite code" }), { headers: corsHeaders, status: 404 });

    if (league.visibility === "private") {
      if (!password) {
        return new Response(JSON.stringify({ error: "This league requires a password" }), { headers: corsHeaders, status: 401 });
      }
      const passwordMatches = await bcrypt.compare(password, league.password_hash);
      if (!passwordMatches) {
        return new Response(JSON.stringify({ error: "Incorrect password" }), { headers: corsHeaders, status: 401 });
      }
    }

    // Already a member? Return success idempotently rather than erroring —
    // rejoining via the same link shouldn't feel like a failure.
    const { data: existingMember } = await admin
      .from("league_members")
      .select("id")
      .eq("league_id", league.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (existingMember) {
      return new Response(JSON.stringify({ league, alreadyMember: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hard cutoff: once the league's STARTING week's first game has locked,
    // it's closed to new members entirely — not just less generous with
    // starting points. This is deliberately stricter than adjusting the
    // starting balance (below): it also prevents someone from effectively
    // "restarting" a league they were already in but fell behind on.
    const joinable = await isLeagueJoinable(admin, league);
    if (!joinable) {
      return new Response(
        JSON.stringify({ error: "This league is closed to new members — its first game has already locked." }),
        { headers: corsHeaders, status: 409 }
      );
    }

    // New members joining mid-season start with the SAME balance every other
    // active member currently has, not a fresh starting amount — otherwise
    // joining week 6 would hand someone an unfair points advantage or deficit
    // relative to everyone who's been playing since week 1.
    const { data: activeMembers, error: membersError } = await admin
      .from("league_members")
      .select("balance")
      .eq("league_id", league.id)
      .eq("alive", true);

    if (membersError) return new Response(JSON.stringify({ error: membersError.message }), { headers: corsHeaders, status: 500 });

    let startingBalance: number;
    if (activeMembers && activeMembers.length > 0) {
      startingBalance = activeMembers.reduce((sum, m) => sum + Number(m.balance), 0) / activeMembers.length;
    } else {
      // Nobody active to average against (rare — e.g. everyone's been
      // eliminated). Fall back to 10 pts × however many games are actually
      // in the league's current week, rather than a hardcoded 15/16 guess
      // that could be wrong during a shortened playoff week.
      const { data: currentWeekRow } = await admin
        .from("league_weeks")
        .select("id")
        .eq("league_id", league.id)
        .eq("week", league.week)
        .maybeSingle();
      let gameCount = league.sport === "ncaa" ? 15 : 16;
      if (currentWeekRow) {
        const { count } = await admin
          .from("league_games")
          .select("id", { count: "exact", head: true })
          .eq("league_week_id", currentWeekRow.id);
        if (count && count > 0) gameCount = count;
      }
      startingBalance = 10 * gameCount;
    }

    const { error: insertError } = await admin.from("league_members").insert({
      league_id: league.id,
      user_id: user.id,
      display_name: displayName?.trim() || user.email || "Player",
      balance: startingBalance,
      alive: true,
      is_creator: false,
    });

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), { headers: corsHeaders, status: 500 });
    }

    return new Response(JSON.stringify({ league, alreadyMember: false, startingBalance }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});