/**
 * WARLORDS — World configuration (Phase 32: World Map + Territory Engine).
 *
 * The ONLY place world balance/policy numbers live (ARCHITECTURE.md rule).
 * The generator, the world service and the APIs read this config; rebalancing
 * never touches logic. Everything gameplay-relevant is SERVER-authoritative:
 * the client may request actions, but terrain, adjacency, ownership, capture,
 * rewards, production and visibility are decided here and in the services.
 *
 * Determinism: the world grid, regions, terrain and names are a PURE function
 * of (WORLD.seed, WORLD.sizeX, WORLD.sizeY, WORLD.regionSize) — see
 * engine/world/generator.ts. The same seed always generates the same world.
 *
 * Numeric policy: modifiers are BASIS POINTS (10_000 bps = 100%); production
 * rates are config units per hour; intervals in seconds.
 */

import type { TerrainType } from '@/lib/game/types/battle'
import { ECONOMY_RESOURCES, type EconomyResource } from './economy'

// ── Grid & seed ──────────────────────────────────────────────────────────────

export const WORLD = {
  /** Deterministic world seed — the same value ALWAYS generates the same map. */
  seed: 20260901,
  /** Grid bounds are INCLUSIVE: x ∈ [0, sizeX-1], y ∈ [0, sizeY-1]. */
  sizeX: 41,
  sizeY: 41,
  /** Regions are REGION_SIZE × REGION_SIZE grid blocks. */
  regionSize: 7,
  /** Config snapshot version — bump whenever any policy below changes. */
  version: 1,
} as const

/** Region count implied by the grid (6×6 = 36 for the 41×41 world). */
export function regionGridCount(sizeX: number = WORLD.sizeX, sizeY: number = WORLD.sizeY): number {
  return Math.ceil(sizeX / WORLD.regionSize) * Math.ceil(sizeY / WORLD.regionSize)
}

// ── Territory states & types ─────────────────────────────────────────────────

export const TERRITORY_STATUSES = ['UNCLAIMED', 'CONTROLLED', 'LOCKED'] as const
export type TerritoryStatus = (typeof TERRITORY_STATUSES)[number]

export const TERRITORY_OWNER_TYPES = ['NONE', 'PLAYER'] as const
export type TerritoryOwnerType = (typeof TERRITORY_OWNER_TYPES)[number]

/** TerritoryHistory.reason catalog (append-only record of ownership changes). */
export const TERRITORY_HISTORY_REASONS = [
  'CAPTURE', // won in a TERRITORY_ASSAULT
  'SEASON_RESET', // stripped by the season settlement
  'ADMIN', // operator action (RBAC + audited)
  'SPAWN', // capital allocated at player bootstrap
  'WORLD_INIT', // generator origin record (kept for completeness of the audit trail)
] as const
export type TerritoryHistoryReason = (typeof TERRITORY_HISTORY_REASONS)[number]

// ── Terrain catalog (data-driven combat + production modifiers) ──────────────

export interface TerrainDefinition {
  /** UI label (server-rendered; the client never supplies terrain text). */
  label: string
  /** ATTACKER damage modifier (bps) — mirrored into BATTLE.terrainAttackBps. */
  attackBps: number
  /** DEFENDER damage-taken reduction is expressed as a defense bonus (bps). */
  defenseBps: number
  /** Production multiplier for the cell's resource (bps above neutral 10_000). */
  productionMultiplierBps: number
  /** Relative generation weight (integer; weighted pick in the generator). */
  weight: number
  /** What this terrain produces when the cell is a producing territory. */
  resource: EconomyResource
  /** UI token (zinc-scale shades + icons resolved client-side from this key). */
  color: string
}

export const TERRAIN: Record<TerrainType, TerrainDefinition> = {
  PLAINS: {
    label: 'Plains',
    attackBps: 0,
    defenseBps: 0,
    productionMultiplierBps: 10_000,
    weight: 30,
    resource: 'FOOD',
    color: 'lime',
  },
  FOREST: {
    label: 'Forest',
    attackBps: -500,
    defenseBps: 500,
    productionMultiplierBps: 12_000,
    weight: 20,
    resource: 'WOOD',
    color: 'emerald',
  },
  MOUNTAINS: {
    label: 'Mountains',
    attackBps: -1000,
    defenseBps: 1000,
    productionMultiplierBps: 14_000,
    weight: 10,
    resource: 'IRON',
    color: 'zinc',
  },
  DESERT: {
    label: 'Desert',
    attackBps: -250,
    defenseBps: 0,
    productionMultiplierBps: 11_000,
    weight: 10,
    resource: 'GOLD',
    color: 'amber',
  },
  SWAMP: {
    label: 'Swamp',
    attackBps: -750,
    defenseBps: 750,
    productionMultiplierBps: 9_000,
    weight: 7,
    resource: 'FOOD',
    color: 'teal',
  },
  HILLS: {
    label: 'Hills',
    attackBps: -500,
    defenseBps: 500,
    productionMultiplierBps: 12_000,
    weight: 12,
    resource: 'GOLD',
    color: 'yellow',
  },
  RIVER: {
    label: 'River',
    attackBps: -750,
    defenseBps: 250,
    productionMultiplierBps: 13_000,
    weight: 6,
    resource: 'FOOD',
    color: 'sky',
  },
  COAST: {
    label: 'Coast',
    attackBps: -250,
    defenseBps: 250,
    productionMultiplierBps: 10_000,
    weight: 4,
    resource: 'CRYSTAL',
    color: 'cyan',
  },
  CITY: {
    label: 'City',
    attackBps: 0,
    defenseBps: 0,
    productionMultiplierBps: 10_000,
    weight: 0, // never generated — CITY cells are player capitals only
    resource: 'GOLD',
    color: 'orange',
  },
}

export const TERRAIN_TYPES: readonly TerrainType[] = Object.keys(TERRAIN) as TerrainType[]

/** Generator terrain pool (CITY excluded — capitals are allocated, not generated). */
export const GENERATION_TERRAIN_TYPES: readonly TerrainType[] = TERRAIN_TYPES.filter(
  (t) => t !== 'CITY',
)

// ── Attack & capture policy ──────────────────────────────────────────────────

export const WORLD_ATTACK = {
  /** Energy cost per territory assault (same combat economy as city raids). */
  energyCost: 10,
  /**
   * Shared army regroup window: a TERRITORY_ASSAULT respects the same
   * cooldown as a PVP_ATTACK (one army, one regroup clock) — the service
   * checks the latest battle of EITHER type.
   */
  /** Spoils credited to the attacker on capture, per strategic value point. */
  captureSpoilsPerStrategicValue: 25,
  /** Upper bound for capture spoils (per resource entry). */
  captureSpoilsCap: 2_500,
  /** Honor awarded to the attacker on capture. */
  captureHonor: 40,
  /** Honor awarded to a REAL defender for a successful territory defense. */
  defenseWinHonor: 20,
  /** XP to the attacker on a won assault / participation otherwise. */
  captureWinXp: 60,
  attackParticipationXp: 15,
  /** XP to a REAL defender on a successful defense / participation. */
  defenseWinXp: 35,
  defenseParticipationXp: 8,
  /** Season points awarded to the attacker on capture (ACTIVE season). */
  captureSeasonPoints: 20,
  /** Defense-win season points for a REAL defender. */
  defenseSeasonPoints: 10,
} as const

// ── Virtual garrison (unclaimed territories) ─────────────────────────────────

/**
 * Unclaimed territories are held by a DETERMINISTIC VIRTUAL GARRISON.
 * IMPORTANT (documented contract): the garrison is generated on the fly from
 * (WORLD.seed, x, y) and the REAL unit catalog — it is an NPC defender for
 * battle resolution only. It does NOT represent a real player army, it is
 * never persisted, its losses are never written to any player, and it cannot
 * be scouted, looted or reinforced.
 */
export const WORLD_GARRISON = {
  /** Base garrison size before distance/strategic scaling. */
  baseUnits: 6,
  /** Extra units per strategic-value point (strategic value is 1..10). */
  unitsPerStrategicValue: 2,
  /** Hard cap on total garrison units (bounds battle cost). */
  maxUnits: 120,
  /** Garrison composition by share (bps of the total, resolved to counts). */
  composition: {
    swordsman: 6_000,
    archer: 4_000,
  } as Record<string, number>,
  /** Deterministic per-cell composition jitter (±bps) — replayable variety. */
  jitterBps: 1_500,
  /** Garrison never hospitalizes losses. */
  hospitalBps: 0,
} as const

// ── Production (lazy collection) ─────────────────────────────────────────────

export const WORLD_PRODUCTION = {
  /** Minimum seconds between two collections of the same territory. */
  minIntervalSec: 300,
  /** Production accrual window cap (hours) — offline accrual is bounded. */
  capHours: 8,
  /** Base production (config units/hour) scaled by terrain multiplier. */
  baseRatePerHour: 30,
  /** Extra rate per strategic-value point. */
  ratePerStrategicValue: 6,
} as const

// ── Generation policy (special cells) ────────────────────────────────────────

export const WORLD_GENERATION = {
  /** Deterministically LOCKED special sites (ancient ruins — future content). */
  lockedCellCount: 6,
  /** Share (bps) of generated cells that produce resources. */
  producingCellBps: 2_500,
  /** Strategic value range [min..max] before the resource bonus. */
  strategicValueMin: 1,
  strategicValueMax: 5,
  /** Extra strategic value for producing cells. */
  strategicValueResourceBonus: 2,
} as const

// ── Naming (deterministic pools — server-rendered display names) ─────────────

export const REGION_NAME_PREFIX = [
  'Ashen',
  'Iron',
  'Golden',
  'Storm',
  'Silent',
  'Crimson',
  'Frozen',
  'Verdant',
  'Broken',
  'High',
  'Shadow',
  'Sun',
  'Mist',
  'Raven',
  'Wolf',
  'Thorn',
] as const

export const REGION_NAME_SUFFIX = [
  'Marches',
  'Reach',
  'Vale',
  'Waste',
  'Hold',
  'Barrens',
  'Uplands',
  'Lowlands',
  'Expanse',
  'Frontier',
  'Basin',
  'Ridge',
] as const

export const TERRITORY_NAME_PREFIX = [
  'Old',
  'Black',
  'Grey',
  'Wild',
  'Far',
  'Deep',
  'Red',
  'Pale',
  'Green',
  'Stony',
] as const

export const TERRITORY_NAME_SUFFIX = [
  'ford',
  'brook',
  'hollow',
  'gate',
  'fell',
  'moor',
  'crest',
  'watch',
  'stead',
  'march',
] as const

// ── Map API policy ───────────────────────────────────────────────────────────

export const WORLD_MAP_POLICY = {
  /** Max viewport area (cells) accepted by GET /world/map. */
  maxViewportArea: 441, // 21×21
  /** Default viewport side when the client sends no bounds. */
  defaultViewportRadius: 7, // capital-centered 15×15
  /** History page bounds. */
  historyDefaultLimit: 20,
  historyMaxLimit: 100,
} as const

// ── Admin policy ─────────────────────────────────────────────────────────────

export const WORLD_ADMIN = {
  /** Min length of the audit reason for ownership changes. */
  ownershipReasonMinLength: 4,
  ownershipReasonMaxLength: 300,
} as const

// ── Invariants (fail fast on config edits) ───────────────────────────────────

;((): void => {
  const problems: string[] = []
  if (!Number.isInteger(WORLD.seed) || WORLD.seed < 0) problems.push('seed must be non-negative')
  if (!Number.isInteger(WORLD.sizeX) || WORLD.sizeX < 1 || WORLD.sizeX > 256)
    problems.push('sizeX must be within 1..256')
  if (!Number.isInteger(WORLD.sizeY) || WORLD.sizeY < 1 || WORLD.sizeY > 256)
    problems.push('sizeY must be within 1..256')
  if (!Number.isInteger(WORLD.regionSize) || WORLD.regionSize < 1)
    problems.push('regionSize must be a positive integer')
  if (WORLD_ATTACK.energyCost < 0) problems.push('attack.energyCost must be non-negative')
  if (WORLD_ATTACK.captureSpoilsPerStrategicValue < 0)
    problems.push('captureSpoilsPerStrategicValue must be non-negative')
  if (WORLD_ATTACK.captureSpoilsCap < 0) problems.push('captureSpoilsCap must be non-negative')
  for (const [key, value] of Object.entries(WORLD_GARRISON.composition)) {
    if (typeof value !== 'number' || value <= 0 || value > 10_000)
      problems.push(`garrison.composition.${key} must be within 1..10000 bps`)
  }
  const compTotal = Object.values(WORLD_GARRISON.composition).reduce((a, b) => a + b, 0)
  if (compTotal !== 10_000) problems.push('garrison.composition must total 10_000 bps')
  if (WORLD_GARRISON.jitterBps < 0 || WORLD_GARRISON.jitterBps > 5_000)
    problems.push('garrison.jitterBps must be within 0..5000')
  if (WORLD_PRODUCTION.minIntervalSec < 0) problems.push('production.minIntervalSec >= 0')
  if (WORLD_PRODUCTION.capHours < 1) problems.push('production.capHours must be >= 1')
  if (WORLD_PRODUCTION.baseRatePerHour < 0) problems.push('production.baseRatePerHour >= 0')
  if (WORLD_GENERATION.producingCellBps < 0 || WORLD_GENERATION.producingCellBps > 10_000)
    problems.push('generation.producingCellBps must be within 0..10000')
  for (const terrain of GENERATION_TERRAIN_TYPES) {
    const def = TERRAIN[terrain]
    if (def.weight <= 0) problems.push(`terrain ${terrain} must have a positive weight`)
    if (def.attackBps < -10_000 || def.attackBps > 10_000)
      problems.push(`terrain ${terrain} attackBps out of range`)
    if (def.defenseBps < 0 || def.defenseBps > 10_000)
      problems.push(`terrain ${terrain} defenseBps out of range`)
    if (!ECONOMY_RESOURCES.includes(def.resource))
      problems.push(`terrain ${terrain} resource must be an economy resource`)
  }
  if (problems.length > 0) throw new Error(`Invalid WORLD config: ${problems.join('; ')}`)
})()
