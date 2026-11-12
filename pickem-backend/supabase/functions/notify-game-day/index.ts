// supabase/functions/notify-game-day/index.ts
//
// Runs every ~15 minutes, but only actually does anything during the
// 8:00-8:44 AM ET window on any given day — checked in Eastern Time
// specifically, not UTC, since a fixed UTC cron time would silently drift
// an hour off across the DST switch in early November (the same class of
// bug found and fixed earlier in sync-live-scores).
//
// For each league currently mid-week with at least one game kicking off
// TODAY (in ET), sends a one-time "it's game day" reminder to every alive
// member. Idempotent via a unique (league_week_id, reminder_date)
// constraint — a run that happens to land inside the window twice (or a
// retry) never double-sends.
//
// Deploy: supabase functions deploy notify-game-day --no-verify-jwt
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/push.ts";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

function nowInEastern(): { hour: number; minute: number; dateStr: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  const hour = parseInt(parts.hour, 10) === 24 ? 0 : parseInt(parts.hour, 10);
  return { hour, minute: parseInt(parts.minute, 10), dateStr: `${parts.year}-${parts.month}-${parts.day}` };
}

function kickoffDateInEastern(kickoffIso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(kickoffIso))
      .map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { hour, minute, dateStr: today } = nowInEastern();

  // Outside the 8:00-8:44 AM ET window, this run has nothing to do. Still
  // records a heartbeat so monitoring reflects that the job itself is
  // alive and running, independent of whether it was ever due to act.
  if (hour !== 8 || minute >= 45) {
    await recordHeartbeat(admin, "notify-game-day", 60);
    return new Response(JSON.stringify({ skipped: true, reason: "outside 8am ET window" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: leagues, error: leaguesError } = await admin
    .from("leagues")
    .select("id, week, phase")
    .eq("phase", "picking");
  if (leaguesError) return new Response(JSON.stringify({ error: leaguesError.message }), { status: 500 });

  let remindersSent = 0;
  let pushesAccepted = 0;
  const errors: string[] = [];

  for (const league of leagues ?? []) {
    try {
      const { data: weekRow, error: weekError } = await admin
        .from("league_weeks")
        .select("id")
        .eq("league_id", league.id)
        .eq("week", league.week)
        .maybeSingle();
      if (weekError) throw new Error(weekError.message);
      if (!weekRow) continue;

      const { data: games, error: gamesError } = await admin
        .from("league_games")
        .select("games_cache (kickoff)")
        .eq("league_week_id", weekRow.id);
      if (gamesError) throw new Error(gamesError.message);

      const hasGameToday = (games ?? []).some(
        (g: any) => g.games_cache && kickoffDateInEastern(g.games_cache.kickoff) === today
      );
      if (!hasGameToday) continue;

      // The unique constraint does the real idempotency work — a conflict
      // here just means today's reminder for this league already went
      // out (an earlier run this same morning), nothing more to do.
      const { error: insertError } = await admin
        .from("game_day_reminders_sent")
        .insert({ league_week_id: weekRow.id, reminder_date: today });
      if (insertError) {
        if (insertError.code === "23505") continue;
        throw new Error(insertError.message);
      }

      const { data: members, error: membersError } = await admin
        .from("league_members")
        .select("user_id")
        .eq("league_id", league.id)
        .eq("alive", true);
      if (membersError) throw new Error(membersError.message);

      const userIds = (members ?? []).map((m: any) => m.user_id);
      if (userIds.length > 0) {
        const { sent, attempted, errors: sendErrors } = await sendPushToUsers(
          admin,
          userIds,
          "🏈 It's game day!",
          "Games kick off today — make sure your picks are in before they lock.",
          { leagueId: league.id }
        );
        errors.push(...sendErrors);
        remindersSent += userIds.length;
        pushesAccepted += sent;
        // Devices existed and not one accepted the message — release today's
        // claim so the next run inside the window can try again, instead of
        // silently using up the day's one reminder.
        if (attempted > 0 && sent === 0) {
          await admin
            .from("game_day_reminders_sent")
            .delete()
            .eq("league_week_id", weekRow.id)
            .eq("reminder_date", today);
        }
      }
    } catch (err) {
      errors.push(String(err));
    }
  }

  await recordHeartbeat(admin, "notify-game-day", 60);
  return new Response(JSON.stringify({ leaguesChecked: (leagues ?? []).length, remindersSent, pushesAccepted, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});