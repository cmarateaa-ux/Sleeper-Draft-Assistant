import { getDraftPicks, getDraft, getLeague, getPlayers, getRosters } from "./sleeper/client.js";
import type { DraftState, SleeperPick } from "./domain/types.js";

export async function loadDraftState(draftId: string): Promise<DraftState> {
  const draft = await getDraft(draftId);
  const [picks, players] = await Promise.all([getDraftPicks(draftId), getPlayers()]);
  const rosters = draft.leagueId ? await getRosters(draft.leagueId) : [];
  const league = draft.leagueId ? await getLeague(draft.leagueId) : undefined;
  const currentPickNo = picks.length + 1;
  const currentDraftSlot = draft.teams > 0 ? ((currentPickNo - 1) % draft.teams) + 1 : undefined;
  const userRosterId = currentDraftSlot === undefined ? undefined : draft.slotToRosterId[String(currentDraftSlot)];
  return {
    draft,
    rosters,
    picks,
    players,
    currentPickNo,
    ...(league ? { league } : {}),
    ...(userRosterId !== undefined ? { userRosterId } : {}),
    ...(currentDraftSlot !== undefined ? { currentDraftSlot } : {}),
  };
}

export function parseDraftUrl(input: string): string {
  const trimmed = input.trim();
  if (/^\d{10,}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split("/").filter(Boolean);
    const draftIndex = parts.findIndex((part) => part.toLowerCase() === "draft");
    if (draftIndex >= 0) {
      const candidate = parts[draftIndex + 2] ?? parts[draftIndex + 1];
      if (candidate && /^\d{10,}$/.test(candidate)) return candidate;
    }
  } catch {
    // Fall through to the simple path matcher below.
  }
  const match = trimmed.match(/(?:^|\/)draft\/(?:nfl\/)?(\d{10,})(?:[/?#]|$)/i);
  if (match?.[1]) return match[1];
  throw new Error("Enter a Sleeper draft URL or draft ID.");
}

export function picksSince(previous: SleeperPick[], current: SleeperPick[]): SleeperPick[] {
  const known = new Set(previous.map((pick) => pick.pickNo));
  return current.filter((pick) => !known.has(pick.pickNo)).sort((a, b) => a.pickNo - b.pickNo);
}
