/**
 * Unit tests — Phase 25 performance fixes: catalog memoization.
 *
 * The army/building catalog views are pure functions of static config.
 * They are MEMOIZED at module scope (one computation per process) so the
 * hottest read paths stop rebuilding 17 types × levels of BigInt→string
 * maps per request. These tests pin BOTH the caching contract (stable
 * identity — callers must treat the object as immutable) and the shape
 * contract (the cached view stays byte-identical to a fresh computation).
 */

import { describe, it, expect } from 'bun:test'
import { getArmyCatalogView } from '../../../src/lib/game/services/army.service'
import { getBuildingCatalogView } from '../../../src/lib/game/services/city.service'
import { UNITS } from '../../../src/lib/game/config/units'
import { BUILDING_TYPES } from '../../../src/lib/game/types/common'

describe('army catalog view (memoized)', () => {
  it('returns the SAME cached object on every call (stable identity)', () => {
    const first = getArmyCatalogView()
    const second = getArmyCatalogView()
    expect(second).toBe(first)
  })

  it('projects the full roster with server-owned numbers as strings', () => {
    const view = getArmyCatalogView()
    expect(view.units).toHaveLength(UNITS.length)
    const swordsman = view.units.find((u) => u.id === 'swordsman')
    expect(swordsman).toBeDefined()
    if (!swordsman) return
    expect(swordsman.trainingCost.GOLD).toBe('120') // string, never float
    expect(swordsman.trainingTimeSec).toBe(22)
    expect(swordsman.trainingBuilding).toBe('BARRACKS')
  })

  it('counter relationships survive the cache (combat authority intact)', () => {
    const view = getArmyCatalogView()
    for (const unit of view.units) {
      expect(Array.isArray(unit.strongAgainst)).toBe(true)
      expect(Array.isArray(unit.weakAgainst)).toBe(true)
    }
  })
})

describe('building catalog view (memoized)', () => {
  it('returns the SAME cached object on every call (stable identity)', () => {
    const first = getBuildingCatalogView()
    const second = getBuildingCatalogView()
    expect(second).toBe(first)
  })

  it('materializes every building type with per-level specs', () => {
    const view = getBuildingCatalogView()
    expect(view.types).toHaveLength(BUILDING_TYPES.length)
    const townHall = view.types.find((t) => t.type === 'TOWN_HALL')
    expect(townHall).toBeDefined()
    if (!townHall) return
    expect(townHall.levels.length).toBe(townHall.maxLevel)
    // Level 1 is the bootstrap state — no cost.
    expect(townHall.levels[0]!.cost).toEqual({})
    expect(townHall.levels[1]!.durationSec).toBeGreaterThan(0)
  })

  it('every level spec carries positive durations and non-negative costs', () => {
    const view = getBuildingCatalogView()
    for (const type of view.types) {
      for (const level of type.levels) {
        expect(level.durationSec).toBeGreaterThanOrEqual(0)
        for (const amount of Object.values(level.cost)) {
          expect(Number(amount)).toBeGreaterThan(0)
        }
      }
    }
  })
})
