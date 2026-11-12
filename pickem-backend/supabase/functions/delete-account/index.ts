// supabase/functions/delete-account/index.ts
//
// Required by both Apple and Google's account-deletion policies — see the
// comment in migration 020_delete_account.sql for the actual data-cleanup
// logic and the league-creator edge case it handles.
//
// This function does two things in order: (1) call the atomic commit
// function to clean up every table that references the user, then (2)
// delete the actual auth.users row. Step 2 is deliberately NOT inside the
// same SQL transaction as step 1 — Supabase's auth schema is managed by
// Supabase itself, not something our own migrations can safely wrap into
// a custom plpgsql transaction alongside application tables.
//
// Deploy: supabase functions deploy delete-account
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";

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
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error: commitError } = await admin.rpc("delete_account_commit", { p_user_id: userId });
    if (commitError) {
      return new Response(JSON.stringify({ error: `Account data cleanup failed: ${commitError.message}` }), {
        headers: corsHeaders,
        status: 500,
      });
    }

    const { error: authDeleteError } = await admin.auth.admin.deleteUser(userId);
    if (authDeleteError) {
      // Your app data is already gone at this point — the account itself
      // failed to delete. Surface this clearly rather than claim success.
      return new Response(
        JSON.stringify({ error: `Your data was deleted, but removing the account itself failed: ${authDeleteError.message}. Please contact support.` }),
        { headers: corsHeaders, status: 500 }
      );
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});