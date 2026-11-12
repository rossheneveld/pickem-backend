// supabase/functions/notify-matchup-deadline/index.ts
//
// Runs every ~15 min. Finds NCAA league_weeks still in 'selecting' whose
// deadline is within the next 2 hours (and hasn't already passed — that's
// auto-select-expired-matchups' job, not this one) and hasn't been reminded
// about yet, and nudges just the creator — they're the only one who can
// act on it.
//
// Idempotent via selection_reminder_sent_at, same pattern as the other
// notification jobs.
//
// Deploy: supabase functions deploy notify-matchup-deadline
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPushToUsers } from "../_shared/push.ts";
import { recordHeartbeat } from "../_shared/heartbeat.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET");

const REMINDER_LEAD_MS = 2 * 60 * 60 * 1000; // remind once the deadline is within 2 hours

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: candidates, error: findError } = await admin
    .from("league_weeks")
    .select("id, week, matchup_selection_deadline, leagues (id, name, creator_id)")
    .eq("phase", "selecting")
    .is("selection_reminder_sent_at", null)
    .not("matchup_selection_deadline", "is", null);

  if (findError) return new Response(JSON.stringify({ error: findError.message }), { status: 500 });

  const now = Date.now();
  const due = (candidates ?? []).filter((lw: any) => {
    const deadline = new Date(lw.matchup_selection_deadline).getTime();
    return deadline - REMINDER_LEAD_MS <= now && deadline > now; // due, but not already expired
  });

  let remindersSent = 0;
  const errors: string[] = [];

  for (const lw of due as any[]) {
    try {
      const minutesLeft = Math.round((new Date(lw.matchup_selection_deadline).getTime() - now) / 60000);
      const hoursLeft = Math.floor(minutesLeft / 60);
      const timePhrase = hoursLeft >= 1 ? `${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}` : `${minutesLeft} minutes`;

      const { errors: sendErrors } = await sendPushToUsers(
        admin,
        [lw.leagues.creator_id],
        "Choose this week's matchups",
        `${lw.leagues.name}: you have ${timePhrase} left to pick Week ${lw.week}'s 15 games, or 15 will be chosen for you.`,
        { leagueId: lw.leagues.id, week: lw.week }
      );
      errors.push(...sendErrors);
      remindersSent++;

      await admin.from("league_weeks").update({ selection_reminder_sent_at: new Date().toISOString() }).eq("id", lw.id);
    } catch (err) {
      errors.push(String(err));
    }
  }

  await recordHeartbeat(admin, "notify-matchup-deadline", 15);
  return new Response(JSON.stringify({ weeksProcessed: due.length, remindersSent, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});