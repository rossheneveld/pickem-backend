// supabase/functions/_shared/globalLeaderboard.ts
//
// Shared logic for a global (cross-league) leaderboard: rank every row in
// a view, resolve display names for whoever's actually being returned, and
// include the calling user's own row even if they're outside the visible
// top list. Used by both top-dog-leaderboard and pick-accuracy-leaderboard
// so this pattern exists in exactly one place, not two copies that could
// quietly drift apart.

const TOP_N = 25;

export async function buildGlobalLeaderboardResponse(
  admin: any,
  myUserId: string,
  viewName: string,
  selectColumns: string,
  orderColumn: string,
  tiebreakerColumn: string
) {
  const { data: allRows, error: viewError } = await admin
    .from(viewName)
    .select(selectColumns)
    .order(orderColumn, { ascending: false })
    .order(tiebreakerColumn, { ascending: false }); // more opportunities/picks ranks higher at an equal percentage
  if (viewError) throw new Error(viewError.message);

  const ranked = (allRows ?? []).map((row: any, i: number) => ({ ...row, rank: i + 1 }));
  const topRows = ranked.slice(0, TOP_N);
  const myRow = ranked.find((r: any) => r.user_id === myUserId) ?? null;

  const neededIds = new Set(topRows.map((r: any) => r.user_id));
  if (myRow) neededIds.add(myRow.user_id);

  let displayNames: Record<string, string> = {};
  let leagueNamesByUser: Record<string, string[]> = {};
  if (neededIds.size > 0) {
    const { data: nameRows, error: nameError } = await admin
      .from("league_members")
      .select("user_id, display_name, joined_at, leagues(name)")
      .in("user_id", Array.from(neededIds))
      .order("joined_at", { ascending: false });
    if (nameError) throw new Error(nameError.message);

    // Most-recently-joined row per user wins for display name, in case it
    // changed across leagues — but EVERY row's league name is collected,
    // since a player can belong to several leagues at once and all of
    // them are useful context on a cross-league leaderboard.
    for (const row of nameRows ?? []) {
      if (!displayNames[row.user_id]) displayNames[row.user_id] = row.display_name;
      const leagueName = row.leagues?.name;
      if (leagueName) {
        if (!leagueNamesByUser[row.user_id]) leagueNamesByUser[row.user_id] = [];
        if (!leagueNamesByUser[row.user_id].includes(leagueName)) {
          leagueNamesByUser[row.user_id].push(leagueName);
        }
      }
    }
  }

  const attachName = (row: any) => ({
    ...row,
    display_name: displayNames[row.user_id] ?? "Player",
    league_names: leagueNamesByUser[row.user_id] ?? [],
  });

  return {
    top: topRows.map(attachName),
    me: myRow ? attachName(myRow) : null,
  };
}