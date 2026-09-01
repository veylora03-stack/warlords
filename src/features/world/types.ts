/**
 * WARLORDS — World Map feature types (mirror of the server DTOs).
 *
 * These mirror src/lib/game/services/world.service.ts read models exactly
 * (TerritoryMapCell, WorldMapView, TerritoryDetailView, PlayerTerritoriesView,
 * TerritoryHistoryView, TerritoryAttackResult, TerritoryCollectResult);
 * nothing here is authoritative — terrain colors, attackability reasons,
 * production accrual, capture guards and every amount are server-computed and
 * arrive read-only through the REST envelope. Resource amounts cross as
 * strings (BigInt policy); all counters are JSON numbers.
 */

/** TERRITORY_TYPES (lib/game/types/common.ts) — world generator vocabulary. */
export type TerritoryType =
  | 'PLAYER_CITY'
  | 'NPC_VILLAGE'
  | 'RESOURCE_ZONE'
  | 'MINE'
  | 'FOREST'
  | 'MOUNTAIN'
  | 'BOSS_ZONE'
  | 'SPECIAL'

export type TerritoryStatus = 'UNCLAIMED' | 'CONTROLLED' | 'LOCKED'

export type TerritoryOwnerType = 'NONE' | 'PLAYER'

/** Terrain color families the server emits (config/world.ts TERRAIN color). */
export type TerrainColor =
  'lime' | 'emerald' | 'zinc' | 'amber' | 'teal' | 'yellow' | 'sky' | 'cyan' | 'orange'

export interface WorldBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface WorldSize {
  sizeX: number
  sizeY: number
}

export interface WorldRegionSummary {
  id: string
  name: string
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** One map cell — the shared projection used by map, detail and mutations. */
export interface TerritoryMapCell {
  id: string
  x: number
  y: number
  name: string | null
  type: TerritoryType
  terrain: string
  terrainLabel: string
  terrainColor: TerrainColor
  status: TerritoryStatus
  ownerType: TerritoryOwnerType
  ownerPlayerId: string | null
  ownerName: string | null
  isCapital: boolean
  regionId: string | null
  resourceType: string | null
  productionRate: number
  strategicValue: number
  /** Display resistance hint (garrison size for unclaimed cells). */
  defenseStrength: number
  captureCount: number
}

export interface WorldMapView {
  bounds: WorldBounds
  worldSize: WorldSize
  total: number
  territories: TerritoryMapCell[]
  regions: WorldRegionSummary[]
}

/** Why a territory cannot be attacked RIGHT NOW (server state only). */
export type AttackBlockerReason =
  | 'SEASON_NOT_ACTIVE'
  | 'OWNED_BY_YOU'
  | 'CAPITAL_PROTECTED'
  | 'LOCKED'
  | 'NOT_ADJACENT'
  | 'ARMY_EMPTY'
  | 'INSUFFICIENT_ENERGY'
  | 'ACTION_ON_COOLDOWN'

export interface TerritoryDetailView extends TerritoryMapCell {
  region: { id: string; name: string } | null
  attack: { attackable: boolean; reasons: AttackBlockerReason[] }
  /** Present when the CALLER owns this producing territory. */
  production: {
    collectible: boolean
    nextCollectAtMs: number | null
    pendingAmount: number
  } | null
}

/** The caller's own holdings — production readiness computed server-side. */
export interface PlayerTerritoryRow {
  id: string
  x: number
  y: number
  name: string | null
  isCapital: boolean
  terrain: string
  terrainLabel: string
  status: TerritoryStatus
  resourceType: string | null
  productionRate: number
  pendingAmount: number
  collectible: boolean
  nextCollectAtMs: number
  captureCount: number
}

export interface PlayerTerritoriesView {
  capital: PlayerTerritoryRow | null
  territories: PlayerTerritoryRow[]
  total: number
}

/** Append-only public world record reasons (schema comment vocabulary). */
export type TerritoryHistoryReason = 'CAPTURE' | 'SEASON_RESET' | 'ADMIN' | 'SPAWN'

export interface TerritoryHistoryRow {
  id: string
  reason: TerritoryHistoryReason
  seasonNumber: number
  previousOwner: { id: string | null; name: string | null }
  newOwner: { id: string | null; name: string | null }
  battleId: string | null
  createdAt: string
}

export interface TerritoryHistoryView {
  territory: { id: string; x: number; y: number; name: string | null }
  rows: TerritoryHistoryRow[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export type BattleOutcome = 'VICTORY' | 'DEFEAT' | 'DRAW'

export interface TerritoryAttackResult {
  battleId: string
  outcome: BattleOutcome
  result: 'ATTACKER_WIN' | 'DEFENDER_WIN' | 'DRAW'
  territory: {
    id: string
    x: number
    y: number
    name: string | null
    terrain: string
    captured: boolean
    captureCount: number
  }
  defender: { playerId: string | null; name: string }
  roundsCount: number
  seed: number
  configVersion: number
  casualties: {
    attacker: Array<{ unitId: string; unitName: string; count: number }>
    defender: Array<{ unitId: string; unitName: string; count: number }>
  }
  survivors: {
    attacker: Array<{ unitId: string; unitName: string; count: number }>
    defender: Array<{ unitId: string; unitName: string; count: number }>
  }
  /** Capture spoils (config-defined) — territory assaults never raid wallets. */
  spoils: Record<string, string>
  honor: { attackerDelta: number; defenderDelta: number }
  xp: { attackerGained: number; attackerLevel: number; attackerLevelsGained: number }
  seasonPointsAwarded: number
  energySpent: number
  cooldownUntil: string
  /** True when this response is a stored replay of an identical request. */
  replayed?: boolean
}

export interface TerritoryCollectResult {
  territoryId: string
  resourceType: string
  /** BigInt-crossing amount — string, display only. */
  amount: string
  nextCollectAtMs: number
  wallet: Record<string, string>
}
