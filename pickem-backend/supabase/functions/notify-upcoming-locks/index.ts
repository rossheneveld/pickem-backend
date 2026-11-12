// supabase/functions/notify-upcoming-locks/index.ts
//
// Runs every ~10 minutes. Finds league_games locking within the next 30
// minutes that haven't been reminded about yet, and notifies only the
// members who haven't finalized a pick for that game — someone who already
// picked doesn't need a nag. This is the single highest-value notification
// in the app, given that a missed lock means an automatic forfeit with real
// consequences, not just a missed opportunity.
//
// Idempotent via lock_reminder_sent_at, same pattern as locked_notified_at —
// except a game is only marked once at least one device actually accepted
// the message. If every send failed, it's left unmarked so the next run
// (still before the lock) tries again, instead of silently using up the
// one reminder.
//
// Deploy: supabase functions deploy notify-upcoming-locks --no-verify-jwt
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/push.ts";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const LOCK_MS = 5 * 60 * 1000;
const REMINDER_LEAD_MS = 30 * 60 * 1000; // remind 30 minutes before LOCK (35 min before kickoff)

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = Date.now();

  // Only games whose lock falls inside the reminder window can be due, so
  // ask the database for just those. This used to fetch EVERY league_game
  // that hadn't been reminded yet — every future game, plus every past one
  // that never got a reminder — and filter in code. Supabase silently caps
  // a single query at 1,000 rows, so once enough leagues existed, the games
  // actually due could fall outside the rows returned and never be reminded.
  const kickoffAfter = new Date(now + LOCK_MS).toISOString(); // lock hasn't happened yet
  const kickoffUpTo = new Date(now + LOCK_MS + REMINDER_LEAD_MS).toISOString(); // lock is within 30 min

  const { data: candidates, error: findError } = await admin
    .from("league_games")
    .select("id, league_week_id, games_cache!inner (team_home, team_away, kickoff), league_weeks (league_id)")
    .is("lock_reminder_sent_at", null)
    .gt("games_cache.kickoff", kickoffAfter)
    .lte("games_cache.kickoff", kickoffUpTo);

  if (findError) return new Response(JSON.stringify({ error: findError.message }), { status: 500 });

  // Same window check again in code, as a safeguard.
  const due = (candidates ?? []).filter((lg: any) => {
    if (!lg.games_cache) return false;
    const lockTime = new Date(lg.games_cache.kickoff).getTime() - LOCK_MS;
    return lockTime - REMINDER_LEAD_MS <= now && lockTime > now; // due for a reminder, not already locked
  });

  let membersTargeted = 0;
  let pushesAccepted = 0;
  let devicesTried = 0;
  let willRetry = 0;
  const errors: string[] = [];

  for (const lg of due as any[]) {
    try {
      const leagueId = lg.league_weeks.league_id;

      const { data: members, error: membersError } = await admin
        .from("league_members")
        .select("user_id")
        .eq("league_id", leagueId)
        .eq("alive", true);
      if (membersError) throw new Error(membersError.message);

      const { data: existingPicks, error: picksError } = await admin
        .from("picks")
        .select("user_id")
        .eq("league_game_id", lg.id)
        .not("team", "is", null);
      if (picksError) throw new Error(picksError.message);

      const alreadyPicked = new Set((existingPicks ?? []).map((p: any) => p.user_id));
      const needsReminder = (members ?? [])
        .map((m: any) => m.user_id)
        .filter((uid: string) => !alreadyPicked.has(uid));

      let everySendFailed = false;
      if (needsReminder.length > 0) {
        const { sent, attempted, errors: sendErrors } = await sendPushToUsers(
          admin,
          needsReminder,
          "Picks locking soon",
          `${lg.games_cache.team_away} @ ${lg.games_cache.team_home} locks in about 30 minutes — make your pick!`,
          { leagueId, leagueGameId: lg.id }
        );
        errors.push(...sendErrors);
        membersTargeted += needsReminder.length;
        pushesAccepted += sent;
        devicesTried += attempted;
        // Devices existed and not one accepted the message — leave this game
        // unmarked so the next run (before the lock) tries again.
        everySendFailed = attempted > 0 && sent === 0;
      }

      if (everySendFailed) {
        willRetry += 1;
      } else {
        await admin.from("league_games").update({ lock_reminder_sent_at: new Date().toISOString() }).eq("id", lg.id);
      }
    } catch (err) {
      errors.push(String(err));
    }
  }

  await recordHeartbeat(admin, "notify-upcoming-locks", 10);
  return new Response(
    JSON.stringify({ gamesProcessed: due.length, membersTargeted, pushesAccepted, devicesTried, willRetry, errors }),
    { headers: { "Content-Type": "application/json" } }
  );
});