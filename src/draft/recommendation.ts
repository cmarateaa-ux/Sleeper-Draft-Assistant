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

function needBonus(roster: SleeperRoster | undefined, state: DraftState, position: string): number {
  const counts = rosterPositionCounts(roster, state);
  const rosterSlots = state.league?.rosterPositions ?? [];
  const required = rosterSlots.filter((slot) => slot === position).length;
  const current = counts.get(position) ?? 0;
  if (required <= 0) return position === "RB" || position === "WR" ? 2 : 0;
  if (current < required) return 7;
  if (position === "RB" || position === "WR") return 2;
  return -1;
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
      const bonus = needBonus(roster, state, market.player.position);
      if (bonus >= 7) reasons.push(`fills a starting ${market.player.position} requirement`);

      return {
        playerId: market.player.playerId,
        playerName: market.player.fullName,
        position: market.player.position,
        score,
        confidence: Math.max(0.5, Math.min(0.95, 0.58 + (reasons.length - 1) * 0.08)),
        tag: adp !== undefined && rank !== 999 && adp - rank >= 2 ? "value" as const : bonus >= 7 ? "need" as const : "best_pick" as const,
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
