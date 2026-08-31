import type { SleeperDraft, SleeperLeague, SleeperPick, SleeperRoster, PlayerProfile } from "../domain/types.js";

const API = "https://api.sleeper.app/v1";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(API + path);
  if (!response.ok) throw new Error(`Sleeper API ${response.status}: ${path}`);
  return (await response.json()) as T;
}

export async function getDraft(draftId: string): Promise<SleeperDraft> {
  const raw = await getJson<Record<string, any>>(`/draft/${encodeURIComponent(draftId)}`);
  const result: SleeperDraft = {
    draftId: String(raw.draft_id), status: String(raw.status), type: String(raw.type), sport: "nfl", season: String(raw.season),
    rounds: Number(raw.settings?.rounds ?? 0), pickTimer: Number(raw.settings?.pick_timer ?? 0), teams: Number(raw.settings?.teams ?? 0),
    draftOrder: (raw.draft_order ?? {}) as Record<string, number>, slotToRosterId: (raw.slot_to_roster_id ?? {}) as Record<string, number>,
  };
  if (raw.league_id) result.leagueId = String(raw.league_id);
  if (raw.metadata?.scoring_type) result.scoringType = String(raw.metadata.scoring_type);
  return result;
}

export async function getDraftPicks(draftId: string): Promise<SleeperPick[]> {
  const raw = await getJson<any[]>(`/draft/${encodeURIComponent(draftId)}/picks`);
  return raw.map((pick) => {
    const result: SleeperPick = { playerId: String(pick.player_id), rosterId: Number(pick.roster_id), round: Number(pick.round), draftSlot: Number(pick.draft_slot), pickNo: Number(pick.pick_no) };
    if (pick.picked_by) result.pickedBy = String(pick.picked_by);
    if (pick.metadata) {
      result.metadata = {};
      if (pick.metadata.first_name) result.metadata.firstName = String(pick.metadata.first_name);
      if (pick.metadata.last_name) result.metadata.lastName = String(pick.metadata.last_name);
      if (pick.metadata.position) result.metadata.position = String(pick.metadata.position);
      if (pick.metadata.team) result.metadata.team = String(pick.metadata.team);
    }
    return result;
  });
}

export async function getLeague(leagueId: string): Promise<SleeperLeague> {
  const raw = await getJson<Record<string, any>>(`/league/${encodeURIComponent(leagueId)}`);
  const result: SleeperLeague = { leagueId: String(raw.league_id), scoringSettings: (raw.scoring_settings ?? {}) as Record<string, number>, rosterPositions: Array.isArray(raw.roster_positions) ? raw.roster_positions.map(String) : [], settings: (raw.settings ?? {}) as Record<string, number>, status: String(raw.status) };
  if (raw.name) result.name = String(raw.name);
  if (raw.total_rosters) result.totalRosters = Number(raw.total_rosters);
  return result;
}

export async function getRosters(leagueId: string): Promise<SleeperRoster[]> {
  const raw = await getJson<any[]>(`/league/${encodeURIComponent(leagueId)}/rosters`);
  return raw.map((roster) => {
    const result: SleeperRoster = { rosterId: Number(roster.roster_id), players: Array.isArray(roster.players) ? roster.players.map(String) : [], starters: Array.isArray(roster.starters) ? roster.starters.map(String) : [] };
    if (roster.owner_id) result.ownerId = String(roster.owner_id);
    return result;
  });
}

export async function getPlayers(): Promise<Map<string, PlayerProfile>> {
  const raw = await getJson<Record<string, any>>("/players/nfl");
  return new Map(Object.entries(raw).map(([id, value]) => {
    const positions = Array.isArray(value.fantasy_positions) ? value.fantasy_positions : [value.position];
    const position = String(positions.find((p: unknown) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(String(p))) ?? value.position) as PlayerProfile["position"];
    const result: PlayerProfile = { playerId: id, fullName: [value.first_name, value.last_name].filter(Boolean).join(" "), position, active: String(value.status ?? "") === "Active" };
    if (value.team) result.team = String(value.team);
    if (value.bye_week) result.byeWeek = Number(value.bye_week);
    return [id, result] as const;
  }));
}
