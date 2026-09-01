/**
 * Unit tests — World configuration (Phase 32).
 *
 * The WORLD config is the single source of truth for world balance. These
 * tests pin the invariants the engine relies on: terrain coverage of the
 * battle config, garrison arithmetic, production policy, region grid math
 * and the cross-config coherence between world/battle/economy catalogs.
 */

import { describe, it, expect } from 'bun:test'
import {
  GENERATION_TERRAIN_TYPES,
  TERRAIN,
  TERRITORY_HISTORY_REASONS,
  TERRITORY_STATUSES,
  WORLD,
  WORLD_ATTACK,
  WORLD_GENERATION,
  WORLD_GARRISON,
  WORLD_MAP_POLICY,
  WORLD_PRODUCTION,
  regionGridCount,
} from '../../../src/lib/game/config/world'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { ECONOMY_RESOURCES, LEDGER_REASONS } from '../../../src/lib/game/config/economy'
import { STAT_KEYS } from '../../../src/lib/game/config/stats'

describe('WORLD config — grid', () => {
  it('is a 41×41 deterministic grid with 7×7 regions', () => {
    expect(WORLD.sizeX).toBe(41)
    expect(WORLD.sizeY).toBe(41)
    expect(WORLD.regionSize).toBe(7)
    expect(Number.isInteger(WORLD.seed)).toBe(true)
    expect(regionGridCount()).toBe(36)
  })

  it('bounds every map viewport under the policy cap', () => {
    expect(WORLD_MAP_POLICY.maxViewportArea).toBeGreaterThanOrEqual(0)
    expect(WORLD_MAP_POLICY.maxViewportArea).toBeLessThan(WORLD.sizeX * WORLD.sizeY)
    expect(WORLD_MAP_POLICY.defaultViewportRadius).toBeGreaterThan(0)
  })
})

describe('WORLD config — terrain catalog', () => {
  it('covers every battle terrain with coherent modifiers', () => {
    for (const [terrain, def] of Object.entries(TERRAIN)) {
      expect(BATTLE.terrainAttackBps[terrain as keyof typeof BATTLE.terrainAttackBps]).toBe(
        def.attackBps,
      )
      expect(def.defenseBps).toBeGreaterThanOrEqual(0)
      expect(def.productionMultiplierBps).toBeGreaterThan(0)
      expect(ECONOMY_RESOURCES).toContain(def.resource)
    }
  })

  it('gives defensive terrain a cost to attack (mountains > forest > plains)', () => {
    expect(TERRAIN.MOUNTAINS.attackBps).toBeLessThan(TERRAIN.FOREST.attackBps)
    expect(TERRAIN.FOREST.attackBps).toBeLessThan(TERRAIN.PLAINS.attackBps)
    expect(TERRAIN.MOUNTAINS.defenseBps).toBeGreaterThan(0)
  })

  it('never generates CITY terrain (capitals are allocated, not generated)', () => {
    expect(GENERATION_TERRAIN_TYPES).not.toContain('CITY')
    expect(TERRAIN.CITY.weight).toBe(0)
  })

  it('weights every generatable terrain positively', () => {
    for (const terrain of GENERATION_TERRAIN_TYPES) {
      expect(TERRAIN[terrain].weight).toBeGreaterThan(0)
    }
  })
})

describe('WORLD config — garrison policy', () => {
  it('composes exactly 10_000 bps with bounded jitter', () => {
    const total = Object.values(WORLD_GARRISON.composition).reduce((a, b) => a + b, 0)
    expect(total).toBe(10_000)
    expect(WORLD_GARRISON.jitterBps).toBeGreaterThanOrEqual(0)
    expect(WORLD_GARRISON.jitterBps).toBeLessThanOrEqual(5_000)
  })

  it('scales garrison size with strategic value and hard-caps it', () => {
    expect(WORLD_GARRISON.baseUnits).toBeGreaterThan(0)
    expect(WORLD_GARRISON.maxUnits).toBeGreaterThan(WORLD_GARRISON.baseUnits)
    expect(WORLD_GARRISON.hospitalBps).toBe(0) // NPC losses are never hospitalized
  })
})

describe('WORLD config — attack, production and generation policy', () => {
  it('charges energy within the battle economy scale', () => {
    expect(WORLD_ATTACK.energyCost).toBeGreaterThan(0)
    expect(WORLD_ATTACK.captureSpoilsPerStrategicValue).toBeGreaterThanOrEqual(0)
    expect(WORLD_ATTACK.captureSpoilsCap).toBeGreaterThanOrEqual(
      WORLD_ATTACK.captureSpoilsPerStrategicValue * 10,
    )
    for (const key of [
      'captureWinXp',
      'attackParticipationXp',
      'defenseWinXp',
      'defenseParticipationXp',
    ] as const) {
      expect(WORLD_ATTACK[key]).toBeGreaterThan(0)
    }
    expect(WORLD_ATTACK.captureHonor).toBeGreaterThan(0)
  })

  it('bounds production accrual (min interval + cap hours)', () => {
    expect(WORLD_PRODUCTION.minIntervalSec).toBeGreaterThan(0)
    expect(WORLD_PRODUCTION.capHours).toBeGreaterThanOrEqual(1)
    expect(WORLD_PRODUCTION.baseRatePerHour).toBeGreaterThan(0)
    expect(WORLD_PRODUCTION.ratePerStrategicValue).toBeGreaterThanOrEqual(0)
  })

  it('locks a bounded, distinct set of special sites', () => {
    expect(WORLD_GENERATION.lockedCellCount).toBeGreaterThan(0)
    expect(WORLD_GENERATION.lockedCellCount).toBeLessThan(100)
    expect(WORLD_GENERATION.producingCellBps).toBeGreaterThan(0)
    expect(WORLD_GENERATION.producingCellBps).toBeLessThanOrEqual(10_000)
  })
})

describe('WORLD config — cross-catalog coherence', () => {
  it('registers both territory ledger reasons in the economy catalog', () => {
    expect(LEDGER_REASONS).toContain('TERRITORY_CAPTURE')
    expect(LEDGER_REASONS).toContain('TERRITORY_PRODUCTION')
  })

  it('registers the territory stat counters', () => {
    for (const key of ['territoriesCaptured', 'territoriesDefended', 'territoriesLost']) {
      expect(STAT_KEYS).toContain(key)
    }
  })

  it('exposes exactly the three territory states and the history reason catalog', () => {
    expect([...TERRITORY_STATUSES].sort()).toEqual(['CONTROLLED', 'LOCKED', 'UNCLAIMED'])
    expect([...TERRITORY_HISTORY_REASONS].sort()).toEqual(
      ['ADMIN', 'CAPTURE', 'SEASON_RESET', 'SPAWN', 'WORLD_INIT'].sort(),
    )
  })
})
