/**
 * WARLORDS — Game State Model (server-authoritative contracts).
 *
 * Three representations live in the system (docs/ARCHITECTURE.md §4):
 *   1. Persistent state   — Prisma rows (BigInt amounts).
 *   2. Derived state      — computed by engines (production accrual, power, capacity).
 *   3. Projections (DTOs) — read-only shapes returned to the Mini App.
 *
 * DTOs here use `string` for BigInt-safe amounts (serialized by the API layer).
 * The client NEVER sends amounts that mutate state — only command intents.
 */

import type {
  BuildingType,
  ClanRole,
  Coordinate,
  LedgerResource,
  ReputationLevel,
  UnitClass,
} from './common'

// ── Resource projections ─────────────────────────────────────────────────────

export type ResourceAmounts = Record<LedgerResource, string> // BigInt → string

export interface WalletProjection {
  balances: ResourceAmounts
  capacity: string
  /** Server time anchor for client countdowns — device clocks are untrusted. */
  serverTime: string
}

export interface ProductionRates {
  goldPerHour: string
  woodPerHour: string
  ironPerHour: string
  foodPerHour: string
  crystalPerHour: string
}

export interface LedgerEntryProjection {
  id: string
  resource: LedgerResource
  delta: string
  balanceAfter: string
  reason: string
  createdAt: string
}

// ── Player & city projections ────────────────────────────────────────────────

export interface PlayerProfileProjection {
  id: string
  name: string
  avatarUrl: string | null
  level: number
  xp: string
  xpToNextLevel: string
  power: string
  honor: string
  reputation: ReputationLevel
  reputationScore: number
  energy: number
  energyMax: number
  energyRegenMinutes: number
  gems: string
  clanId: string | null
  clanRole: ClanRole | null
  createdAt: string
}

export interface BuildingProjection {
  type: BuildingType
  level: number
  isConstructing: boolean
  upgradeCompletesAt: string | null
  pendingLevel: number | null
  nextLevelCost: ResourceAmounts | null
  nextLevelDurationSec: number | null
  requirementsMet: boolean
  unmetRequirements: string[]
}

export interface CityProjection {
  id: string
  name: string
  coordinate: Coordinate
  buildings: BuildingProjection[]
  production: ProductionRates
  wallet: WalletProjection
}

// ── Army projections ─────────────────────────────────────────────────────────

export interface UnitStackProjection {
  unitTypeId: string
  name: string
  class: UnitClass
  count: number
  attack: number
  defense: number
  health: number
  speed: number
  foodUpkeep: number
  carryCapacity: number
  strongAgainst: string[]
  weakAgainst: string[]
}

export interface TrainingQueueItemProjection {
  id: string
  unitTypeId: string
  count: number
  completesAt: string
  status: string
}

export interface ArmyProjection {
  stacks: UnitStackProjection[]
  trainingQueue: TrainingQueueItemProjection[]
  totalFoodUpkeepPerHour: string
  marchCapacity: string
}

// ── Command intents (client → server, validated by Zod at the HTTP layer) ───

export interface UpgradeBuildingCommand {
  buildingType: BuildingType
}

export interface TrainUnitsCommand {
  unitTypeId: string
  count: number // validated 1..maxBatch server-side
}

/** Intent-only command — the server computes everything; no client-supplied fields allowed. */
export type CollectResourcesCommand = Record<string, never>

export interface AttackCommand {
  targetPlayerId?: string
  targetTerritoryId?: string
  /** Requested composition; validated against locked player units. */
  composition: Array<{ unitTypeId: string; count: number }>
}

export interface ScoutCommand {
  targetPlayerId?: string
  targetTerritoryId?: string
}

// ── Lazy-tick reconciliation ─────────────────────────────────────────────────

export interface ReconciliationResult {
  completedConstructions: BuildingType[]
  completedTraining: Array<{ unitTypeId: string; count: number }>
  completedResearch: string[]
  resolvedMarches: string[]
  energyRegenerated: number
  resourcesAccrued: ResourceAmounts
}

// ── Public profile (what OTHER players may see — SECURITY.md §2) ─────────────

export interface PublicPlayerProjection {
  id: string
  name: string
  avatarUrl: string | null
  level: number
  power: string
  honor: string
  reputation: ReputationLevel
  clanTag: string | null
  // NEVER included: wallet, army composition, technologies, inventory
}

export interface ScoutedPlayerInfo {
  scoutedAt: string
  expiresAt: string
  army: UnitStackProjection[] | 'HIDDEN' // fog of war — partial intel by scout success
  wallet: Partial<ResourceAmounts> | 'HIDDEN'
  defenseSummary: string | 'HIDDEN'
}
