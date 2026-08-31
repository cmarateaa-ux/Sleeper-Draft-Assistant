export type ScoringFormat = "standard" | "half_ppr" | "ppr";
export type Position = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

export interface SleeperDraft {
  draftId: string;
  leagueId?: string;
  status: string;
  type: string;
  sport: "nfl";
  season: string;
  rounds?: number;
  pickTimer?: number;
  teams: number;
  scoringType?: string;
  draftOrder: Record<string, number>;
  slotToRosterId: Record<string, number>;
}

export interface SleeperPick {
  playerId: string;
  pickedBy?: string;
  rosterId: number;
  round: number;
  draftSlot: number;
  pickNo: number;
  metadata?: {
    firstName?: string;
    lastName?: string;
    position?: Position | string;
    team?: string;
  };
}

export interface SleeperRoster {
  rosterId: number;
  ownerId?: string;
  players: string[];
  starters: string[];
}

export interface SleeperLeague {
  leagueId: string;
  name?: string;
  totalRosters?: number;
  scoringSettings: Record<string, number>;
  rosterPositions: string[];
  settings: Record<string, number>;
  status: string;
}

export interface PlayerProfile {
  playerId: string;
  fullName: string;
  position: Position;
  team?: string;
  byeWeek?: number;
  active: boolean;
}

export interface ADPSignal {
  source: string;
  format: ScoringFormat;
  overallRank?: number;
  adp?: number;
  positionRank?: number;
  capturedAt: string;
}

export interface PlayerMarketProfile {
  player: PlayerProfile;
  signals: ADPSignal[];
  blendedAdp?: number;
  blendedRank?: number;
  rankVsAdp?: number;
}

export interface DraftState {
  draft: SleeperDraft;
  league?: SleeperLeague;
  rosters: SleeperRoster[];
  picks: SleeperPick[];
  players: Map<string, PlayerProfile>;
  userRosterId?: number;
  currentPickNo: number;
  currentDraftSlot?: number;
}

export interface Recommendation {
  playerId: string;
  playerName: string;
  position: Position;
  score: number;
  confidence: number;
  tag: "best_pick" | "value" | "need" | "scarcity";
  reasons: string[];
}
