// supabase/functions/touch-locked-picks/index.ts
//
// Runs frequently (every ~1 min, see the cron entry below) and finds every
// league_game whose real game just crossed its lock threshold
// (kickoff - 5 minutes) that hasn't been signaled yet. Setting
// locked_notified_at is a real UPDATE, which Realtime picks up and pushes
// to every subscribed league member — that's the client's cue to re-fetch
// picks for that game, which RLS now permits everyone to see.
//
// Idempotent by construction: the `locked_notified_at is null` filter means
// a game is only ever signaled once, no matter how often this runs.
//
// Deploy: supabase functions deploy touch-locked-picks
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: candidates, error: findError } = await admin
    .from("league_games")
    .select("id, games_cache (kickoff)")
    .is("locked_notified_at", null);

  if (findError) {
    return new Response(JSON.stringify({ error: findError.message }), { status: 500 });
  }

  const now = Date.now();
  const LOCK_MS = 5 * 60 * 1000;
  const justLockedIds = (candidates ?? [])
    .filter((lg: any) => lg.games_cache && new Date(lg.games_cache.kickoff).getTime() - LOCK_MS <= now)
    .map((lg: any) => lg.id);

  if (justLockedIds.length === 0) {
    await recordHeartbeat(admin, "touch-locked-picks", 1);
    return new Response(JSON.stringify({ signaled: 0 }), { headers: { "Content-Type": "application/json" } });
  }

  const { error: updateError } = await admin
    .from("league_games")
    .update({ locked_notified_at: new Date().toISOString() })
    .in("id", justLockedIds);

  if (updateError) {
    return new Response(JSON.stringify({ error: updateError.message }), { status: 500 });
  }

  await recordHeartbeat(admin, "touch-locked-picks", 1);
  return new Response(JSON.stringify({ signaled: justLockedIds.length }), {
    headers: { "Content-Type": "application/json" },
  });
});