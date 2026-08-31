import { getDraft, getDraftPicks, getLeague, getPlayers, getRosters } from "./sleeper/client.js";
import type { DraftState, SleeperPick } from "./domain/types.js";

export async function loadDraftState(draftId: string): Promise<DraftState> {
  const draft = await getDraft(draftId);
  const [picks, players] = await Promise.all([
    getDraftPicks(draftId),
    getPlayers(),
  ]);
  const rosters = draft.leagueId ? await getRosters(draft.leagueId) : [];
  const league = draft.leagueId ? await getLeague(draft.leagueId) : undefined;
  const currentPickNo = picks.length + 1;
  const currentDraftSlot = draft.teams > 0
    ? ((currentPickNo - 1) % draft.teams) + 1
    : undefined;
  const userRosterId = currentDraftSlot === undefined
    ? undefined
    : draft.slotToRosterId[String(currentDraftSlot)];

  return {
    draft,
    league,
    rosters,
    picks,
    players,
    ...(userRosterId !== undefined ? { userRosterId } : {}),
    currentPickNo,
    ...(currentDraftSlot !== undefined ? { currentDraftSlot } : {}),
  };
}

export function parseDraftUrl(input: string): string {
  const trimmed = input.trim();
  const direct = trimmed.match(/^\d{15,}$/);
  if (direct) return direct[0];
  const match = trimmed.match(/draft\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  throw new Error("Enter a Sleeper draft ID or a Sleeper draft URL.");
}

export function picksSince(previous: SleeperPick[], current: SleeperPick[]): SleeperPick[] {
  const known = new Set(previous.map((pick) => pick.pickNo));
  return current.filter((pick) => !known.has(pick.pickNo)).sort((a, b) => a.pickNo - b.pickNo);
}
