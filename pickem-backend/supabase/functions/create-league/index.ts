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
import { determineNcaaWeekSetup } from "../_shared/ncaaWeekSetup.ts";
import { sendPushToUsers } from "../_shared/push.ts";
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BCRYPT_ROUNDS = 10;
const INVITE_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I — avoids ambiguous invite codes
const FALLBACK_GAMES_GUESS = { nfl: 16, ncaa: 15 }; // only used when the real count genuinely isn't knowable yet

function generateInviteCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += INVITE_CODE_CHARS[Math.floor(Math.random() * INVITE_CODE_CHARS.length)];
  }
  return code;
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
    if (name.trim().length > 25) {
      return new Response(JSON.stringify({ error: "League name must be 25 characters or fewer" }), { headers: corsHeaders, status: 400 });
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

    // League creation is open all season — there is no date cutoff. What
    // it needs is something left to play, and the schedule itself is the
    // source of truth for that: the first game that hasn't locked yet.
    //
    // That one lookup settles three things a calendar guess got wrong:
    //  - Is there anything to play at all? No upcoming game means the
    //    offseason (or lines not posted yet), so creating a league would
    //    only produce an empty one — blocked with a clear message.
    //  - Which season? Games are stored under the season they belong to
    //    (the sync tags January playoff and bowl games as the SAME season
    //    as September's), but the calendar year rolls over on Jan 1 — a
    //    league created in January would have looked up the wrong season
    //    and found no games.
    //  - Which week should it start on? Weeks run Thursday to Wednesday,
    //    so on a Tuesday or Wednesday the "current" week's games have all
    //    been played already. A league started there would have nothing to
    //    pick, and scoring treats unwagered points as forfeited — every
    //    member would be wiped to zero points when it was scored. Starting
    //    on the first week with a pickable game avoids that entirely.
    const FIRST_PICKABLE_LOCK_MS = 5 * 60 * 1000;
    const { data: nextGame, error: nextGameError } = await admin
      .from("games_cache")
      .select("season, week")
      .eq("sport", sport)
      .gt("kickoff", new Date(Date.now() + FIRST_PICKABLE_LOCK_MS).toISOString())
      .order("kickoff", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (nextGameError) {
      return new Response(JSON.stringify({ error: nextGameError.message }), { headers: corsHeaders, status: 500 });
    }
    if (!nextGame) {
      return new Response(
        JSON.stringify({
          error: `There are no upcoming ${sport.toUpperCase()} games on the schedule right now, so a league can't be started yet. This usually just means the next week's lines haven't been posted — try again soon — or the season has ended.`,
        }),
        { headers: corsHeaders, status: 409 }
      );
    }
    const season = nextGame.season;
    const currentWeek = nextGame.week;

    // Determine the REAL game setup for this starting week BEFORE creating
    // anything — this is what lets the starting balance (10 pts × however
    // many games there actually are) be accurate even during a shortened
    // playoff week, instead of assuming every week has a full 15-16 game
    // slate. NFL always auto-populates every real game; NCAA either opens
    // a selection window (normal season) or auto-assigns everything once
    // the pool is smaller than 15 (playoff rounds).
    let gameIds: string[] | null = null;
    let phase: "picking" | "selecting" = sport === "ncaa" ? "selecting" : "picking";
    let selectionDeadline: string | null = null;
    let startingPoints: number;
    let scheduleNotCachedWarning: string | null = null;
    let allGamesAlreadyLockedWarning: string | null = null;
    let lateNcaaNotice: string | null = null;

    if (sport === "nfl") {
      const { data: slate, error: slateError } = await admin
        .from("games_cache")
        .select("id, kickoff")
        .eq("sport", "nfl")
        .eq("season", season)
        .eq("week", currentWeek);
      if (slateError) return new Response(JSON.stringify({ error: slateError.message }), { headers: corsHeaders, status: 500 });

      if (!slate || slate.length === 0) {
        // Schedule genuinely isn't cached yet — real count isn't knowable,
        // so fall back to a reasonable guess for the starting balance. The
        // league is still created; the user just needs to reopen it once
        // sync-schedule-odds has run.
        startingPoints = 10 * FALLBACK_GAMES_GUESS.nfl;
        scheduleNotCachedWarning = `League created, but Week ${currentWeek}'s NFL schedule isn't cached yet — run sync-schedule-odds, then try opening the league again.`;
      } else {
        const LOCK_MS = 5 * 60 * 1000;
        const lockThreshold = Date.now() + LOCK_MS;
        const pickableGames = slate.filter((g) => new Date(g.kickoff).getTime() > lockThreshold);

        if (pickableGames.length > 0) {
          gameIds = pickableGames.map((g) => g.id);
        } else {
          // Edge case: EVERY game this week has already locked. Rather than
          // leave the league half-set-up and unopenable, include the full
          // (all-locked) slate anyway — valid and viewable, just a forfeit
          // week for everyone.
          gameIds = slate.map((g) => g.id);
          allGamesAlreadyLockedWarning = `Heads up: every one of Week ${currentWeek}'s games had already locked by the time this league was created, so this week is a forfeit for everyone. Week ${currentWeek + 1} will work normally.`;
        }
        startingPoints = 10 * gameIds.length;
      }
    } else {
      const setup = await determineNcaaWeekSetup(admin, season, currentWeek);
      if (setup.mode === "auto") {
        gameIds = setup.gameIds;
        phase = "picking";
        startingPoints = 10 * gameIds.length;
      } else if (setup.mode === "auto_late") {
        // Created too close to this week's real kickoffs for a selection
        // window to make sense — 15 matchups were chosen automatically so
        // members have enough time to actually pick winners, same as a
        // missed regular deadline would do.
        gameIds = setup.gameIds;
        phase = "picking";
        startingPoints = 10 * gameIds.length;
        lateNcaaNotice = `This league was created close to Week ${currentWeek}'s kickoffs, so 15 matchups were chosen automatically to make sure there's enough time to pick winners. Manual selection is back to normal starting next week.`;
      } else {
        // Normal case: creator picks exactly 15 later — a correct
        // prediction of their eventual balance, not a guess.
        phase = "selecting";
        selectionDeadline = setup.selectionDeadline;
        startingPoints = 10 * FALLBACK_GAMES_GUESS.ncaa;
      }
    }

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

    const { data: league, error: leagueError } = await admin
      .from("leagues")
      .insert({
        name: name.trim(),
        sport,
        visibility,
        password_hash: passwordHash,
        invite_code: inviteCode,
        creator_id: user.id,
        season,
        week: currentWeek,
        starting_week: currentWeek,
        phase,
      })
      .select("id, name, sport, visibility, invite_code, season, week, starting_week, phase")
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

    // Set up the league's first playable week using the setup already
    // determined above. This reuses advance_week_commit (normally used to
    // move from one week to the next) since "set up the starting week" is
    // really the same operation as "advance into a week."
    const { error: weekError } = await admin.rpc("advance_week_commit", {
      p_league_id: league.id,
      p_next_week: currentWeek,
      p_phase: phase,
      p_pot_before: 0,
      p_selection_deadline: selectionDeadline,
      p_game_ids: gameIds,
    });
    if (weekError) {
      return new Response(JSON.stringify({ error: `League created, but Week ${currentWeek} setup failed: ${weekError.message}` }), {
        headers: corsHeaders,
        status: 500,
      });
    }

    if (lateNcaaNotice) {
      try {
        await sendPushToUsers(admin, [user.id], "League created — Week 1 auto-generated", lateNcaaNotice, {
          leagueId: league.id,
          week: currentWeek,
        });
      } catch (_err) {
        // A push failure shouldn't mask that the league itself was created successfully.
      }
    }

    const warning = scheduleNotCachedWarning ?? allGamesAlreadyLockedWarning ?? lateNcaaNotice;
    if (warning) {
      return new Response(JSON.stringify({ league, warning }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ league }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { headers: corsHeaders, status: 500 });
  }
});