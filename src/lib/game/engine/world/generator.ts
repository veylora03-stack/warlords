/**
 * WARLORDS — World generator (Phase 32: World Map + Territory Engine).
 *
 * A PURE function: generateWorld({seed, sizeX, sizeY, regionSize}) → world.
 * No I/O, no clock reads, no Prisma — the ONLY randomness is the seeded
 * PRNG (mulberry32, shared with the battle engine), so the same seed ALWAYS
 * produces the byte-identical world: same regions, same coordinates, same
 * terrain, same special sites, same names. This is what makes generation
 * testable, auditable and replayable.
 *
 * The generator NEVER decides ownership — every generated cell is UNCLAIMED
 * (or LOCKED). Ownership enters the world exclusively through the server's
 * transactional flows (spawn capture, assault capture, admin ops).
 *
 * The virtual garrison (garrisonFor) is likewise pure: (seed, x, y,
 * strategicValue, unit catalog) ⇒ identical defender stacks. It is an NPC
 * battle-resolution construct ONLY — never persisted, never a real army.
 */

import { mulberry32 } from '@/lib/game/engine/battle/simulator'
import type { BattleUnitStack } from '@/lib/game/types/battle'
import type { UnitClass } from '@/lib/game/types/common'
import {
  GENERATION_TERRAIN_TYPES,
  REGION_NAME_PREFIX,
  REGION_NAME_SUFFIX,
  TERRAIN,
  TERRITORY_NAME_PREFIX,
  TERRITORY_NAME_SUFFIX,
  WORLD,
  WORLD_GENERATION,
  WORLD_GARRISON,
  WORLD_PRODUCTION,
} from '@/lib/game/config/world'

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface GeneratedRegion {
  id: string
  name: string
  minX: number
  maxX: number
  minY: number
  maxY: number
  metadata: { seed: number; index: number }
}

export interface GeneratedTerritory {
  x: number
  y: number
  regionId: string | null
  name: string
  terrain: string
  status: 'UNCLAIMED' | 'LOCKED'
  type: 'NPC_VILLAGE' | 'RESOURCE_ZONE' | 'SPECIAL'
  strategicValue: number
  /** Display resistance hint — the deterministic garrison's total unit count. */
  defenseStrength: number
  resourceType: string | null
  productionRate: number
}

export interface GeneratedWorld {
  regions: GeneratedRegion[]
  territories: GeneratedTerritory[]
}

// ── Coordinate helpers (shared with the service layer) ───────────────────────

export function isInsideWorld(
  x: number,
  y: number,
  sizeX: number = WORLD.sizeX,
  sizeY: number = WORLD.sizeY,
): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < sizeX && y >= 0 && y < sizeY
}

export interface AdjacentCell {
  x: number
  y: number
  direction: 'N' | 'S' | 'E' | 'W'
}

/** 4-direction adjacency derived from coordinates — never stored, never client-supplied. */
export function adjacentCoords(
  x: number,
  y: number,
  sizeX: number = WORLD.sizeX,
  sizeY: number = WORLD.sizeY,
): AdjacentCell[] {
  const out: AdjacentCell[] = []
  if (y > 0) out.push({ x, y: y - 1, direction: 'N' })
  if (y < sizeY - 1) out.push({ x, y: y + 1, direction: 'S' })
  if (x > 0) out.push({ x: x - 1, y, direction: 'W' })
  if (x < sizeX - 1) out.push({ x: x + 1, y, direction: 'E' })
  return out
}

export function areAdjacent(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1
}

/** Region id for a coordinate (pure — mirrors the generator's region grid). */
export function regionIdFor(x: number, y: number, regionSize: number = WORLD.regionSize): string {
  return `r${Math.floor(x / regionSize)}-${Math.floor(y / regionSize)}`
}

// ── Deterministic helpers ────────────────────────────────────────────────────

/** Per-cell PRNG seed — mixes the world seed with both coordinates. */
function cellSeed(seed: number, x: number, y: number): number {
  return (seed ^ Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0
}

/** Weighted terrain pick (pure — consumes exactly one rng() call per cell). */
function pickWeightedTerrain(rng: () => number): string {
  const total = GENERATION_TERRAIN_TYPES.reduce((sum, t) => sum + TERRAIN[t].weight, 0)
  let roll = rng() * total
  for (const terrain of GENERATION_TERRAIN_TYPES) {
    roll -= TERRAIN[terrain].weight
    if (roll < 0) return terrain
  }
  return GENERATION_TERRAIN_TYPES[0]!
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
function roman(n: number): string {
  return ROMAN[(n - 1) % ROMAN.length]!
}

/** Deterministic region name — deduped inside one generation. */
function buildRegionName(rng: () => number, used: Set<string>): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = `${
      REGION_NAME_PREFIX[Math.floor(rng() * REGION_NAME_PREFIX.length)]
    }${REGION_NAME_SUFFIX[Math.floor(rng() * REGION_NAME_SUFFIX.length)]}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  // Exhaustion is impossible at the configured scale (192 combos ≫ regions);
  // the numbered fallback keeps the generator total regardless.
  return `${REGION_NAME_PREFIX[0]}${REGION_NAME_SUFFIX[0]} ${roman(used.size + 1)}`
}

function buildTerritoryName(rng: () => number): string {
  return `${TERRITORY_NAME_PREFIX[Math.floor(rng() * TERRITORY_NAME_PREFIX.length)]}${
    TERRITORY_NAME_SUFFIX[Math.floor(rng() * TERRITORY_NAME_SUFFIX.length)]
  }`
}

// ── The generator ────────────────────────────────────────────────────────────

export interface GenerateWorldOptions {
  seed?: number
  sizeX?: number
  sizeY?: number
  regionSize?: number
}

export function generateWorld(options: GenerateWorldOptions = {}): GeneratedWorld {
  const seed = options.seed ?? WORLD.seed
  const sizeX = options.sizeX ?? WORLD.sizeX
  const sizeY = options.sizeY ?? WORLD.sizeY
  const regionSize = options.regionSize ?? WORLD.regionSize
  if (!Number.isInteger(seed) || seed < 0) throw new Error('generateWorld: invalid seed')
  if (!Number.isInteger(sizeX) || sizeX < 1 || !Number.isInteger(sizeY) || sizeY < 1) {
    throw new Error('generateWorld: invalid size')
  }
  if (!Number.isInteger(regionSize) || regionSize < 1) {
    throw new Error('generateWorld: invalid regionSize')
  }

  const rng = mulberry32(seed)
  const cols = Math.ceil(sizeX / regionSize)
  const rows = Math.ceil(sizeY / regionSize)

  // ── Regions ──────────────────────────────────────────────────────────────
  const usedRegionNames = new Set<string>()
  const regions: GeneratedRegion[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const minX = col * regionSize
      const minY = row * regionSize
      regions.push({
        id: `r${col}-${row}`,
        name: buildRegionName(rng, usedRegionNames),
        minX,
        maxX: Math.min(minX + regionSize - 1, sizeX - 1),
        minY,
        maxY: Math.min(minY + regionSize - 1, sizeY - 1),
        metadata: { seed, index: row * cols + col },
      })
    }
  }

  // ── Cells ────────────────────────────────────────────────────────────────
  const totalCells = sizeX * sizeY
  const territories: GeneratedTerritory[] = []
  for (let y = 0; y < sizeY; y++) {
    for (let x = 0; x < sizeX; x++) {
      const terrain = pickWeightedTerrain(rng)
      let strategicValue =
        WORLD_GENERATION.strategicValueMin +
        Math.floor(
          rng() * (WORLD_GENERATION.strategicValueMax - WORLD_GENERATION.strategicValueMin + 1),
        )
      const producing = rng() * 10_000 < WORLD_GENERATION.producingCellBps
      const resourceType = TERRAIN[terrain as keyof typeof TERRAIN]?.resource ?? 'GOLD'
      if (producing) {
        strategicValue = Math.min(10, strategicValue + WORLD_GENERATION.strategicValueResourceBonus)
      }
      territories.push({
        x,
        y,
        regionId: regionIdFor(x, y, regionSize),
        name: buildTerritoryName(rng),
        terrain,
        status: 'UNCLAIMED',
        type: producing ? 'RESOURCE_ZONE' : 'NPC_VILLAGE',
        strategicValue,
        defenseStrength: garrisonUnitCount(strategicValue),
        resourceType: producing ? resourceType : null,
        productionRate: producing ? productionRateFor(strategicValue, terrain) : 0,
      })
    }
  }

  // ── Locked special sites (deterministic, distinct cells) ─────────────────
  const locked = new Set<string>()
  let guard = 0
  while (locked.size < Math.min(WORLD_GENERATION.lockedCellCount, totalCells) && guard < 10_000) {
    guard++
    const x = Math.floor(rng() * sizeX)
    const y = Math.floor(rng() * sizeY)
    locked.add(`${x},${y}`)
  }
  for (const key of locked) {
    const [x, y] = key.split(',').map(Number) as [number, number]
    const cell = territories[y * sizeX + x]!
    cell.status = 'LOCKED'
    cell.type = 'SPECIAL'
    cell.resourceType = null
    cell.productionRate = 0
  }

  return { regions, territories }
}

// ── Production math (pure — shared by generator + collection service) ────────

/** Config units per hour for a producing cell (before terrain multiplier). */
export function productionBaseRate(strategicValue: number): number {
  return WORLD_PRODUCTION.baseRatePerHour + WORLD_PRODUCTION.ratePerStrategicValue * strategicValue
}

/** Production rate after the terrain multiplier (integer, floored). */
export function productionRateFor(strategicValue: number, terrain: string): number {
  const def = TERRAIN[terrain as keyof typeof TERRAIN]
  const multiplier = def?.productionMultiplierBps ?? 10_000
  return Math.floor((productionBaseRate(strategicValue) * multiplier) / 10_000)
}

/** Accumulated production for an elapsed period, capped (pure). */
export function accruedProduction(ratePerHour: number, terrain: string, elapsedMs: number): number {
  if (ratePerHour <= 0 || elapsedMs <= 0) return 0
  const capUnits = ratePerHour * WORLD_PRODUCTION.capHours
  const hours = elapsedMs / 3_600_000
  const raw = ratePerHour * hours
  return Math.min(capUnits, Math.floor(raw))
}

// ── Virtual garrison (pure NPC defender — never persisted) ───────────────────

/** Total garrison units for a strategic value (pure — display + battle agree). */
export function garrisonUnitCount(strategicValue: number): number {
  const total =
    WORLD_GARRISON.baseUnits + WORLD_GARRISON.unitsPerStrategicValue * Math.max(0, strategicValue)
  return Math.min(WORLD_GARRISON.maxUnits, total)
}

/** Minimal unit-catalog projection garrisonFor needs (loaded by the service). */
export interface GarrisonCatalogRow {
  id: string
  name: string
  class: UnitClass
  attack: number
  defense: number
  health: number
  speed: number
  strongAgainst: unknown
  weakAgainst: unknown
  carryCapacity: number
}

/**
 * The deterministic virtual garrison for an unclaimed territory.
 * (seed, x, y, strategicValue, catalog) ⇒ identical stacks — replayable.
 * Composition follows WORLD_GARRISON.composition (bps) over REAL catalog
 * stats, jittered deterministically per cell (±WORLD_GARRISON.jitterBps) so
 * neighbouring cells resist differently while staying replayable. Unknown
 * catalog ids are skipped (fail-closed to fewer stacks).
 */
export function garrisonFor(
  seed: number,
  x: number,
  y: number,
  strategicValue: number,
  catalog: readonly GarrisonCatalogRow[],
): BattleUnitStack[] {
  const total = garrisonUnitCount(strategicValue)
  if (total <= 0 || catalog.length === 0) return []
  const rng = mulberry32(cellSeed(seed, x, y))

  // Distribute the total across the composition's catalog ids (bps shares,
  // deterministic per-cell jitter, renormalized against the total).
  const byId = new Map(catalog.map((row) => [row.id, row]))
  const entries = Object.entries(WORLD_GARRISON.composition)
  const jittered = entries.map(([, bps]) => {
    const jitter = Math.floor(rng() * (2 * WORLD_GARRISON.jitterBps + 1)) - WORLD_GARRISON.jitterBps
    return Math.max(0, bps + jitter)
  })
  const jitterTotal = jittered.reduce((sum, bps) => sum + bps, 0)
  const shares = entries
    .map(([unitId], index) => ({
      row: byId.get(unitId),
      count: Math.floor((total * jittered[index]!) / jitterTotal),
      order: index,
    }))
    .filter((share): share is { row: GarrisonCatalogRow; count: number; order: number } =>
      Boolean(share.row),
    )
  let assigned = shares.reduce((sum, share) => sum + share.count, 0)
  // Remainder goes to the first share (deterministic rounding drift fix).
  if (assigned < total && shares.length > 0) {
    shares[0]!.count += total - assigned
    assigned += total - assigned
  }

  return shares.map((share) => ({
    unitTypeId: share.row.id,
    class: share.row.class,
    count: share.count,
    attack: share.row.attack,
    defense: share.row.defense,
    health: share.row.health,
    speed: share.row.speed,
    strongAgainst: counterMap(share.row.strongAgainst),
    weakAgainst: counterMap(share.row.weakAgainst),
    carryCapacity: 0, // a garrison carries no loot
  }))
}

function counterMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const unitId = (entry as { unitId?: unknown }).unitId
    const bonus = (entry as { bonusBps?: unknown }).bonusBps
    const penalty = (entry as { penaltyBps?: unknown }).penaltyBps
    if (typeof unitId !== 'string') continue
    if (typeof bonus === 'number') out[unitId] = bonus
    else if (typeof penalty === 'number') out[unitId] = -penalty
  }
  return out
}
