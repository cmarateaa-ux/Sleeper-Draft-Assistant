import { getDraftPicks } from "../sleeper/client.js";
import { parseDraftUrl } from "../index.js";

export interface LiveDraftSession {
  draftId: string;
  lastPickNo: number;
  startedAt: number;
}

export interface DraftUpdate {
  newPickCount: number;
  latestPickNo: number;
}

export async function createSession(input: string): Promise<LiveDraftSession> {
  const draftId = parseDraftUrl(input);
  const picks = await getDraftPicks(draftId);
  return {
    draftId,
    lastPickNo: picks.reduce((max, pick) => Math.max(max, pick.pickNo), 0),
    startedAt: Date.now(),
  };
}

export async function pollSession(session: LiveDraftSession): Promise<DraftUpdate> {
  const picks = await getDraftPicks(session.draftId);
  const latestPickNo = picks.reduce((max, pick) => Math.max(max, pick.pickNo), 0);
  return {
    newPickCount: Math.max(0, latestPickNo - session.lastPickNo),
    latestPickNo,
  };
}
