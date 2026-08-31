/**
 * Unit tests — Battle configuration invariants (Phase 28).
 *
 * The battle config is the single balance authority; these tests pin the
 * structural invariants the engine and service rely on (a broken config must
 * fail loudly here before any battle runs).
 */

import { describe, it, expect } from 'bun:test'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { UNIT_CLASSES } from '../../../src/lib/game/types/common'
import type { TerrainType } from '../../../src/lib/game/types/battle'

const ALL_TERRAINS: TerrainType[] = ['PLAINS', 'FOREST', 'MOUNTAINS', 'RIVER', 'CITY']

describe('BATTLE config invariants', () => {
  it('is versioned for replay fidelity', () => {
    expect(Number.isInteger(BATTLE.version)).toBe(true)
    expect(BATTLE.version).toBeGreaterThanOrEqual(1)
  })

  it('initiative covers every unit class exactly once', () => {
    expect([...BATTLE.classInitiative].sort()).toEqual([...UNIT_CLASSES].sort())
  })

  it('terrain table covers every declared terrain', () => {
    for (const terrain of ALL_TERRAINS) {
      const bps = BATTLE.terrainAttackBps[terrain]
      expect(typeof bps).toBe('number')
      expect(bps).toBeGreaterThanOrEqual(-10_000)
      expect(bps).toBeLessThanOrEqual(10_000)
    }
  })

  it('loot and casualty policies are valid basis-point shares', () => {
    expect(BATTLE.loot.defenderLootableBps).toBeGreaterThanOrEqual(0)
    expect(BATTLE.loot.defenderLootableBps).toBeLessThanOrEqual(10_000)
    expect(BATTLE.casualties.defenderHospitalBps).toBeGreaterThanOrEqual(0)
    expect(BATTLE.casualties.defenderHospitalBps).toBeLessThanOrEqual(10_000)
  })

  it('combat economics are sane (positive energy cost, bounded cooldown)', () => {
    expect(BATTLE.energy.attackCost).toBeGreaterThan(0)
    expect(BATTLE.cooldown.attackCooldownSec).toBeGreaterThan(0)
    expect(BATTLE.maxRounds).toBeGreaterThanOrEqual(1)
    expect(BATTLE.maxRounds).toBeLessThanOrEqual(100)
  })

  it('protection rules are active by default (anti-bullying contract)', () => {
    expect(BATTLE.protection.newbieLevelCap).toBeGreaterThanOrEqual(1)
    expect(BATTLE.protection.newbieAgeHours).toBeGreaterThan(0)
    expect(BATTLE.protection.maxAttacksPerTargetPerDay).toBeGreaterThanOrEqual(1)
  })

  it('rewards never destroy progression (no negative deltas)', () => {
    for (const value of Object.values(BATTLE.rewards)) {
      expect(value).toBeGreaterThanOrEqual(0)
    }
  })
})
