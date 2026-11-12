// supabase/functions/reset-league-password/index.ts
//
// Lets a league's creator set a new password if they've forgotten the
// original — there's no way to recover the old one (only its hash is ever
// stored), so this is the only path back into a private league you created
// and locked yourself out of.
//
// Deploy: supabase functions deploy reset-league-password
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BCRYPT_ROUNDS = 10;

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

    const { leagueId, newPassword } = (await req.json()) as { leagueId: string; newPassword: string };
    if (!leagueId || !newPassword) {
      return new Response(JSON.stringify({ error: "leagueId and newPassword are required" }), {
        headers: corsHeaders,
        status: 400,
      });
    }
    if (newPassword.trim().length < 4) {
      return new Response(JSON.stringify({ error: "Password must be at least 4 characters" }), {
        headers: corsHeaders,
        status: 400,
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .select("id, creator_id, visibility")
      .eq("id", leagueId)
      .single();
    if (leagueError) return new Response(JSON.stringify({ error: leagueError.message }), { headers: corsHeaders, status: 500 });

    if (league.creator_id !== user.id) {
      return new Response(JSON.stringify({ error: "Only the league creator can reset its password" }), {
        headers: corsHeaders,
        status: 403,
      });
    }
    if (league.visibility !== "private") {
      return new Response(JSON.stringify({ error: "This league doesn't have a password to reset" }), {
        headers: corsHeaders,
        status: 400,
      });
    }

    const passwordHash = await bcrypt.hash(newPassword.trim(), BCRYPT_ROUNDS);
    const { error: updateError } = await admin
      .from("leagues")
      .update({ password_hash: passwordHash })
      .eq("id", leagueId);
    if (updateError) return new Response(JSON.stringify({ error: updateError.message }), { headers: corsHeaders, status: 500 });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});