/**
 * Unit tests — Building catalog config (Phase 6: City & Building System).
 *
 * The catalog is the ONLY authority for building balance numbers: these
 * tests pin its structural invariants so a bad rebalance (negative cost,
 * unreachable requirement chain, broken growth math) fails fast in CI —
 * long before any player sees it.
 */

import { describe, it, expect } from 'bun:test'
import { BUILDING_TYPES } from '../../src/lib/game/types/common'
import { MAX_DELTA } from '../../src/lib/game/config/economy'
import { LEVELING } from '../../src/lib/game/config/leveling'
import {
  BUILDING_MAX_LEVEL,
  CASTLE_TOWN_HALL_OFFSET,
  EXTRA_QUEUE_SLOT_TOWN_HALL_LEVEL,
  CITY_BUILDING_ORDER,
  compoundBps,
  constructionQueueSlots,
  effectsFor,
  getBuildingDef,
  isBuildingType,
  materializeBuildingCatalog,
  upgradeCostFor,
  upgradeDurationSecFor,
  upgradeRequirementsFor,
} from '../../src/lib/game/config/buildings'

const MAX_SAFE_COST = 9_000_000_000_000 // far below 2^53 and below MAX_DELTA

describe('building catalog — structural invariants', () => {
  const catalog = materializeBuildingCatalog()

  it('covers exactly the 17 canonical building types', () => {
    expect(catalog.length).toBe(BUILDING_TYPES.length)
    expect(new Set(catalog.map((c) => c.type)).size).toBe(BUILDING_TYPES.length)
    for (const type of BUILDING_TYPES) {
      expect(catalog.find((c) => c.type === type)).toBeDefined()
    }
  })

  it('orders the display list over the same canonical types', () => {
    expect([...CITY_BUILDING_ORDER].sort()).toEqual([...BUILDING_TYPES].sort())
  })

  it('gives every building a sane max level (castle bounded by the TH chain)', () => {
    for (const entry of catalog) {
      expect(entry.maxLevel).toBeGreaterThanOrEqual(2)
      expect(entry.maxLevel).toBeLessThanOrEqual(BUILDING_MAX_LEVEL)
      expect(entry.levels.length).toBe(entry.maxLevel)
    }
    const castle = catalog.find((c) => c.type === 'CASTLE')!
    expect(castle.maxLevel).toBe(BUILDING_MAX_LEVEL - CASTLE_TOWN_HALL_OFFSET)
  })

  it('materializes every level with non-empty integer costs and positive durations', () => {
    for (const entry of catalog) {
      for (const level of entry.levels) {
        if (level.level === 1) {
          // Level 1 is the bootstrap state — no upgrade cost.
          expect(Object.keys(level.cost).length).toBe(0)
        } else {
          const costs = Object.entries(level.cost) as Array<[string, number]>
          expect(costs.length).toBeGreaterThan(0)
          for (const [resource, amount] of costs) {
            expect(Number.isInteger(amount)).toBeTrue()
            expect(amount).toBeGreaterThan(0)
            expect(amount).toBeLessThanOrEqual(MAX_SAFE_COST)
            expect(BigInt(amount) <= MAX_DELTA).toBeTrue()
            expect(['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']).toContain(resource)
          }
          expect(Number.isInteger(level.durationSec)).toBeTrue()
          expect(level.durationSec).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('makes costs and durations strictly monotonic per level', () => {
    for (const entry of catalog) {
      for (let i = 1; i < entry.levels.length; i++) {
        const prev = entry.levels[i - 1]!
        const curr = entry.levels[i]!
        const prevTotal = Object.values(prev.cost).reduce((a, b) => a + (b as number), 0)
        const currTotal = Object.values(curr.cost).reduce((a, b) => a + (b as number), 0)
        expect(currTotal).toBeGreaterThan(prevTotal)
        expect(curr.durationSec).toBeGreaterThan(prev.durationSec)
      }
    }
  })

  it('keeps first upgrades affordable against the starter wallet', () => {
    // Starter wallet: GOLD 1500 · WOOD 800 · IRON 400 · FOOD 600 · CRYSTAL 20.
    // Every building's FIRST upgrade (to level 2) must be within reach so a
    // new player can complete at least one construction immediately.
    const starter = { GOLD: 1500, WOOD: 800, IRON: 400, FOOD: 600, CRYSTAL: 20 }
    for (const entry of catalog) {
      const cost = entry.levels[1]!.cost as Record<string, number>
      for (const [resource, amount] of Object.entries(cost)) {
        expect(amount).toBeLessThanOrEqual(starter[resource as keyof typeof starter]!)
      }
    }
  })

  it('requires the player level and Town Hall levels that actually exist', () => {
    for (const entry of catalog) {
      for (const level of entry.levels) {
        const req = level.requirements
        if (req.playerLevel !== undefined) {
          expect(req.playerLevel).toBeGreaterThan(1)
          expect(req.playerLevel).toBeLessThanOrEqual(LEVELING.maxLevel)
        }
        if (req.townHallLevel !== undefined) {
          expect(req.townHallLevel).toBeGreaterThan(1)
          expect(req.townHallLevel).toBeLessThanOrEqual(BUILDING_MAX_LEVEL)
        }
      }
    }
  })

  it('gates the castle harder than the rest (TH ≥ target + offset)', () => {
    const castle = catalog.find((c) => c.type === 'CASTLE')!
    for (const level of castle.levels) {
      expect(level.requirements.townHallLevel).toBe(level.level + CASTLE_TOWN_HALL_OFFSET)
    }
  })

  it('chains the armory and spy center onto their prerequisite buildings', () => {
    const armory = catalog.find((c) => c.type === 'ARMORY')!
    expect(armory.levels[2]!.requirements.buildings).toEqual({ BARRACKS: 2 })

    const spy = catalog.find((c) => c.type === 'SPY_CENTER')!
    expect(spy.levels[1]!.requirements.buildings).toEqual({ SCOUT_CENTER: 1 })
    expect(spy.levels[1]!.requirements.townHallLevel).toBe(8)
  })

  it('leaves the town hall free of Town Hall requirements but player-level gated', () => {
    const th = catalog.find((c) => c.type === 'TOWN_HALL')!
    for (const level of th.levels) {
      expect(level.requirements.townHallLevel).toBeUndefined()
      if (level.level > 2) {
        expect(level.requirements.playerLevel).toBe(level.level - 1)
      }
    }
  })
})

describe('building effects — per-level materialization', () => {
  it('produces linear production growth for the four generators', () => {
    expect(effectsFor('FARM', 1).productionPerHour).toEqual({ FOOD: 60 })
    expect(effectsFor('FARM', 3).productionPerHour).toEqual({ FOOD: 180 })
    expect(effectsFor('GOLD_MINE', 2).productionPerHour).toEqual({ GOLD: 90 })
    expect(effectsFor('WOOD_MILL', 2).productionPerHour).toEqual({ WOOD: 100 })
    expect(effectsFor('IRON_MINE', 2).productionPerHour).toEqual({ IRON: 80 })
  })

  it('grows warehouse storage monotonically', () => {
    expect(effectsFor('WAREHOUSE', 1).storageCapacity).toBe(20_000)
    expect(effectsFor('WAREHOUSE', 15).storageCapacity).toBe(230_000)
  })

  it('grants the wall a growing defense bonus in bps', () => {
    expect(effectsFor('WALL', 1).defenseBps).toBe(10_000)
    expect(effectsFor('WALL', 15).defenseBps).toBe(10_000 + 600 * 14)
  })

  it('unlocks the second construction slot at the configured Town Hall level', () => {
    expect(effectsFor('TOWN_HALL', 9).queueSlots).toBe(1)
    expect(effectsFor('TOWN_HALL', EXTRA_QUEUE_SLOT_TOWN_HALL_LEVEL).queueSlots).toBe(2)
    expect(constructionQueueSlots(9)).toBe(1)
    expect(constructionQueueSlots(10)).toBe(2)
    expect(constructionQueueSlots(0)).toBe(1)
  })

  it('reduces the market fee with level and floors it', () => {
    expect(effectsFor('MARKET', 1).marketFeeBps).toBe(800)
    expect(effectsFor('MARKET', 5).marketFeeBps).toBe(600)
    expect(effectsFor('MARKET', 15).marketFeeBps).toBe(200)
  })

  it('gives the castle an extra march slot every five levels', () => {
    expect(effectsFor('CASTLE', 1).marchSlots).toBe(1)
    expect(effectsFor('CASTLE', 5).marchSlots).toBe(2)
    expect(effectsFor('CASTLE', 11).marchSlots).toBe(3)
  })

  it('keeps speed bonuses bps-shaped (10_000 base + linear growth)', () => {
    expect(effectsFor('BARRACKS', 1).trainingSpeedBps).toBe(10_000)
    expect(effectsFor('BARRACKS', 15).trainingSpeedBps).toBe(10_000 + 500 * 14)
    expect(effectsFor('ACADEMY', 15).researchSpeedBps).toBe(10_000 + 400 * 14)
    expect(effectsFor('HOSPITAL', 15).hospitalCapacity).toBe(50 + 40 * 14)
  })
})

describe('pure helpers — determinism and guards', () => {
  it('compounds bps with integer floor math deterministically', () => {
    expect(compoundBps(400, 0, 15_000)).toBe(400)
    expect(compoundBps(400, 1, 15_000)).toBe(600)
    expect(compoundBps(400, 2, 15_000)).toBe(900)
    // Deterministic: same inputs, same outputs (no float drift).
    expect(compoundBps(123, 5, 13_700)).toBe(compoundBps(123, 5, 13_700))
  })

  it('returns an empty cost for level 1 (bootstrap state)', () => {
    expect(upgradeCostFor('BARRACKS', 1)).toEqual({})
    expect(upgradeDurationSecFor('BARRACKS', 1)).toBe(0)
  })

  it('materializes the catalog deterministically (JSON-stable)', () => {
    expect(JSON.stringify(materializeBuildingCatalog())).toBe(
      JSON.stringify(materializeBuildingCatalog()),
    )
  })

  it('throws for unknown types on the def accessor and guards the predicate', () => {
    // @ts-expect-error — runtime guard check
    expect(() => getBuildingDef('PAGODA')).toThrow()
    expect(isBuildingType('BARRACKS')).toBeTrue()
    expect(isBuildingType('pagoda')).toBeFalse()
    expect(isBuildingType(42)).toBeFalse()
  })

  it('produces requirements objects only for gates above the floor', () => {
    // Farm L2: TH ≥ 1 is trivially true — must NOT appear in requirements.
    const farmL2 = upgradeRequirementsFor('FARM', 2)
    expect(farmL2.townHallLevel).toBeUndefined()
    expect(farmL2.playerLevel).toBeUndefined()
    // Farm L3: TH ≥ 2 — appears.
    expect(upgradeRequirementsFor('FARM', 3).townHallLevel).toBe(2)
  })
})
