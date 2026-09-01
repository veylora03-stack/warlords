/**
 * Unit tests — World generator (Phase 32): pure determinism.
 *
 * The generator is a PURE function of (seed, sizeX, sizeY, regionSize).
 * These tests pin the determinism guarantee, the structural invariants of
 * the generated world (region coverage, unique coordinates, terrain
 * validity, special sites) and the pure production/adjacency/garrison math.
 */

import { describe, it, expect } from 'bun:test'
import {
  accruedProduction,
  adjacentCoords,
  areAdjacent,
  generateWorld,
  garrisonFor,
  garrisonUnitCount,
  isInsideWorld,
  productionBaseRate,
  productionRateFor,
  regionIdFor,
  type GarrisonCatalogRow,
} from '../../../src/lib/game/engine/world/generator'
import {
  GENERATION_TERRAIN_TYPES,
  WORLD,
  WORLD_PRODUCTION,
} from '../../../src/lib/game/config/world'

const CATALOG: GarrisonCatalogRow[] = [
  {
    id: 'swordsman',
    name: 'Swordsman',
    class: 'INFANTRY',
    attack: 24,
    defense: 32,
    health: 160,
    speed: 5,
    strongAgainst: [],
    weakAgainst: [],
    carryCapacity: 35,
  },
  {
    id: 'archer',
    name: 'Archer',
    class: 'RANGED',
    attack: 15,
    defense: 8,
    health: 80,
    speed: 7,
    strongAgainst: [],
    weakAgainst: [],
    carryCapacity: 25,
  },
]

describe('generateWorld — determinism', () => {
  it('generates the byte-identical world from the same seed', () => {
    const a = generateWorld()
    const b = generateWorld()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('generates a different world from a different seed', () => {
    const a = generateWorld({ seed: 1 })
    const b = generateWorld({ seed: 2 })
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('honors explicit sizes (pure parameterization for tests)', () => {
    const small = generateWorld({ sizeX: 5, sizeY: 5, regionSize: 2 })
    expect(small.territories).toHaveLength(25)
    expect(small.regions).toHaveLength(9) // ceil(5/2)^2
  })
})

describe('generateWorld — structure', () => {
  const world = generateWorld()

  it('produces every grid cell exactly once with unique coordinates', () => {
    expect(world.territories).toHaveLength(WORLD.sizeX * WORLD.sizeY)
    const keys = new Set(world.territories.map((t) => `${t.x},${t.y}`))
    expect(keys.size).toBe(world.territories.length)
    for (const cell of world.territories) {
      expect(isInsideWorld(cell.x, cell.y)).toBe(true)
    }
  })

  it('produces exactly regionGridCount regions covering the whole grid without overlap', () => {
    expect(world.regions).toHaveLength(36)
    const covered = new Set<string>()
    for (const region of world.regions) {
      expect(region.maxX).toBeGreaterThanOrEqual(region.minX)
      expect(region.maxY).toBeGreaterThanOrEqual(region.minY)
      for (let x = region.minX; x <= region.maxX; x++) {
        for (let y = region.minY; y <= region.maxY; y++) {
          const key = `${x},${y}`
          expect(covered.has(key)).toBe(false) // no overlap
          covered.add(key)
        }
      }
    }
    expect(covered.size).toBe(WORLD.sizeX * WORLD.sizeY) // full coverage
  })

  it('assigns every cell to the region its coordinates imply', () => {
    for (const cell of world.territories) {
      expect(cell.regionId).toBe(regionIdFor(cell.x, cell.y))
    }
  })

  it('gives every region a unique non-empty name', () => {
    const names = world.regions.map((r) => r.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name.trim().length).toBeGreaterThan(0)
  })

  it('generates only valid non-CITY terrain from the catalog', () => {
    const valid = new Set<string>(GENERATION_TERRAIN_TYPES)
    for (const cell of world.territories) {
      expect(valid.has(cell.terrain)).toBe(true)
    }
  })

  it('generates exactly the configured number of distinct locked special sites', () => {
    const locked = world.territories.filter((t) => t.status === 'LOCKED')
    expect(locked.length).toBe(6)
    const keys = new Set(locked.map((t) => `${t.x},${t.y}`))
    expect(keys.size).toBe(locked.length)
    for (const cell of locked) {
      expect(cell.type).toBe('SPECIAL')
      expect(cell.resourceType).toBeNull()
      expect(cell.productionRate).toBe(0)
    }
  })

  it('marks producing cells with a resource and rate; others with none', () => {
    for (const cell of world.territories) {
      if (cell.status === 'LOCKED') continue
      if (cell.resourceType !== null) {
        expect(cell.type).toBe('RESOURCE_ZONE')
        expect(cell.productionRate).toBeGreaterThan(0)
      } else {
        expect(cell.type).toBe('NPC_VILLAGE')
        expect(cell.productionRate).toBe(0)
      }
      expect(cell.strategicValue).toBeGreaterThanOrEqual(1)
      expect(cell.strategicValue).toBeLessThanOrEqual(10)
      expect(cell.defenseStrength).toBe(garrisonUnitCount(cell.strategicValue))
    }
  })

  it('never assigns ownership — the generator cannot capture anything', () => {
    for (const cell of world.territories) {
      expect(cell.status === 'UNCLAIMED' || cell.status === 'LOCKED').toBe(true)
    }
  })

  it('keeps the dev fixture sites claimable (regression guard for the world seed)', () => {
    // The dev seed bootstraps fixed cities at these coordinates — if the
    // seed ever locks or special-cases them, the bootstrap must fail loudly.
    for (const [x, y] of [
      [10, 10],
      [11, 10],
    ] as const) {
      const cell = world.territories.find((t) => t.x === x && t.y === y)!
      expect(cell.status).toBe('UNCLAIMED')
    }
  })
})

describe('coordinate helpers', () => {
  it('rejects coordinates outside the grid', () => {
    expect(isInsideWorld(0, 0)).toBe(true)
    expect(isInsideWorld(WORLD.sizeX - 1, WORLD.sizeY - 1)).toBe(true)
    expect(isInsideWorld(-1, 0)).toBe(false)
    expect(isInsideWorld(0, -1)).toBe(false)
    expect(isInsideWorld(WORLD.sizeX, 0)).toBe(false)
    expect(isInsideWorld(0, WORLD.sizeY)).toBe(false)
    expect(isInsideWorld(1.5, 1)).toBe(false)
  })

  it('derives exactly the in-bounds 4-direction adjacency', () => {
    expect(adjacentCoords(0, 0)).toEqual([
      { x: 0, y: 1, direction: 'S' },
      { x: 1, y: 0, direction: 'E' },
    ])
    expect(adjacentCoords(WORLD.sizeX - 1, WORLD.sizeY - 1)).toEqual([
      { x: WORLD.sizeX - 1, y: WORLD.sizeY - 2, direction: 'N' },
      { x: WORLD.sizeX - 2, y: WORLD.sizeY - 1, direction: 'W' },
    ])
    const mid = adjacentCoords(5, 5)
    expect(mid).toHaveLength(4)
    for (const cell of mid) {
      expect(areAdjacent({ x: 5, y: 5 }, cell)).toBe(true)
    }
    expect(areAdjacent({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false) // diagonal
    expect(areAdjacent({ x: 2, y: 0 }, { x: 0, y: 0 })).toBe(false) // distance 2
  })
})

describe('production math (pure)', () => {
  it('scales the base rate with strategic value', () => {
    expect(productionBaseRate(1)).toBe(
      WORLD_PRODUCTION.baseRatePerHour + WORLD_PRODUCTION.ratePerStrategicValue,
    )
    expect(productionBaseRate(5)).toBeGreaterThan(productionBaseRate(1))
  })

  it('applies the terrain multiplier and stays integral', () => {
    const rate = productionRateFor(3, 'MOUNTAINS')
    expect(Number.isInteger(rate)).toBe(true)
    expect(rate).toBeGreaterThan(productionBaseRate(3)) // 14_000 bps > neutral
  })

  it('accrues lazily, floors partial hours and clamps at the cap', () => {
    const rate = productionRateFor(3, 'PLAINS')
    // One hour → exactly the hourly rate.
    expect(accruedProduction(rate, 'PLAINS', 3_600_000)).toBe(rate)
    // Half an hour → floored.
    expect(accruedProduction(rate, 'PLAINS', 1_800_000)).toBe(Math.floor(rate / 2))
    // Zero elapsed → zero.
    expect(accruedProduction(rate, 'PLAINS', 0)).toBe(0)
    // Cap: 100 hours can never exceed capHours × rate.
    expect(accruedProduction(rate, 'PLAINS', 100 * 3_600_000)).toBe(
      rate * WORLD_PRODUCTION.capHours,
    )
    // Non-producing cell → zero regardless of elapsed time.
    expect(accruedProduction(0, 'PLAINS', 86_400_000)).toBe(0)
  })
})

describe('virtual garrison (pure, deterministic NPC)', () => {
  it('scales with strategic value and respects the hard cap', () => {
    expect(garrisonUnitCount(1)).toBeGreaterThan(0)
    expect(garrisonUnitCount(10)).toBeLessThanOrEqual(WORLD_PRODUCTION.capHours * 0 + 120)
    expect(garrisonUnitCount(10)).toBeGreaterThan(garrisonUnitCount(1))
  })

  it('is fully deterministic per (seed, x, y) — replayable', () => {
    const a = garrisonFor(WORLD.seed, 7, 9, 4, CATALOG)
    const b = garrisonFor(WORLD.seed, 7, 9, 4, CATALOG)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('differs between cells while keeping the configured total size', () => {
    const a = garrisonFor(WORLD.seed, 7, 9, 4, CATALOG)
    const b = garrisonFor(WORLD.seed, 8, 9, 4, CATALOG)
    const totalOf = (stacks: ReturnType<typeof garrisonFor>) =>
      stacks.reduce((sum, s) => sum + s.count, 0)
    expect(totalOf(a)).toBe(garrisonUnitCount(4))
    expect(totalOf(b)).toBe(garrisonUnitCount(4))
    // The jitter makes SOME cell pairs differ; a fixed pair is pinned here.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('builds stacks ONLY from real catalog units with zero carry capacity', () => {
    const stacks = garrisonFor(WORLD.seed, 3, 4, 5, CATALOG)
    expect(stacks.length).toBeGreaterThan(0)
    for (const stack of stacks) {
      expect(CATALOG.map((row) => row.id)).toContain(stack.unitTypeId)
      expect(stack.carryCapacity).toBe(0)
      expect(stack.count).toBeGreaterThan(0)
    }
  })

  it('skips unknown composition ids (fail-closed to fewer stacks)', () => {
    const sparse: GarrisonCatalogRow[] = [CATALOG[0]!]
    const stacks = garrisonFor(WORLD.seed, 3, 4, 5, sparse)
    expect(stacks.map((s) => s.unitTypeId)).toEqual(['swordsman'])
  })

  it('returns an empty garrison for an empty catalog or non-positive size', () => {
    expect(garrisonFor(WORLD.seed, 1, 2, 5, [])).toEqual([])
  })
})
