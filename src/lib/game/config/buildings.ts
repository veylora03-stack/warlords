/**
 * WARLORDS — Building catalog (Phase 6: City & Building System).
 *
 * The ONLY place building balance numbers live (ARCHITECTURE.md rule):
 * per-level upgrade costs, construction durations, requirements and effects
 * are defined here and materialized by pure functions — rebalancing never
 * touches logic. The city service consumes these; the catalog API
 * materializes every level so clients render exact numbers without ever
 * doing authority math.
 *
 * Numeric policy (ARCHITECTURE.md §4.4):
 *  - Costs and durations are integers materialized by an INTEGER-ONLY
 *    recurrence (floor multiply by growth bps) — no floating point.
 *  - Percentages/ratios are BASIS POINTS: 10_000 bps = 100% = "no change",
 *    12_000 bps = +20% faster/stronger.
 *  - Costs stay far below Number.MAX_SAFE_INTEGER and below the economy
 *    MAX_DELTA ceiling (asserted by unit tests).
 *
 * Requirements are evaluated SERVER-SIDE from real DB state at upgrade
 * time — the client can never claim a requirement is satisfied.
 */

import type { BuildingType, Resource } from '@/lib/game/types/common'
import { BUILDING_TYPES } from '@/lib/game/types/common'

// ── Level bounds ─────────────────────────────────────────────────────────────

/** Maximum level for every building except the ones with a tighter cap below. */
export const BUILDING_MAX_LEVEL = 15

/** Player level a TOWN_HALL upgrade to `level` requires (linear, level-1). */
export const TOWN_HALL_PLAYER_LEVEL_OFFSET = 1

/** CASTLE upgrades are gated harder: TH level ≥ castle target + this offset. */
export const CASTLE_TOWN_HALL_OFFSET = 4

/** Queue slots unlocked when the Town Hall reaches this level. */
export const EXTRA_QUEUE_SLOT_TOWN_HALL_LEVEL = 10

// ── Types ────────────────────────────────────────────────────────────────────

export type BuildingCategory = 'CORE' | 'MILITARY' | 'ECONOMY' | 'DEFENSE' | 'SUPPORT'

export interface BuildingRequirements {
  /** Town Hall must already be at this level (the building's own row excluded). */
  townHallLevel?: number
  /** Player level must be ≥ this. */
  playerLevel?: number
  /** Other buildings must already be at these levels. */
  buildings?: Partial<Record<BuildingType, number>>
}

/** Production yields per real hour, aggregated by the city service. */
export interface BuildingProduction {
  GOLD?: number
  WOOD?: number
  IRON?: number
  FOOD?: number
}

export interface BuildingEffects {
  /** Resources produced per hour at this level (production buildings). */
  productionPerHour?: BuildingProduction
  /** Total storage capacity the warehouse supports at this level. */
  storageCapacity?: number
  /** Defense modifier in bps (WALL): 10_000 = neutral, 16_000 = +60%. */
  defenseBps?: number
  /** Simultaneous constructions allowed (TOWN_HALL). */
  queueSlots?: number
  /** Unit training speed in bps (military camps): 10_000 = base speed. */
  trainingSpeedBps?: number
  /** Equipment upgrade speed in bps (ARMORY, consumed by a later phase). */
  equipmentSpeedBps?: number
  /** Research speed in bps (ACADEMY, consumed by the technology phase). */
  researchSpeedBps?: number
  /** Wounded capacity (HOSPITAL, consumed by the battle phase). */
  hospitalCapacity?: number
  /** Simultaneous marches (CASTLE, consumed by the world/march phase). */
  marchSlots?: number
  /** Scout march speed in bps (SCOUT_CENTER). */
  scoutSpeedBps?: number
  /** Espionage power in bps (SPY_CENTER). */
  spyPowerBps?: number
  /** Market fee in bps (MARKET) — higher level, lower fee. */
  marketFeeBps?: number
}

export interface BuildingLevelSpec {
  level: number
  /** Cost to UPGRADE TO this level (empty for level 1 — already built). */
  cost: Partial<Record<Resource, number>>
  /** Construction duration in seconds for the upgrade TO this level. */
  durationSec: number
  requirements: BuildingRequirements
  effects: BuildingEffects
}

export interface BuildingCatalogEntry {
  type: BuildingType
  name: string
  category: BuildingCategory
  description: string
  maxLevel: number
  levels: BuildingLevelSpec[]
}

// ── Per-building definition parameters ───────────────────────────────────────

/**
 * Requirement shortcuts (all scaled by target level):
 *  - `thOffset`: Town Hall level ≥ max(floor, target − offset). The floor is
 *    the earliest Town Hall gate for the building type; `Infinity` offset
 *    means "floor only" (never scales with the target level).
 *  - `playerLevelOffset`: player level ≥ target − offset.
 *  - `requires`: static per-target-level extra buildings.
 */
interface BuildingDef {
  type: BuildingType
  name: string
  category: BuildingCategory
  description: string
  maxLevel: number
  /** Cost of the FIRST upgrade (level 1 → 2), scaled by costGrowthBps. */
  costBase: Partial<Record<Resource, number>>
  /** Multiplicative cost growth per level in bps (15_000 = ×1.5). */
  costGrowthBps: number
  /** Duration of the first upgrade in seconds, scaled by durationGrowthBps. */
  durationBaseSec: number
  /** Multiplicative duration growth per level in bps. */
  durationGrowthBps: number
  /** Town Hall floor for this type: TH ≥ max(floor, target − offset). */
  thFloor: number
  thOffset: number
  /** Player level requirement floor (TOWN_HALL scales with target − 1). */
  playerLevelOffset?: number
  /** Extra cross-building requirements per target level. */
  requires?: (targetLevel: number) => BuildingRequirements['buildings']
  /** Effects materializer for an owned level. */
  effects: (level: number) => BuildingEffects
}

const DEFS: BuildingDef[] = [
  {
    type: 'TOWN_HALL',
    name: 'Town Hall',
    category: 'CORE',
    description:
      'The heart of the keep — its level gates every other building and unlocks extra construction queues.',
    maxLevel: 15,
    costBase: { GOLD: 400, WOOD: 250 },
    costGrowthBps: 15_000,
    durationBaseSec: 30,
    durationGrowthBps: 13_500,
    thFloor: 1,
    thOffset: Number.POSITIVE_INFINITY, // never TH-gated — it IS the gate
    playerLevelOffset: TOWN_HALL_PLAYER_LEVEL_OFFSET,
    effects: (level) => ({
      queueSlots: level >= EXTRA_QUEUE_SLOT_TOWN_HALL_LEVEL ? 2 : 1,
    }),
  },
  {
    type: 'CASTLE',
    name: 'Castle',
    category: 'MILITARY',
    description: 'Command center of the war effort — grants additional march slots for campaigns.',
    maxLevel: BUILDING_MAX_LEVEL - CASTLE_TOWN_HALL_OFFSET, // maxes exactly when TH hits 15
    costBase: { GOLD: 900, WOOD: 500, IRON: 300 },
    costGrowthBps: 15_500,
    durationBaseSec: 60,
    durationGrowthBps: 14_000,
    thFloor: 1,
    thOffset: -CASTLE_TOWN_HALL_OFFSET, // TH ≥ target + 4 (castle chases the Town Hall)
    effects: (level) => ({
      marchSlots: 1 + Math.floor(level / 5),
    }),
  },
  {
    type: 'BARRACKS',
    name: 'Barracks',
    category: 'MILITARY',
    description: 'Trains infantry. Higher levels drill recruits faster.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 300, WOOD: 200 },
    costGrowthBps: 14_000,
    durationBaseSec: 25,
    durationGrowthBps: 13_000,
    thFloor: 1,
    thOffset: 1,
    effects: (level) => ({
      trainingSpeedBps: 10_000 + 500 * (level - 1),
    }),
  },
  {
    type: 'ARCHER_CAMP',
    name: 'Archer Camp',
    category: 'MILITARY',
    description: 'Trains ranged units. Higher levels nock arrows faster.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 320, WOOD: 260 },
    costGrowthBps: 14_000,
    durationBaseSec: 25,
    durationGrowthBps: 13_000,
    thFloor: 2,
    thOffset: 1,
    effects: (level) => ({
      trainingSpeedBps: 10_000 + 500 * (level - 1),
    }),
  },
  {
    type: 'STABLE',
    name: 'Stable',
    category: 'MILITARY',
    description: 'Trains cavalry. Higher levels saddle mounts faster.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 400, WOOD: 240, FOOD: 200 },
    costGrowthBps: 14_000,
    durationBaseSec: 30,
    durationGrowthBps: 13_000,
    thFloor: 3,
    thOffset: 1,
    effects: (level) => ({
      trainingSpeedBps: 10_000 + 500 * (level - 1),
    }),
  },
  {
    type: 'ARMORY',
    name: 'Armory',
    category: 'MILITARY',
    description:
      'Forges and upgrades equipment. Requires the Barracks to keep pace with the forge.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 350, IRON: 200, WOOD: 150 },
    costGrowthBps: 14_500,
    durationBaseSec: 30,
    durationGrowthBps: 13_000,
    thFloor: 3,
    thOffset: 1,
    requires: (targetLevel) => ({ BARRACKS: Math.max(1, targetLevel - 1) }),
    effects: (level) => ({
      equipmentSpeedBps: 10_000 + 400 * (level - 1),
    }),
  },
  {
    type: 'HOSPITAL',
    name: 'Hospital',
    category: 'SUPPORT',
    description: 'Treats wounded soldiers after battles instead of losing them.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 380, WOOD: 280 },
    costGrowthBps: 14_500,
    durationBaseSec: 35,
    durationGrowthBps: 13_000,
    thFloor: 4,
    thOffset: 1,
    effects: (level) => ({
      hospitalCapacity: 50 + 40 * (level - 1),
    }),
  },
  {
    type: 'FARM',
    name: 'Farm',
    category: 'ECONOMY',
    description: 'Produces food per hour — the upkeep backbone of every army.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 120, WOOD: 100 },
    costGrowthBps: 13_500,
    durationBaseSec: 12,
    durationGrowthBps: 12_500,
    thFloor: 1,
    thOffset: 1,
    effects: (level) => ({
      productionPerHour: { FOOD: 60 * level },
    }),
  },
  {
    type: 'WOOD_MILL',
    name: 'Wood Mill',
    category: 'ECONOMY',
    description: 'Produces wood per hour for construction and siege engines.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 140, FOOD: 80 },
    costGrowthBps: 13_500,
    durationBaseSec: 12,
    durationGrowthBps: 12_500,
    thFloor: 1,
    thOffset: 1,
    effects: (level) => ({
      productionPerHour: { WOOD: 50 * level },
    }),
  },
  {
    type: 'IRON_MINE',
    name: 'Iron Mine',
    category: 'ECONOMY',
    description: 'Produces iron per hour for armor and weaponry.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 180, FOOD: 120 },
    costGrowthBps: 13_500,
    durationBaseSec: 15,
    durationGrowthBps: 12_500,
    thFloor: 2,
    thOffset: 1,
    effects: (level) => ({
      productionPerHour: { IRON: 40 * level },
    }),
  },
  {
    type: 'GOLD_MINE',
    name: 'Gold Mine',
    category: 'ECONOMY',
    description: 'Produces gold per hour — the lifeblood of the war treasury.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 100, WOOD: 120, FOOD: 100 },
    costGrowthBps: 13_500,
    durationBaseSec: 15,
    durationGrowthBps: 12_500,
    thFloor: 2,
    thOffset: 1,
    effects: (level) => ({
      productionPerHour: { GOLD: 45 * level },
    }),
  },
  {
    type: 'ACADEMY',
    name: 'Academy',
    category: 'SUPPORT',
    description: 'Researches technologies. Higher levels accelerate research.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 600, WOOD: 350, IRON: 150, CRYSTAL: 10 },
    costGrowthBps: 15_000,
    durationBaseSec: 45,
    durationGrowthBps: 13_500,
    thFloor: 5,
    thOffset: 1,
    effects: (level) => ({
      researchSpeedBps: 10_000 + 400 * (level - 1),
    }),
  },
  {
    type: 'SCOUT_CENTER',
    name: 'Scout Center',
    category: 'SUPPORT',
    description: 'Coordinates reconnaissance rides and speeds up scouts.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 250, WOOD: 180, FOOD: 120 },
    costGrowthBps: 14_000,
    durationBaseSec: 20,
    durationGrowthBps: 13_000,
    thFloor: 3,
    thOffset: 1,
    effects: (level) => ({
      scoutSpeedBps: 10_000 + 300 * (level - 1),
    }),
  },
  {
    type: 'SPY_CENTER',
    name: 'Spy Center',
    category: 'SUPPORT',
    description: 'Runs covert operations — requires a seasoned Scout Center network.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 500, WOOD: 300, IRON: 200, CRYSTAL: 15 },
    costGrowthBps: 15_000,
    durationBaseSec: 40,
    durationGrowthBps: 13_500,
    thFloor: 8,
    thOffset: 1,
    requires: (targetLevel) => ({ SCOUT_CENTER: Math.max(1, targetLevel - 1) }),
    effects: (level) => ({
      spyPowerBps: 10_000 + 350 * (level - 1),
    }),
  },
  {
    type: 'WAREHOUSE',
    name: 'Warehouse',
    category: 'ECONOMY',
    description: 'Raises the city storage capacity for every resource.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 200, WOOD: 240 },
    costGrowthBps: 14_000,
    durationBaseSec: 18,
    durationGrowthBps: 12_800,
    thFloor: 1,
    thOffset: 1,
    effects: (level) => ({
      storageCapacity: 20_000 + 15_000 * (level - 1),
    }),
  },
  {
    type: 'MARKET',
    name: 'Market',
    category: 'ECONOMY',
    description: 'Player-to-player trade — every level trims the trading fee.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 450, WOOD: 300 },
    costGrowthBps: 14_500,
    durationBaseSec: 30,
    durationGrowthBps: 13_000,
    thFloor: 6,
    thOffset: 1,
    effects: (level) => ({
      marketFeeBps: Math.max(200, 800 - 50 * (level - 1)),
    }),
  },
  {
    type: 'WALL',
    name: 'Wall',
    category: 'DEFENSE',
    description: 'Fortifies the city — adds a flat defense bonus in battle.',
    maxLevel: BUILDING_MAX_LEVEL,
    costBase: { GOLD: 250, WOOD: 200, IRON: 150 },
    costGrowthBps: 14_200,
    durationBaseSec: 22,
    durationGrowthBps: 13_200,
    thFloor: 2,
    thOffset: 1,
    effects: (level) => ({
      defenseBps: 10_000 + 600 * (level - 1),
    }),
  },
]

// ── Integer-only materialization helpers ─────────────────────────────────────

/**
 * Compounds `base` by `growthBps` per step with integer floor math —
 * cost(step) = floor(cost(step-1) × growthBps / 10_000). Deterministic and
 * monotonic; no floating point anywhere.
 */
export function compoundBps(base: number, step: number, growthBps: number): number {
  let value = base
  for (let i = 0; i < step; i++) {
    value = Math.floor((value * growthBps) / 10_000)
  }
  return value
}

/** Town Hall level required to build/upgrade the type TO `targetLevel`. */
export function requiredTownHallLevel(def: BuildingDef, targetLevel: number): number {
  if (def.thOffset === Number.POSITIVE_INFINITY) return def.thFloor
  return Math.max(def.thFloor, targetLevel - def.thOffset)
}

function requirementsFor(def: BuildingDef, targetLevel: number): BuildingRequirements {
  const requirements: BuildingRequirements = {}
  const th = requiredTownHallLevel(def, targetLevel)
  if (th > 1) requirements.townHallLevel = th
  if (def.playerLevelOffset !== undefined) {
    const playerLevel = Math.max(1, targetLevel - def.playerLevelOffset)
    if (playerLevel > 1) requirements.playerLevel = playerLevel
  }
  const buildings = def.requires?.(targetLevel)
  if (buildings && Object.keys(buildings).length > 0) requirements.buildings = buildings
  return requirements
}

// ── Public catalog accessors (pure, DB-free) ─────────────────────────────────

const DEF_BY_TYPE = new Map<string, BuildingDef>(DEFS.map((d) => [d.type, d]))

export function getBuildingDef(type: BuildingType): BuildingDef {
  const def = DEF_BY_TYPE.get(type)
  if (!def) throw new Error(`Unknown building type in catalog: ${type}`)
  return def
}

export function isBuildingType(value: unknown): value is BuildingType {
  return typeof value === 'string' && (BUILDING_TYPES as readonly string[]).includes(value)
}

/** Cost of the upgrade TO `targetLevel` (integer amounts, config authority). */
export function upgradeCostFor(
  type: BuildingType,
  targetLevel: number,
): Partial<Record<Resource, number>> {
  // targetLevel 1 = starter state (no upgrade); target 2 = step 0 (costBase).
  const stepIndex = targetLevel - 2
  if (stepIndex < 0) return {}
  const def = getBuildingDef(type)
  const cost: Partial<Record<Resource, number>> = {}
  for (const [resource, base] of Object.entries(def.costBase)) {
    cost[resource as Resource] = compoundBps(base, stepIndex, def.costGrowthBps)
  }
  return cost
}

/** Construction duration (seconds) of the upgrade TO `targetLevel`. */
export function upgradeDurationSecFor(type: BuildingType, targetLevel: number): number {
  const def = getBuildingDef(type)
  const stepIndex = targetLevel - 2
  if (stepIndex < 0) return 0
  return Math.max(1, compoundBps(def.durationBaseSec, stepIndex, def.durationGrowthBps))
}

/** Requirements for the upgrade TO `targetLevel`. */
export function upgradeRequirementsFor(
  type: BuildingType,
  targetLevel: number,
): BuildingRequirements {
  return requirementsFor(getBuildingDef(type), targetLevel)
}

/** Effects of OWNING the building at `level`. */
export function effectsFor(type: BuildingType, level: number): BuildingEffects {
  return getBuildingDef(type).effects(Math.max(1, level))
}

/** Simultaneous constructions the Town Hall level supports. */
export function constructionQueueSlots(townHallLevel: number): number {
  return townHallLevel >= EXTRA_QUEUE_SLOT_TOWN_HALL_LEVEL ? 2 : 1
}

// ── Full materialization (catalog API + tests) ───────────────────────────────

/**
 * Materializes the complete catalog: every building type with every owned
 * level (1…maxLevel) and its upgrade spec (cost/duration/requirements to
 * REACH that level). Level 1 carries the bootstrap state (no cost — starter
 * rows are built at level 1) and its own effects.
 */
export function materializeBuildingCatalog(): BuildingCatalogEntry[] {
  return BUILDING_TYPES.map((type) => {
    const def = getBuildingDef(type)
    const levels: BuildingLevelSpec[] = []
    for (let level = 1; level <= def.maxLevel; level++) {
      levels.push({
        level,
        cost: upgradeCostFor(type, level),
        durationSec: upgradeDurationSecFor(type, level),
        requirements: upgradeRequirementsFor(type, level),
        effects: effectsFor(type, level),
      })
    }
    return {
      type,
      name: def.name,
      category: def.category,
      description: def.description,
      maxLevel: def.maxLevel,
      levels,
    }
  })
}

/** Display order for the city view — catalog order is the contract order. */
export const CITY_BUILDING_ORDER: BuildingType[] = [...BUILDING_TYPES]
