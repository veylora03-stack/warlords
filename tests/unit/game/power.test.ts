/**
 * Unit tests — Power weights (config/power.ts).
 *
 * The pure math that makes power tamper-proof: deterministic integer
 * results, tier scaling, level scaling, and zero for absent/unknown input.
 */

import { describe, it, expect } from 'bun:test'
import {
  POWER,
  computeUnitBasePower,
  computeUnitStackPower,
  computeBuildingPower,
  computeTechPower,
} from '../../../src/lib/game/config/power'
import { UNITS } from '../../../src/lib/game/config/units'

describe('computeUnitBasePower', () => {
  it('matches the documented formula on a known unit', () => {
    // Militia: attack 10, defense 15, health 100, tier 1.
    // statPower = 10*10000 + 15*10000 + 100*5000 = 750000 → floor(750000*10000/1e8) = 75
    const militia = UNITS.find((u) => u.id === 'militia')!
    expect(computeUnitBasePower(militia)).toBe(75)
  })

  it('scales with tier through the configured bonus', () => {
    const base = {
      attack: 10,
      defense: 10,
      health: 100,
      tier: 1,
    }
    const t1 = computeUnitBasePower(base)
    const t3 = computeUnitBasePower({ ...base, tier: 3 })
    // Tier 3 → multiplier 10000 + 2*2000 = 14000 bps.
    expect(t3).toBe(Math.floor((t1 * 14_000) / 10_000))
    expect(t3).toBeGreaterThan(t1)
  })

  it('normalizes a non-positive tier to tier 1', () => {
    const unit = { attack: 10, defense: 10, health: 100, tier: 0 }
    expect(computeUnitBasePower(unit)).toBe(computeUnitBasePower({ ...unit, tier: 1 }))
  })
})

describe('computeUnitStackPower', () => {
  it('multiplies base power by count', () => {
    const unit = { attack: 10, defense: 15, health: 100, tier: 1 }
    expect(computeUnitStackPower(unit, 20)).toBe(computeUnitBasePower(unit) * 20)
  })

  it('yields zero for empty or negative stacks', () => {
    const unit = { attack: 10, defense: 15, health: 100, tier: 1 }
    expect(computeUnitStackPower(unit, 0)).toBe(0)
    expect(computeUnitStackPower(unit, -5)).toBe(0)
  })
})

describe('computeBuildingPower', () => {
  it('is weight × level for known types', () => {
    expect(computeBuildingPower('TOWN_HALL', 1)).toBe(POWER.buildingWeight['TOWN_HALL'])
    expect(computeBuildingPower('CASTLE', 3)).toBe(POWER.buildingWeight['CASTLE'] * 3)
  })

  it('yields zero for unknown types and non-positive levels', () => {
    expect(computeBuildingPower('PYRAMID', 5)).toBe(0)
    expect(computeBuildingPower('CASTLE', 0)).toBe(0)
    expect(computeBuildingPower('CASTLE', -2)).toBe(0)
  })
})

describe('computeTechPower', () => {
  it('is branch weight × level', () => {
    expect(computeTechPower('MILITARY', 2)).toBe(POWER.techBranchWeight['MILITARY'] * 2)
    expect(computeTechPower('SCOUTING', 1)).toBe(POWER.techBranchWeight['SCOUTING'])
  })

  it('yields zero for unknown branches and non-positive levels', () => {
    expect(computeTechPower('ALCHEMY', 3)).toBe(0)
    expect(computeTechPower('MILITARY', 0)).toBe(0)
  })
})

describe('starter-kit sanity (anti-tamper baseline)', () => {
  it('produces the exact documented starter power: 3810', () => {
    // Starter army: 20 militia + 10 archers; starter buildings: 17 types at level 1.
    const armyPower =
      computeUnitStackPower(
        { attack: 10, defense: 15, health: 100, tier: 1 }, // militia
        20,
      ) +
      computeUnitStackPower(
        { attack: 15, defense: 8, health: 80, tier: 1 }, // archer
        10,
      )
    const buildingsPower = Object.keys(POWER.buildingWeight).reduce(
      (sum, type) => sum + computeBuildingPower(type, 1),
      0,
    )
    expect(armyPower).toBe(2130)
    expect(buildingsPower).toBe(1680)
    expect(armyPower + buildingsPower).toBe(3810) // asserted identically by integration tests
  })
})
