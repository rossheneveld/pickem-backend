// supabase/functions/_shared/ncaaWeekSetup.ts
//
// Decides how a given NCAA week should actually be set up. Four cases:
//
// 1. PLAYOFFS: the real pool for that week is smaller than 15 games (the
//    playoff rounds all have far fewer, down to just the Championship) —
//    auto-assign every real game directly, exactly like NFL always does.
//    There's no meaningful "choice" left once the whole week's slate is
//    smaller than what you'd normally pick from.
//
// 2. WEEK 1 SPECIFICALLY: computeWeek's own clamp folds every early
//    "Week 0" game into week 1 too (some Power 4 openers kick off nearly
//    two full calendar weeks before the season's "real" Thursday start) —
//    meaning week 1's EARLIEST kickoff isn't a useful deadline anchor at
//    all; it reflects a small handful of bonus early games, not when the
//    bulk of that week's real slate actually happens. Anchored instead to
//    the LATEST kickoff in the week — the actual end of its real date
//    range — with a single Thursday-noon-before-the-last-games deadline,
//    rather than running the normal cascade off a start-of-week anchor
//    that would be misleadingly early for this one week only.
//
// 3. CREATED TOO LATE IN A NORMAL WEEK (week >= 2): a normal-sized pool
//    (>= 15) exists, but "now" is already close to (or past) that week's
//    earliest kickoff. Rather than hand out a selection deadline that
//    lands AFTER the games have already happened — which is what a naive
//    "next Wednesday" deadline would do for a league created mid-to-late
//    in a week — this computes the checkpoints relative to THAT WEEK'S
//    OWN earliest kickoff, not relative to whenever the league happens
//    to be created:
//      - before that week's own Wednesday noon ET -> normal full window
//      - between Wednesday noon and Thursday noon  -> shortened window
//      - at or after Thursday noon                 -> too late for any
//        meaningful selection window; auto-select 15 random games
//        immediately, same as a missed regular deadline would
//
// 4. NORMAL: plenty of time before this week's games — open the standard
//    selection window with a Wednesday-noon deadline.
//
// Used by both create-league and advanceWeekCore so this decision lives in
// exactly one place. Downstream functions that only ever act on a week
// still in 'selecting' phase (confirm-matchup-selection,
// auto-select-expired-matchups, notify-matchup-deadline) never need to
// know about any of this — if a week never enters 'selecting' to begin
// with, those functions simply never encounter it.

import { precedingWeekdayNoonEastern, nextMondayNoonEastern } from "./time.ts";

const NORMAL_MATCHUPS_PER_WEEK = 15;
const LOCK_MS = 5 * 60 * 1000;
const MONDAY = 1;
const WEDNESDAY = 3;
const THURSDAY = 4;

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type NcaaWeekSetup =
  | { mode: "auto"; gameIds: string[] }
  | { mode: "selecting"; selectionDeadline: string }
  | { mode: "auto_late"; gameIds: string[] };

export async function determineNcaaWeekSetup(admin: any, season: number, week: number): Promise<NcaaWeekSetup> {
  const { data: slate, error } = await admin
    .from("games_cache")
    .select("id, kickoff")
    .eq("sport", "ncaa")
    .eq("season", season)
    .eq("week", week);
  if (error) throw new Error(error.message);

  if (slate && slate.length > 0 && slate.length < NORMAL_MATCHUPS_PER_WEEK) {
    // Playoffs — auto-assign every game, same already-locked-game exclusion NFL always applies.
    const lockThreshold = Date.now() + LOCK_MS;
    const pickable = slate.filter((g: any) => new Date(g.kickoff).getTime() > lockThreshold);
    const gameIds = pickable.length > 0 ? pickable.map((g: any) => g.id) : slate.map((g: any) => g.id);
    return { mode: "auto", gameIds };
  }

  if (!slate || slate.length === 0) {
    // Schedule not published yet — can't compute checkpoints without a
    // real kickoff to anchor them to. Falls back to the old, simpler
    // "next Monday from now" deadline, exactly as before this timing logic
    // existed — this case is about missing data, not about being late.
    return { mode: "selecting", selectionDeadline: nextMondayNoonEastern(new Date()).toISOString() };
  }

  if (week === 1) {
    // See case 2 above — week 1's own earliest kickoff is a misleading
    // anchor, since it's really the first of an unusually long, nearly
    // two-week span. Anchor to the LAST game of the week instead.
    const latestKickoff = new Date(Math.max(...slate.map((g: any) => new Date(g.kickoff).getTime())));
    const deadline = precedingWeekdayNoonEastern(latestKickoff, THURSDAY);

    if (new Date() < deadline) {
      return { mode: "selecting", selectionDeadline: deadline.toISOString() };
    }

    // Created even later than that — genuinely too late for week 1 itself
    // to have any meaningful selection window left. Same auto-select
    // fallback as the normal too-late case below, including the same
    // safety net: if literally every game has already locked (real-world
    // time has passed the entire week), fall back to the full slate
    // anyway rather than end up with zero games and a broken league.
    const lockThreshold = Date.now() + LOCK_MS;
    const pickablePool = slate.filter((g: any) => new Date(g.kickoff).getTime() > lockThreshold);
    const poolToChooseFrom = pickablePool.length > 0 ? pickablePool : slate;
    const chosen = shuffle(poolToChooseFrom).slice(0, Math.min(NORMAL_MATCHUPS_PER_WEEK, poolToChooseFrom.length));
    return { mode: "auto_late", gameIds: chosen.map((g: any) => g.id) };
  }

  // Normal-sized pool — anchor the Wednesday/Thursday checkpoints to THIS
  // WEEK'S actual earliest kickoff, not to whenever "now" happens to be.
  const earliestKickoff = new Date(Math.min(...slate.map((g: any) => new Date(g.kickoff).getTime())));
  const wednesdayNoon = precedingWeekdayNoonEastern(earliestKickoff, WEDNESDAY);
  const thursdayNoon = precedingWeekdayNoonEastern(earliestKickoff, THURSDAY);
  const now = new Date();

  if (now < wednesdayNoon) {
    return { mode: "selecting", selectionDeadline: wednesdayNoon.toISOString() };
  }
  if (now < thursdayNoon) {
    return { mode: "selecting", selectionDeadline: thursdayNoon.toISOString() };
  }

  // Too late for any meaningful selection window — auto-select 15 random
  // games immediately, same as a missed regular deadline would, excluding
  // whatever's already locked. If literally every game has already
  // locked, fall back to the full slate anyway rather than end up with
  // zero games and a broken league.
  const lockThreshold = Date.now() + LOCK_MS;
  const pickablePool = slate.filter((g: any) => new Date(g.kickoff).getTime() > lockThreshold);
  const poolToChooseFrom = pickablePool.length > 0 ? pickablePool : slate;
  const chosen = shuffle(poolToChooseFrom).slice(0, Math.min(NORMAL_MATCHUPS_PER_WEEK, poolToChooseFrom.length));
  return { mode: "auto_late", gameIds: chosen.map((g: any) => g.id) };
}