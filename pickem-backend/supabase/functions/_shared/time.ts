// supabase/functions/_shared/time.ts
//
// Real calendar-based deadlines (not the prototype's compressed simulation)
// need correct America/New_York timezone handling, including the EST/EDT
// switch. This uses only built-in Intl — no timezone library dependency.

/** Returns the current UTC offset (in hours, negative) for America/New_York at the given instant. */
function easternOffsetHours(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });
  const part = fmt.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const match = part.match(/GMT([+-]\d+)/);
  return match ? parseInt(match[1], 10) : -5;
}

/**
 * The next Monday at 12:00 (noon) America/New_York, strictly after `from`.
 * If `from` is itself Monday before noon ET, returns *today* at noon ET.
 * If `from` is Monday at/after noon ET, returns *next* Monday.
 */
export function nextMondayNoonEastern(from: Date): Date {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(from)
      .map((p) => [p.type, p.value])
  );

  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const currentWeekday = weekdayMap[nyParts.weekday];
  const currentHourNY = parseInt(nyParts.hour, 10) === 24 ? 0 : parseInt(nyParts.hour, 10);

  let daysUntilMonday = (1 - currentWeekday + 7) % 7;
  if (daysUntilMonday === 0 && currentHourNY >= 12) {
    daysUntilMonday = 7; // already past noon Monday in NY — push to next week
  }

  const y = parseInt(nyParts.year, 10);
  const m = parseInt(nyParts.month, 10);
  const d = parseInt(nyParts.day, 10) + daysUntilMonday;

  // Rough UTC guess for "target date, noon", just to sample the correct
  // EST/EDT offset for that specific date (it can differ from `from`'s offset
  // if the target date crosses the DST boundary).
  const roughGuess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = easternOffsetHours(roughGuess);

  return new Date(Date.UTC(y, m - 1, d, 12 - offset, 0, 0));
}

const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The most recent occurrence of `targetWeekday` (0=Sun..6=Sat) at noon
 * America/New_York, on or before `before`. Unlike nextMondayNoonEastern
 * (which finds the next upcoming occurrence relative to "now"), this finds
 * the checkpoint that precedes a specific TARGET date — used to find "this
 * game week's own Monday/Thursday selection checkpoints" relative to that
 * week's actual earliest kickoff, regardless of what day a league happens
 * to be created on.
 */
export function precedingWeekdayNoonEastern(before: Date, targetWeekday: number): Date {
  const nyParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    })
      .formatToParts(before)
      .map((p) => [p.type, p.value])
  );

  const currentWeekday = WEEKDAY_MAP[nyParts.weekday];
  const daysSinceTarget = (currentWeekday - targetWeekday + 7) % 7;

  const y = parseInt(nyParts.year, 10);
  const m = parseInt(nyParts.month, 10);
  const d = parseInt(nyParts.day, 10) - daysSinceTarget;

  const roughGuess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = easternOffsetHours(roughGuess);

  return new Date(Date.UTC(y, m - 1, d, 12 - offset, 0, 0));
}

// Sourced from the real 2026 schedules (not guessed): NFL Week 1 begins
// Thu Sep 10, 2026; NCAA FBS Week 1 begins Thu Sep 3, 2026 (Week 0 games
// on Aug 29 fold into week 1 via the clamp in computeWeek below).
export const NFL_WEEK1_START = new Date("2026-09-10T00:00:00-04:00");
export const NCAA_WEEK1_START = new Date("2026-09-03T00:00:00-04:00");

/** Computes which week a game (or "right now") belongs to, given a season's
 * Week 1 start date. Shared by sync-schedule-odds (tagging fetched games)
 * and create-league (figuring out which real week a brand-new league should
 * actually start on — NOT always literal week 1, since a league created
 * partway through a season has no business being handed week-1 games that
 * already happened weeks ago). */
export function computeWeek(atISOOrDate: string | Date, seasonWeek1Start: Date): number {
  const date = typeof atISOOrDate === "string" ? new Date(atISOOrDate) : atISOOrDate;
  const diffDays = (date.getTime() - seasonWeek1Start.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(1, Math.floor(diffDays / 7) + 1);
}