import type { DraftState, PlayerMarketProfile, Recommendation, SleeperRoster } from "../domain/types.js";

export interface DraftValueInput {
  market: PlayerMarketProfile;
  drafted: Set<string>;
}

function rosterPositionCounts(roster: SleeperRoster | undefined, state: DraftState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const playerId of roster?.players ?? []) {
    const player = state.players.get(playerId);
    if (!player) continue;
    counts.set(player.position, (counts.get(player.position) ?? 0) + 1);
  }
  return counts;
}

function rosterContext(roster: SleeperRoster | undefined, state: DraftState, position: string): {
  current: number;
  required: number;
  flexSlots: number;
} {
  const counts = rosterPositionCounts(roster, state);
  const rosterSlots = state.league?.rosterPositions ?? [];
  const required = rosterSlots.filter((slot) => slot === position).length;
  const flexSlots = rosterSlots.filter((slot) => slot === "FLEX").length;
  return {
    current: counts.get(position) ?? 0,
    required,
    flexSlots,
  };
}

/**
 * Draft need is deliberately asymmetric: filling an empty starting requirement
 * is valuable, while adding a second player at an already-satisfied position
 * carries opportunity cost. This prevents a good QB2 from crowding out an
 * unmet RB/WR/FLEX need in a normal 1-QB build.
 */
function needBonus(roster: SleeperRoster | undefined, state: DraftState, position: string): number {
  const { current, required, flexSlots } = rosterContext(roster, state, position);

  if (required <= 0) {
    return position === "RB" || position === "WR" ? 3 : 0;
  }

  // Empty direct starting slots are the strongest roster signal.
  if (current < required) {
    if (position === "RB") return 12;
    if (position === "WR") return 8;
    if (position === "TE") return 5;
    return 6;
  }

  // Once a 1-QB league has its starter, QB2 is mostly insurance/bye-week
  // coverage. Require a meaningful market/value edge before recommending it.
  if (position === "QB" && required === 1 && current >= 1) return -18;

  // Same principle for TE2: useful depth, but usually less urgent than RB/WR
  // depth when FLEX spots are available.
  if (position === "TE" && current >= required) return -5;

  // RB/WR depth remains useful because FLEX spots can be filled by either.
  if ((position === "RB" || position === "WR") && flexSlots > 0) {
    return current < required + flexSlots ? 5 : 2;
  }

  return 0;
}

export function scorePlayer(input: DraftValueInput, state: DraftState): number {
  const { market, drafted } = input;
  if (drafted.has(market.player.playerId) || !market.player.fullName) return Number.NEGATIVE_INFINITY;

  const rank = market.blendedRank ?? market.blendedAdp ?? 999;
  const adp = market.blendedAdp ?? rank;
  const marketDiscount = Math.max(-10, Math.min(10, adp - rank));
  const baseline = Math.max(0, 120 - rank);
  const roster = state.userRosterId === undefined
    ? undefined
    : state.rosters.find((item) => item.rosterId === state.userRosterId);

  // Value remains the foundation, but roster context now has enough weight to
  // express real opportunity cost. An already-filled QB slot should not beat
  // an otherwise comparable RB/WR simply because the QB has a projection edge.
  return baseline + marketDiscount * 2 + needBonus(roster, state, market.player.position);
}

export function recommendPlayers(
  state: DraftState,
  marketProfiles: PlayerMarketProfile[],
  limit = 5,
): Recommendation[] {
  const drafted = new Set(state.picks.map((pick) => pick.playerId));

  return marketProfiles
    .map((market) => {
      const score = scorePlayer({ market, drafted }, state);
      const rank = market.blendedRank ?? market.blendedAdp ?? 999;
      const adp = market.blendedAdp;
      const reasons: string[] = [];

      if (adp !== undefined && adp - rank >= 2) {
        reasons.push(`market discount of about ${Math.round(adp - rank)} spots`);
      }
      reasons.push(`${market.player.position} value at this point in the draft`);

      const roster = state.userRosterId === undefined
        ? undefined
        : state.rosters.find((item) => item.rosterId === state.userRosterId);
      const context = rosterContext(roster, state, market.player.position);
      const bonus = needBonus(roster, state, market.player.position);

      if (bonus >= 5 && context.current < context.required) {
        reasons.push(`fills an immediate starting ${market.player.position} need`);
      } else if (bonus < 0) {
        reasons.push(`low roster priority with ${context.current} ${market.player.position} already rostered`);
      } else if ((market.player.position === "RB" || market.player.position === "WR") && context.flexSlots > 0) {
        reasons.push("adds useful FLEX depth");
      }

      return {
        playerId: market.player.playerId,
        playerName: market.player.fullName,
        position: market.player.position,
        score,
        confidence: Math.max(0.5, Math.min(0.95, 0.58 + (reasons.length - 1) * 0.08)),
        tag: adp !== undefined && rank !== 999 && adp - rank >= 2
          ? "value" as const
          : bonus >= 5
            ? "need" as const
            : "best_pick" as const,
        reasons,
      };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function createEmptyMarketProfiles(state: DraftState): PlayerMarketProfile[] {
  return [...state.players.values()]
    .filter((player) => player.active && player.position !== undefined)
    .map((player) => ({ player, signals: [] }));
}
