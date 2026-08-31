import type { SleeperDraft, SleeperLeague, SleeperPick, SleeperRoster, PlayerProfile } from "../domain/types.js";

const API = "https://api.sleeper.app/v1";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(API + path);
  if (!response.ok) throw new Error(`Sleeper API ${response.status}: ${path}`);
  return (await response.json()) as T;
}

export async function getDraft(draftId: string): Promise<SleeperDraft> {
  const raw = await getJson<Record<string, any>>(`/draft/${encodeURIComponent(draftId)}`);
  return {
    draftId: String(raw.draft_id),
    leagueId: raw.league_id ? String(raw.league_id) : undefined,
    status: String(raw.status),
    type: String(raw.type),
    sport: "nfl",
    season: String(raw.season),
    rounds: Number(raw.settings?.rounds ?? 0),
    pickTimer: Number(raw.settings?.pick_timer ?? 0),
    teams: Number(raw.settings?.teams ?? 0),
    scoringType: raw.metadata?.scoring_type ? String(raw.metadata.scoring_type) : undefined,
    draftOrder: (raw.draft_order ?? {}) as Record<string, number>,
    slotToRosterId: (raw.slot_to_roster_id ?? {}) as Record<string, number>,
  };
}

export async function getDraftPicks(draftId: string): Promise<SleeperPick[]> {
  const raw = await getJson<any[]>(`/draft/${encodeURIComponent(draftId)}/picks`);
  return raw.map((pick) => ({
    playerId: String(pick.player_id),
    pickedBy: pick.picked_by ? String(pick.picked_by) : undefined,
    rosterId: Number(pick.roster_id),
    round: Number(pick.round),
    draftSlot: Number(pick.draft_slot),
    pickNo: Number(pick.pick_no),
    metadata: pick.metadata ? {
      firstName: pick.metadata.first_name ? String(pick.metadata.first_name) : undefined,
      lastName: pick.metadata.last_name ? String(pick.metadata.last_name) : undefined,
      position: pick.metadata.position ? String(pick.metadata.position) : undefined,
      team: pick.metadata.team ? String(pick.metadata.team) : undefined,
    } : undefined,
  }));
}

export async function getLeague(leagueId: string): Promise<SleeperLeague> {
  const raw = await getJson<Record<string, any>>(`/league/${encodeURIComponent(leagueId)}`);
  return {
    leagueId: String(raw.league_id),
    name: raw.name ? String(raw.name) : undefined,
    totalRosters: raw.total_rosters ? Number(raw.total_rosters) : undefined,
    scoringSettings: (raw.scoring_settings ?? {}) as Record<string, number>,
    rosterPositions: Array.isArray(raw.roster_positions) ? raw.roster_positions.map(String) : [],
    settings: (raw.settings ?? {}) as Record<string, number>,
    status: String(raw.status),
  };
}

export async function getRosters(leagueId: string): Promise<SleeperRoster[]> {
  const raw = await getJson<any[]>(`/league/${encodeURIComponent(leagueId)}/rosters`);
  return raw.map((roster) => ({
    rosterId: Number(roster.roster_id),
    ownerId: roster.owner_id ? String(roster.owner_id) : undefined,
    players: Array.isArray(roster.players) ? roster.players.map(String) : [],
    starters: Array.isArray(roster.starters) ? roster.starters.map(String) : [],
  }));
}

export async function getPlayers(): Promise<Map<string, PlayerProfile>> {
  const raw = await getJson<Record<string, any>>("/players/nfl");
  const entries = Object.entries(raw).map(([id, value]) => {
    const positions = Array.isArray(value.fantasy_positions) ? value.fantasy_positions : [value.position];
    const position = String(positions.find((p: unknown) => ["QB","RB","WR","TE","K","DEF"].includes(String(p))) ?? value.position);
    return [id, {
      playerId: id,
      fullName: [value.first_name, value.last_name].filter(Boolean).join(" "),
      position: position as PlayerProfile["position"],
      team: value.team ? String(value.team) : undefined,
      byeWeek: value.bye_week ? Number(value.bye_week) : undefined,
      active: String(value.status ?? "") === "Active",
    }] as const;
  });
  return new Map(entries);
}
