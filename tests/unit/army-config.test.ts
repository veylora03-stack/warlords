/**
 * Unit tests — Unit catalog & training policy (Phase 7: Army & Unit System).
 *
 * The roster is the ONLY authority for unit balance numbers: these tests pin
 * its structural invariants so a bad rebalance (broken counter symmetry,
 * negative costs, a unit trained at a building without a training speed,
 * unreachable building gates) fails fast in CI — long before any player
 * sees it.
 */

import { describe, it, expect } from 'bun:test'
import { BUILDING_TYPES, UNIT_CLASSES } from '../../src/lib/game/types/common'
import { MAX_DELTA } from '../../src/lib/game/config/economy'
import { ARMY_TRAINING } from '../../src/lib/game/config/army'
import { effectsFor } from '../../src/lib/game/config/buildings'
import { UNITS, UNIT_CLASS_ORDER } from '../../src/lib/game/config/units'

const MAX_SAFE_COST = 9_000_000_000_000 // far below 2^53 and below MAX_DELTA

// The Phase 7 contract roster (user spec) — exact ids per class.
const CONTRACT_ROSTER: Record<string, string[]> = {
  INFANTRY: ['swordsman', 'shield_guard', 'heavy_infantry'],
  RANGED: ['archer', 'crossbowman'],
  CAVALRY: ['cavalry', 'heavy_cavalry', 'knight'],
  SIEGE: ['catapult', 'cannon', 'siege_engine'],
}

describe('unit roster — structural invariants', () => {
  it('covers exactly the 11-unit Phase 7 contract roster', () => {
    expect(UNITS.length).toBe(11)
    for (const [cls, ids] of Object.entries(CONTRACT_ROSTER)) {
      const rosterIds = UNITS.filter((u) => u.class === cls).map((u) => u.id)
      expect(rosterIds.sort()).toEqual([...ids].sort())
    }
  })

  it('has globally unique ids', () => {
    const ids = UNITS.map((u) => u.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('assigns valid classes and a per-class tier ladder without gaps', () => {
    for (const unit of UNITS) {
      expect(UNIT_CLASSES).toContain(unit.class)
    }
    for (const cls of UNIT_CLASSES) {
      const tiers = UNITS.filter((u) => u.class === cls)
        .map((u) => u.tier)
        .sort((a, b) => a - b)
      // Tiers start at 1 and are contiguous (1..N) per class.
      expect(tiers).toEqual(Array.from({ length: tiers.length }, (_, i) => i + 1))
    }
  })

  it('gives every unit positive integer combat stats and upkeep', () => {
    for (const unit of UNITS) {
      for (const stat of [unit.attack, unit.defense, unit.health, unit.speed] as number[]) {
        expect(Number.isInteger(stat)).toBeTrue()
        expect(stat).toBeGreaterThan(0)
      }
      expect(Number.isInteger(unit.foodUpkeep)).toBeTrue()
      expect(unit.foodUpkeep).toBeGreaterThan(0)
      expect(Number.isInteger(unit.carryCapacity)).toBeTrue()
      expect(unit.carryCapacity).toBeGreaterThanOrEqual(0)
    }
  })

  it('trains siege units with zero carry capacity (walls, not loot)', () => {
    for (const unit of UNITS.filter((u) => u.class === 'SIEGE')) {
      expect(unit.carryCapacity).toBe(0)
    }
  })

  it('gives every unit positive integer training time and sane costs within the ceiling', () => {
    for (const unit of UNITS) {
      expect(Number.isInteger(unit.trainingTimeSec)).toBeTrue()
      expect(unit.trainingTimeSec).toBeGreaterThanOrEqual(1)
      const costs = Object.entries(unit.trainingCost) as Array<[string, number]>
      expect(costs.length).toBeGreaterThan(0)
      for (const [resource, amount] of costs) {
        expect(['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']).toContain(resource)
        expect(Number.isInteger(amount)).toBeTrue()
        expect(amount).toBeGreaterThan(0)
        expect(amount).toBeLessThanOrEqual(MAX_SAFE_COST)
        // A full batch must stay inside the single-mutation ceiling.
        expect(BigInt(amount) * BigInt(ARMY_TRAINING.maxUnitsPerBatch)).toBeLessThanOrEqual(
          MAX_DELTA,
        )
      }
    }
  })
})

describe('unit roster — training building gates', () => {
  it('maps every unit to a valid training building', () => {
    for (const unit of UNITS) {
      expect(BUILDING_TYPES).toContain(unit.trainingBuilding)
      expect(Number.isInteger(unit.requiredBuildingLevel)).toBeTrue()
      expect(unit.requiredBuildingLevel).toBeGreaterThanOrEqual(1)
    }
  })

  it('trains each class at its canonical camp', () => {
    const expected: Record<string, string> = {
      INFANTRY: 'BARRACKS',
      RANGED: 'ARCHER_CAMP',
      CAVALRY: 'STABLE',
      SIEGE: 'ARMORY',
    }
    for (const unit of UNITS) {
      expect(unit.trainingBuilding).toBe(expected[unit.class])
    }
  })

  it('scales building gates with tier (T1 → lv1, T2 → lv5, T3 → lv10)', () => {
    const expectedTierGate: Record<number, number> = { 1: 1, 2: 5, 3: 10 }
    for (const unit of UNITS) {
      expect(unit.requiredBuildingLevel).toBe(expectedTierGate[unit.tier])
    }
  })

  it('gives every training camp a real training speed effect at gate level', () => {
    const camps = new Set(UNITS.map((u) => u.trainingBuilding))
    for (const camp of camps) {
      for (const unit of UNITS.filter((u) => u.trainingBuilding === camp)) {
        const speed = effectsFor(camp, unit.requiredBuildingLevel).trainingSpeedBps
        expect(speed).toBeDefined()
        expect(speed! > 0).toBeTrue()
      }
    }
  })
})

describe('unit roster — data-driven counter matrix', () => {
  const byId = new Map(UNITS.map((u) => [u.id, u]))

  it('expresses the class triangle per unit at 2500 bps', () => {
    for (const unit of UNITS) {
      for (const counter of unit.strongAgainst) {
        expect(counter.bonusBps).toBe(2500)
        expect(byId.has(counter.unitId)).toBeTrue()
      }
      for (const penalty of unit.weakAgainst) {
        expect(penalty.penaltyBps).toBe(2500)
        expect(byId.has(penalty.unitId)).toBeTrue()
      }
    }
  })

  it('keeps strongAgainst and weakAgainst symmetric inverses for field classes', () => {
    for (const unit of UNITS) {
      if (unit.class === 'SIEGE') continue
      for (const counter of unit.strongAgainst) {
        const enemy = byId.get(counter.unitId)!
        const mirrored = enemy.weakAgainst.find((p) => p.unitId === unit.id)
        expect(mirrored).toBeDefined()
        expect(mirrored!.penaltyBps).toBe(counter.bonusBps)
      }
      for (const penalty of unit.weakAgainst) {
        const enemy = byId.get(penalty.unitId)!
        const mirrored = enemy.strongAgainst.find((c) => c.unitId === unit.id)
        expect(mirrored).toBeDefined()
        expect(mirrored!.bonusBps).toBe(penalty.penaltyBps)
      }
    }
  })

  it('triangulates the field: Infantry ▸ Cavalry ▸ Ranged ▸ Infantry', () => {
    const ids = (cls: string) =>
      UNITS.filter((u) => u.class === cls)
        .map((u) => u.id)
        .sort()
    for (const unit of UNITS.filter((u) => u.class !== 'SIEGE')) {
      const prey =
        unit.class === 'INFANTRY'
          ? ids('CAVALRY')
          : unit.class === 'CAVALRY'
            ? ids('RANGED')
            : ids('INFANTRY')
      const predator =
        unit.class === 'INFANTRY'
          ? ids('RANGED')
          : unit.class === 'CAVALRY'
            ? ids('INFANTRY')
            : ids('CAVALRY')
      expect(unit.strongAgainst.map((c) => c.unitId).sort()).toEqual(prey)
      expect(unit.weakAgainst.map((p) => p.unitId).sort()).toEqual(predator)
    }
  })

  it('leaves siege without field counters but afraid of every cavalry unit', () => {
    for (const unit of UNITS.filter((u) => u.class === 'SIEGE')) {
      expect(unit.strongAgainst).toEqual([])
      expect(unit.weakAgainst.map((p) => p.unitId).sort()).toEqual(
        UNITS.filter((u) => u.class === 'CAVALRY')
          .map((u) => u.id)
          .sort(),
      )
    }
  })
})

describe('ARMY_TRAINING policy', () => {
  it('is bounded and refund-matrix consistent', () => {
    expect(ARMY_TRAINING.queueSlots).toBeGreaterThanOrEqual(1)
    expect(ARMY_TRAINING.maxUnitsPerBatch).toBeGreaterThanOrEqual(1)
    expect(ARMY_TRAINING.bpsDenominator).toBe(10_000)
    expect(ARMY_TRAINING.notStartedRefundBps).toBe(10_000) // full refund before start
    expect(ARMY_TRAINING.inProgressRefundBps).toBeGreaterThan(0)
    expect(ARMY_TRAINING.inProgressRefundBps).toBeLessThan(ARMY_TRAINING.notStartedRefundBps)
  })
})

describe('UNIT_CLASS_ORDER', () => {
  it('matches the display contract order', () => {
    expect(UNIT_CLASS_ORDER).toEqual(['INFANTRY', 'RANGED', 'CAVALRY', 'SIEGE'])
  })
})
