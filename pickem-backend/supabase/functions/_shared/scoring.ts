// supabase/functions/_shared/scoring.ts
//
// Ported from the app's scoring.js — logic is intentionally byte-for-byte
// identical in behavior, just with `export function` instead of
// `module.exports` for Deno/ESM. If scoring.js ever changes, this file
// needs the same change made here, or client-side and server-side scoring
// will silently drift apart.
//
// NOTE: this was verified against the CURRENT app (App.js), not the
// original Jest-tested scoring.js snapshot — the leftover-balance rule was
// changed after that snapshot was taken (unwagered points are now
// forfeited to the pot, not carried forward). This file reflects that
// current behavior.

export type Pick = { gameId: string; team: string | null; points: number; forfeited?: boolean };
export type Game = { favorite: string; underdog: string; spread: number };
export type Outcome = string | "TIE";

export type PickDetail = {
  gameId: string;
  picked: string | null;
  points: number;
  winner: Outcome;
  correct: boolean | null;
  pickedUnderdog: boolean;
  tie: boolean;
  forfeited: boolean;
  shares: number;
};

export type ScoreResult = {
  kept: number;
  lost: number;
  shares: number;
  leftover: number;
  detail: PickDetail[];
};

/** Non-integer spreads round down toward zero for share math (+6.5 -> 6). */
export function spreadMultiplier(spread: number): number {
  return Math.floor(Math.abs(spread));
}

/** Per-game minimum wager drops from 5 to 1 once balance is thin relative to the slate. */
export function getMinPerGame(balance: number, gamesCount: number): number {
  return balance < 5 * gamesCount ? 1 : 5;
}

/** True once a player can't even cover 1 pt/game across the whole slate. */
export function isLockedToFirstOnly(balance: number, gamesCount: number): boolean {
  return gamesCount > 0 && balance < gamesCount;
}

/** Scores one player's picks for a single week. */
export function scorePlayerWeek(params: {
  picks: Pick[];
  gamesById: Record<string, Game>;
  outcomes: Record<string, Outcome>;
  balance: number;
}): ScoreResult {
  const { picks, gamesById, outcomes, balance } = params;
  let kept = 0;
  let lost = 0;
  let shares = 0;
  let wagered = 0;
  const detail: PickDetail[] = [];

  picks.forEach((pk) => {
    const game = gamesById[pk.gameId];
    const winner = outcomes[pk.gameId];
    wagered += pk.points;

    if (pk.forfeited) {
      // Auto-lost unconditionally — even if the game ties.
      lost += pk.points;
      detail.push({
        gameId: pk.gameId, picked: null, points: pk.points, winner,
        correct: false, pickedUnderdog: false, tie: false, forfeited: true, shares: 0,
      });
      return;
    }

    if (winner === "TIE") {
      // Push — wagered points returned, no gain, no loss, no shares.
      kept += pk.points;
      detail.push({
        gameId: pk.gameId, picked: pk.team, points: pk.points, winner,
        correct: null, pickedUnderdog: false, tie: true, forfeited: false, shares: 0,
      });
      return;
    }

    const correct = pk.team === winner;
    const pickedUnderdog = pk.team === game.underdog;
    let pickShares = 0;

    if (correct) {
      kept += pk.points;
      if (pickedUnderdog) {
        pickShares = pk.points * spreadMultiplier(game.spread);
        shares += pickShares;
      }
    } else {
      lost += pk.points;
    }

    detail.push({
      gameId: pk.gameId, picked: pk.team, points: pk.points, winner,
      correct, pickedUnderdog, tie: false, forfeited: false, shares: pickShares,
    });
  });

  const leftover = Math.max(0, balance - wagered);
  lost += leftover; // unwagered points are forfeited to the bonus pot (current rule — see file header)

  return { kept, lost, shares, leftover, detail };
}

export type PotResult = {
  pot: number;
  totalShares: number;
  payoutPerShare: number;
  newCarryover: number;
  bonusByPlayer: Record<string, number>;
};

/**
 * Distributes the bonus pot across players proportional to shares earned.
 * If nobody earned a share, the whole pot (including carryover) rolls to next week.
 */
export function distributePot(params: {
  potCarryover: number;
  playerResults: Record<string, { lost: number; shares: number }>;
}): PotResult {
  const { potCarryover, playerResults } = params;
  let totalLost = 0;
  const shareEntries: { playerId: string; shares: number }[] = [];

  Object.entries(playerResults).forEach(([id, r]) => {
    totalLost += r.lost;
    if (r.shares > 0) shareEntries.push({ playerId: id, shares: r.shares });
  });

  const pot = potCarryover + totalLost;
  const totalShares = shareEntries.reduce((a, b) => a + b.shares, 0);
  const bonusByPlayer: Record<string, number> = {};
  let payoutPerShare = 0;
  let newCarryover: number;

  if (totalShares > 0) {
    payoutPerShare = Math.floor((pot / totalShares) * 100) / 100;
    let distributed = 0;
    Object.entries(playerResults).forEach(([id, r]) => {
      const bonus = Math.floor(r.shares * payoutPerShare);
      bonusByPlayer[id] = bonus;
      distributed += bonus;
    });
    newCarryover = pot - distributed;
  } else {
    Object.keys(playerResults).forEach((id) => { bonusByPlayer[id] = 0; });
    newCarryover = pot;
  }

  return { pot, totalShares, payoutPerShare, newCarryover, bonusByPlayer };
}
