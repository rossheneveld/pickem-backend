// client/useLeaguePicks.ts
//
// Live picks for one league week, combining two Realtime subscriptions:
//
//  1. `picks` changes for this week's games — mainly useful for your own
//     edits syncing instantly across your own devices.
//  2. `league_games` changes for this week — specifically watching
//     `locked_notified_at` (see touch-locked-picks + migration 006). This
//     is the actual fix for the core problem: RLS visibility for picks is
//     TIME-based (kickoff - 5min <= now()), and Realtime can only push
//     notifications for actual row changes — it has no way to notice time
//     passing on its own. touch-locked-picks makes a real write the moment
//     a game locks; that write IS an event Realtime can deliver, and it's
//     this hook's cue to re-fetch that game's picks, which RLS now
//     correctly includes every league member's pick in.
//
// RECONNECTION NOTE: the underlying Realtime client already reconnects its
// websocket automatically with backoff — that's not reimplemented here.
// What IS handled here is different: a dropped connection doesn't
// retroactively deliver events that happened while it was down (e.g. two
// games locked during a 90-second dead zone on the subway). So this hook
// does a full refetch whenever a channel comes back to SUBSCRIBED after
// having dropped, and whenever the app returns to the foreground — both
// are "we might have missed something, resync from scratch" safety nets
// layered on top of the event stream, not a replacement for it.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
);

export type PickRow = {
  id: string;
  league_game_id: string;
  user_id: string;
  team: string | null;
  points: number | null;
  outcome: string | null;
  shares: number;
  bonus_points: number;
  points_delta: number | null;
  updated_at: string;
};

export function useLeaguePicks(leagueWeekId: string, leagueGameIds: string[]) {
  const [picksByGame, setPicksByGame] = useState<Record<string, PickRow[]>>({});

  const refetchGame = useCallback(async (leagueGameId: string) => {
    const { data, error } = await supabase.from("picks").select("*").eq("league_game_id", leagueGameId);
    if (error) {
      console.warn("useLeaguePicks: refetchGame failed", leagueGameId, error.message);
      return;
    }
    setPicksByGame((prev) => ({ ...prev, [leagueGameId]: data ?? [] }));
  }, []);

  const refetchAll = useCallback(async (gameIds: string[]) => {
    if (gameIds.length === 0) {
      setPicksByGame({});
      return;
    }
    const { data, error } = await supabase.from("picks").select("*").in("league_game_id", gameIds);
    if (error) {
      console.warn("useLeaguePicks: refetchAll failed", error.message);
      return;
    }
    const grouped: Record<string, PickRow[]> = {};
    for (const row of (data ?? []) as PickRow[]) {
      (grouped[row.league_game_id] ??= []).push(row);
    }
    setPicksByGame(grouped);
  }, []);

  useEffect(() => {
    refetchAll(leagueGameIds);
    if (leagueGameIds.length === 0) return;

    const gameIdList = leagueGameIds.join(",");

    // Tracks whether each channel has ever dropped, so we only treat a
    // SUBSCRIBED status as a "reconnect" (worth resyncing for) the second
    // time it fires, not the very first initial subscribe.
    let picksHasDropped = false;
    let lockSignalHasDropped = false;

    const picksChannel = supabase
      .channel(`picks-week-${leagueWeekId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "picks", filter: `league_game_id=in.(${gameIdList})` },
        (payload) => {
          const row = (payload.new ?? payload.old) as PickRow;
          if (row?.league_game_id) refetchGame(row.league_game_id);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && picksHasDropped) {
          refetchAll(leagueGameIds); // reconnected after a drop — resync everything, not just new events
        }
        if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
          picksHasDropped = true;
        }
      });

    // The lock SIGNAL — see file header. This, not the channel above, is
    // what makes "another member's pick just became visible" actually work.
    const lockSignalChannel = supabase
      .channel(`league-games-week-${leagueWeekId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "league_games", filter: `league_week_id=eq.${leagueWeekId}` },
        (payload: any) => {
          if (payload.new?.locked_notified_at && payload.new?.id) {
            refetchGame(payload.new.id);
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED" && lockSignalHasDropped) {
          refetchAll(leagueGameIds); // same reasoning as above — a dropped lock-signal channel could have missed a lock
        }
        if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
          lockSignalHasDropped = true;
        }
      });

    return () => {
      supabase.removeChannel(picksChannel);
      supabase.removeChannel(lockSignalChannel);
    };
    // leagueGameIds is intentionally joined to a string for the dependency
    // check below — comparing by array identity would resubscribe every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueWeekId, leagueGameIds.join(",")]);

  // Foreground safety net: a backgrounded app can have its socket silently
  // die without ever firing CLOSED/TIMED_OUT (the OS just suspends it), so
  // this catches cases the channel-status listener above might miss.
  const appState = useRef(AppState.currentState);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (appState.current.match(/inactive|background/) && nextState === "active") {
        refetchAll(leagueGameIds);
      }
      appState.current = nextState;
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leagueGameIds.join(",")]);

  /** Your own pick for a game — always visible to you regardless of lock state. */
  const myPickFor = useCallback(
    (leagueGameId: string, userId: string) =>
      (picksByGame[leagueGameId] ?? []).find((p) => p.user_id === userId) ?? null,
    [picksByGame]
  );

  /** Everything currently visible to you for a game — just your own before lock, everyone's after (via RLS). */
  const picksFor = useCallback((leagueGameId: string) => picksByGame[leagueGameId] ?? [], [picksByGame]);

  return { picksByGame, picksFor, myPickFor };
}
