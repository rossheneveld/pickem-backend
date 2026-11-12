cat > supabase/functions/_shared/cors.ts << 'CORSEOF'
// supabase/functions/_shared/cors.ts
//
// Without these headers, a browser-based caller (like Snack's web preview,
// or any future web version of this app) gets blocked before the request
// even reaches this function — the browser sends a preflight OPTIONS
// request first, and if nothing answers it correctly, the real request
// never goes out at all. That's exactly what "Failed to fetch" means: the
// request died before getting a response, not an error the server sent.
//
// Native device requests (a real Expo Go app on a phone) aren't subject to
// CORS at all — only actual browser-based JS is — but adding this doesn't
// hurt native callers, so every client-callable function gets it.

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Call this first thing in every client-callable function's handler. */
export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
CORSEOF

cat > supabase/functions/create-league/index.ts << 'FNEOF'
// supabase/functions/create-league/index.ts
//
// Creates a league and adds the caller as its first member (the creator).
// The password is hashed here, server-side, with bcryptjs — a client never
// computes or sends a hash, only the plaintext password over HTTPS, exactly
// once, at creation time.
//
// Deploy: supabase functions deploy create-league
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Auth: expects the caller's Supabase session JWT in the Authorization header
// (the Supabase client SDK sends this automatically for a logged-in user).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BCRYPT_ROUNDS = 10;
const INVITE_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I — avoids ambiguous invite codes

function generateInviteCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += INVITE_CODE_CHARS[Math.floor(Math.random() * INVITE_CODE_CHARS.length)];
  }
  return code;
}

function startingPointsFor(sport: "nfl" | "ncaa"): number {
  const gamesCount = sport === "ncaa" ? 15 : 16;
  return 10 * gamesCount;
}

Deno.serve(async (req) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { headers: corsHeaders, status: 401 });

    // Client for verifying WHO is calling (respects their JWT)
    const callerClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await callerClient.auth.getUser();
    if (userError || !userData.user) return new Response("Unauthorized", { headers: corsHeaders, status: 401 });
    const user = userData.user;

    const body = await req.json();
    const { name, sport, visibility, password, displayName } = body as {
      name: string;
      sport: "nfl" | "ncaa";
      visibility: "public" | "private";
      password?: string;
      displayName: string;
    };

    if (!name?.trim() || !["nfl", "ncaa"].includes(sport) || !["public", "private"].includes(visibility)) {
      return new Response(JSON.stringify({ error: "Missing or invalid league details" }), { headers: corsHeaders, status: 400 });
    }
    if (visibility === "private" && (!password || password.length < 4)) {
      return new Response(
        JSON.stringify({ error: "Private leagues need a password of at least 4 characters" }),
        { headers: corsHeaders, status: 400 }
      );
    }

    // Service-role client for the actual writes (bypasses RLS by design — this
    // function IS the trusted path that's allowed to write to these tables)
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const passwordHash = visibility === "private" ? await bcrypt.hash(password!, BCRYPT_ROUNDS) : null;

    // Retry on the (very unlikely) chance of an invite code collision
    let inviteCode = generateInviteCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: existing } = await admin
        .from("leagues")
        .select("id")
        .eq("invite_code", inviteCode)
        .maybeSingle();
      if (!existing) break;
      inviteCode = generateInviteCode();
    }

    const startingPoints = startingPointsFor(sport);

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .insert({
        name: name.trim(),
        sport,
        visibility,
        password_hash: passwordHash,
        invite_code: inviteCode,
        creator_id: user.id,
        season: new Date().getFullYear(),
        week: 1,
        phase: sport === "ncaa" ? "selecting" : "picking",
      })
      .select("id, name, sport, visibility, invite_code, season, week, phase")
      .single();

    if (leagueError) {
      return new Response(JSON.stringify({ error: leagueError.message }), { headers: corsHeaders, status: 500 });
    }

    const { error: memberError } = await admin.from("league_members").insert({
      league_id: league.id,
      user_id: user.id,
      display_name: displayName?.trim() || user.email || "Player",
      balance: startingPoints,
      alive: true,
      is_creator: true,
    });

    if (memberError) {
      // Roll back the league if adding the creator as a member fails, so we
      // never end up with an orphaned league nobody can access.
      await admin.from("leagues").delete().eq("id", league.id);
      return new Response(JSON.stringify({ error: memberError.message }), { headers: corsHeaders, status: 500 });
    }

    return new Response(JSON.stringify({ league }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});
FNEOF

cat > supabase/functions/join-league/index.ts << 'FNEOF'
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
      .select("id, name, sport, visibility, password_hash, week, phase")
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

    const startingBalance =
      activeMembers && activeMembers.length > 0
        ? activeMembers.reduce((sum, m) => sum + Number(m.balance), 0) / activeMembers.length
        : 10 * (league.sport === "ncaa" ? 15 : 16);

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
FNEOF

cat > supabase/functions/reveal-week/index.ts << 'FNEOF'
// supabase/functions/reveal-week/index.ts
//
// The single authoritative place scoring happens. Every client trusts this
// function's output — no device computes its own results anymore, unlike
// the prototype where every phone ran revealResults() independently.
//
// Idempotent: if league_weeks.scored_at is already set for this week, this
// returns the existing result instead of re-scoring. Safe to call from a
// cron job, a button tap, or a retry after a network failure — calling it
// twice never double-pays anyone.
//
// IMPORTANT CORRECTION vs. the prototype: the prototype scored a week once
// all its games were LOCKED. Locked only means picks are frozen — it does
// NOT mean the games have finished. This function waits for every game in
// the week to reach games_cache.status = 'final' before scoring anything.
//
// Deploy: supabase functions deploy reveal-week
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { scorePlayerWeek, distributePot, type Pick, type Game } from "../_shared/scoring.ts";
import { sendPushToUsers } from "../_shared/push.ts";

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

    // 1. Find (or fail) the league_week row.
    const { data: leagueWeek, error: lwError } = await admin
      .from("league_weeks")
      .select("id, phase, pot_before, scored_at")
      .eq("league_id", leagueId)
      .eq("week", week)
      .maybeSingle();

    if (lwError) return new Response(JSON.stringify({ error: lwError.message }), { headers: corsHeaders, status: 500 });
    if (!leagueWeek) {
      return new Response(JSON.stringify({ error: "No such league week" }), { headers: corsHeaders, status: 404 });
    }

    // 2. Idempotency guard — already scored, return what's already there.
    if (leagueWeek.scored_at) {
      return new Response(
        JSON.stringify({ alreadyScored: true, scoredAt: leagueWeek.scored_at }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 3. Load this week's games, joined to their real cached outcome/score.
    const { data: leagueGames, error: lgError } = await admin
      .from("league_games")
      .select("id, game_id, games_cache (id, team_home, team_away, favorite, underdog, spread, status, winner)")
      .eq("league_week_id", leagueWeek.id);

    if (lgError) return new Response(JSON.stringify({ error: lgError.message }), { headers: corsHeaders, status: 500 });
    if (!leagueGames || leagueGames.length === 0) {
      return new Response(JSON.stringify({ error: "This week has no games yet" }), { headers: corsHeaders, status: 400 });
    }

    // 4. Not ready until every game has actually finished — locked is not enough.
    const notFinal = leagueGames.filter((lg: any) => lg.games_cache.status !== "final");
    if (notFinal.length > 0) {
      return new Response(
        JSON.stringify({
          error: "Not all games have finished yet",
          gamesStillPending: notFinal.length,
          totalGames: leagueGames.length,
        }),
        { headers: corsHeaders, status: 409 }
      );
    }

    // 5. Build gamesById + outcomes for the shared scoring module.
    const gamesById: Record<string, Game> = {};
    const outcomes: Record<string, string> = {};
    for (const lg of leagueGames as any[]) {
      gamesById[lg.id] = {
        favorite: lg.games_cache.favorite,
        underdog: lg.games_cache.underdog,
        spread: lg.games_cache.spread,
      };
      outcomes[lg.id] = lg.games_cache.winner; // team name, or "TIE"
    }
    const leagueGameIds = (leagueGames as any[]).map((lg) => lg.id);

    // 6. Load every active member and their picks for this week's games.
    const { data: members, error: membersError } = await admin
      .from("league_members")
      .select("id, user_id, balance, alive")
      .eq("league_id", leagueId);
    if (membersError) return new Response(JSON.stringify({ error: membersError.message }), { headers: corsHeaders, status: 500 });

    const { data: picksRows, error: picksError } = await admin
      .from("picks")
      .select("id, league_game_id, user_id, team, points")
      .in("league_game_id", leagueGameIds);
    if (picksError) return new Response(JSON.stringify({ error: picksError.message }), { headers: corsHeaders, status: 500 });

    // 7. Score every active member. Anyone who never touched a given game
    // simply has no pick row for it — that's a full-points forfeit for
    // that game, same rule as a pick with a null team.
    const playerResultsForPot: Record<string, { lost: number; shares: number }> = {};
    const scoredByUser: Record<string, ReturnType<typeof scorePlayerWeek>> = {};

    for (const member of members ?? []) {
      if (!member.alive) {
        playerResultsForPot[member.user_id] = { lost: 0, shares: 0 };
        continue;
      }
      const theirPicks: Pick[] = leagueGameIds.map((lgId) => {
        const row = (picksRows ?? []).find((p: any) => p.league_game_id === lgId && p.user_id === member.user_id);
        if (!row || row.team == null) {
          // No pick, or picked-but-never-finalized-a-team: forfeit the
          // recorded wager (or the per-game minimum if none was ever set).
          return { gameId: lgId, team: null, points: row?.points ?? 0, forfeited: true };
        }
        return { gameId: lgId, team: row.team, points: Number(row.points ?? 0), forfeited: false };
      });

      const result = scorePlayerWeek({
        picks: theirPicks,
        gamesById,
        outcomes,
        balance: Number(member.balance),
      });
      scoredByUser[member.user_id] = result;
      playerResultsForPot[member.user_id] = { lost: result.lost, shares: result.shares };
    }

    // 8. Distribute the pot.
    const potResult = distributePot({
      potCarryover: Number(leagueWeek.pot_before),
      playerResults: playerResultsForPot,
    });

    // 9. Build the full set of writes as data, then commit them all in ONE
    // atomic transaction via reveal_week_commit — see migration 012. This
    // also re-checks "already scored" under a row lock inside that same
    // transaction, closing the race two concurrent calls could otherwise hit.
    const pickUpdates: Array<{
      league_game_id: string;
      user_id: string;
      outcome: string;
      shares: number;
      bonus_points: number;
      points_delta: number;
    }> = [];
    const memberUpdates: Array<{ member_id: string; balance: number; alive: boolean }> = [];

    for (const member of members ?? []) {
      if (!member.alive) continue;
      const result = scoredByUser[member.user_id];
      const bonus = potResult.bonusByPlayer[member.user_id] ?? 0;
      const newBalance = result.kept + bonus;

      for (const d of result.detail) {
        const bonusForThisPick = d.correct && d.pickedUnderdog ? Math.floor(d.shares * potResult.payoutPerShare) : 0;
        const pointsDelta = d.forfeited || d.correct === false ? -d.points : d.points + bonusForThisPick;
        const outcome = d.forfeited ? "forfeited" : d.tie ? "push" : d.correct ? "win" : "loss";

        pickUpdates.push({
          league_game_id: d.gameId,
          user_id: member.user_id,
          outcome,
          shares: d.shares,
          bonus_points: bonusForThisPick,
          points_delta: pointsDelta,
        });
      }

      memberUpdates.push({ member_id: member.id, balance: newBalance, alive: newBalance > 0 });
    }

    const { error: commitError } = await admin.rpc("reveal_week_commit", {
      p_league_id: leagueId,
      p_league_week_id: leagueWeek.id,
      p_pot_after: potResult.newCarryover,
      p_pick_updates: pickUpdates,
      p_member_updates: memberUpdates,
    });

    if (commitError) {
      // The RPC's own idempotency check (inside the transaction, under a
      // row lock) is the authoritative one — this is what actually catches
      // a genuine concurrent double-call, not just the early check at step 2.
      if (commitError.message?.includes("already scored")) {
        return new Response(JSON.stringify({ alreadyScored: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: commitError.message }), { headers: corsHeaders, status: 500 });
    }

    // Notify every active member that results are ready. Scoring has
    // already fully succeeded at this point — a push-send failure here
    // should never mask that success or fail the whole request.
    try {
      const { data: leagueRow } = await admin.from("leagues").select("name").eq("id", leagueId).single();
      const activeUserIds = (members ?? []).filter((m: any) => m.alive).map((m: any) => m.user_id);
      await sendPushToUsers(
        admin,
        activeUserIds,
        "Results are in!",
        `Week ${week} of ${leagueRow?.name ?? "your league"} has been scored — see how you did.`,
        { leagueId, week }
      );
    } catch (_err) {
      // Deliberately swallowed — see comment above.
    }

    return new Response(
      JSON.stringify({ scored: true, pot: potResult.pot, totalShares: potResult.totalShares, payoutPerShare: potResult.payoutPerShare }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});
FNEOF

cat > supabase/functions/advance-week/index.ts << 'FNEOF'
// supabase/functions/advance-week/index.ts
//
// Mirrors the prototype's nextWeek(), server-side and authoritative. Only a
// league's creator can trigger this (advancing the whole league is a
// creator-level decision, not something any one member should be able to
// force on everyone else). Only works once the CURRENT week has actually
// been scored (league_weeks.phase = 'revealed') — you can't skip ahead of
// real results.
//
// NFL: the next week's full slate already exists in games_cache (assuming
// sync-schedule-odds has run for it), so league_games is populated
// immediately and the new week goes straight to 'picking'.
//
// NCAA: there's no fixed slate to auto-populate — the creator has to choose
// 15 from the pool. This creates the league_week in 'selecting' with a real
// calendar deadline (next Monday 12pm ET), and leaves league_games empty
// until confirm-matchup-selection (creator) or auto-select-expired-matchups
// (deadline passed) populates it.
//
// Deploy: supabase functions deploy advance-week
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import { nextMondayNoonEastern } from "../_shared/time.ts";

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

    const nextWeekNum = league.week + 1;

    const { data: existingNext } = await admin
      .from("league_weeks")
      .select("*")
      .eq("league_id", leagueId)
      .eq("week", nextWeekNum)
      .maybeSingle();
    if (existingNext) {
      return new Response(JSON.stringify({ alreadyAdvanced: true, leagueWeek: existingNext }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (league.sport === "nfl") {
      const { data: slate, error: slateError } = await admin
        .from("games_cache")
        .select("id")
        .eq("sport", "nfl")
        .eq("season", league.season)
        .eq("week", nextWeekNum);
      if (slateError) return new Response(JSON.stringify({ error: slateError.message }), { headers: corsHeaders, status: 500 });
      if (!slate || slate.length === 0) {
        return new Response(
          JSON.stringify({ error: "Next week's NFL schedule isn't cached yet — try again once sync-schedule-odds has run for it" }),
          { headers: corsHeaders, status: 409 }
        );
      }

      const { data: newWeek, error: commitError } = await admin.rpc("advance_week_commit", {
        p_league_id: leagueId,
        p_next_week: nextWeekNum,
        p_phase: "picking",
        p_pot_before: league.pot_carryover,
        p_selection_deadline: null,
        p_game_ids: slate.map((g) => g.id),
      });
      if (commitError) return new Response(JSON.stringify({ error: commitError.message }), { headers: corsHeaders, status: 500 });

      return new Response(JSON.stringify({ leagueWeek: newWeek, gamesPopulated: slate.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // NCAA path — open a selection window instead of auto-populating.
    const deadline = nextMondayNoonEastern(new Date());
    const { data: newWeek, error: commitError } = await admin.rpc("advance_week_commit", {
      p_league_id: leagueId,
      p_next_week: nextWeekNum,
      p_phase: "selecting",
      p_pot_before: league.pot_carryover,
      p_selection_deadline: deadline.toISOString(),
      p_game_ids: null,
    });
    if (commitError) return new Response(JSON.stringify({ error: commitError.message }), { headers: corsHeaders, status: 500 });

    return new Response(
      JSON.stringify({ leagueWeek: newWeek, selectionDeadline: deadline.toISOString() }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});
FNEOF

cat > supabase/functions/confirm-matchup-selection/index.ts << 'FNEOF'
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
FNEOF

