// client/joinFlow.ts
//
// Client-side surface for the real join-flow. Replaces the prototype's local
// `leagues` array and its startLeague()/inline password check. Password
// verification and hashing NEVER happen here — they happen inside the
// create-league / join-league Edge Functions, which this file just calls.

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);

export type LeagueSummary = {
  id: string;
  name: string;
  sport: "nfl" | "ncaa";
  visibility: "public" | "private";
  invite_code: string;
  season: number;
  week: number;
  phase: string;
};

async function callFunction<T>(name: string, payload: object): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Not logged in");

  const res = await fetch(`${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `${name} failed`);
  return json as T;
}

/** Creates a new league. Password (if private) is sent once, over HTTPS, and hashed server-side. */
export function createLeague(params: {
  name: string;
  sport: "nfl" | "ncaa";
  visibility: "public" | "private";
  password?: string;
  displayName: string;
}) {
  return callFunction<{ league: LeagueSummary }>("create-league", params);
}

/** Joins a league by invite code. Password (if required) is verified server-side, never client-side. */
export function joinLeagueByCode(params: { inviteCode: string; password?: string; displayName: string }) {
  return callFunction<{ league: LeagueSummary; alreadyMember: boolean; startingBalance?: number }>(
    "join-league",
    params
  );
}

/** Browses public leagues — permitted directly via RLS, no Edge Function needed. */
export async function browsePublicLeagues(searchText?: string): Promise<LeagueSummary[]> {
  let query = supabase
    .from("leagues")
    .select("id, name, sport, visibility, invite_code, season, week, phase")
    .eq("visibility", "public")
    .order("created_at", { ascending: false })
    .limit(50);

  if (searchText?.trim()) {
    query = query.ilike("name", `%${searchText.trim()}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * Leagues the current user is a member of — this is what powers the Home
 * screen list. Uses a join through league_members, which RLS already scopes
 * to "leagues you're a member of" automatically.
 */
export async function getMyLeagues(): Promise<Array<LeagueSummary & { balance: number; alive: boolean; rank: number | null }>> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("league_members")
    .select("balance, alive, leagues (id, name, sport, visibility, invite_code, season, week, phase)")
    .eq("user_id", user.id);

  if (error) throw error;

  // Rank requires knowing every member's balance in each league, so fetch
  // rosters in parallel rather than N+1 querying inside a loop.
  const leagueIds = (data ?? []).map((row: any) => row.leagues.id);
  const { data: allMembers } = await supabase
    .from("league_members")
    .select("league_id, user_id, balance")
    .in("league_id", leagueIds);

  return (data ?? []).map((row: any) => {
    const roster = (allMembers ?? [])
      .filter((m: any) => m.league_id === row.leagues.id)
      .sort((a: any, b: any) => b.balance - a.balance);
    const rankIdx = roster.findIndex((m: any) => m.user_id === user.id);
    return {
      ...row.leagues,
      balance: row.balance,
      alive: row.alive,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
    };
  });
}
