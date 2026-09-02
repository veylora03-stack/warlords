/**
 * Unit tests — MARCH config + movement engine (Phase 33).
 *
 * Covers the pure layer ONLY: config invariants, the deterministic
 * travel-time function (distance × pace × terrain × scout bonus, clamped),
 * the march state machine (every legal + every illegal transition) and the
 * stack algebra (parse/merge/subtract — the reservation manifest math).
 * No DB, no clock — everything is deterministic.
 */

import { describe, it, expect } from 'bun:test'
import { MARCH, marchTravelSeconds, scoutSpeedBonusBps } from '../../../src/lib/game/config/march'
import { TERRAIN, TERRAIN_TYPES } from '../../../src/lib/game/config/world'
import {
  manhattanDistance,
  parseMarchStacks,
  readStoredStacks,
  slowestArmySpeed,
  subtractStacks,
  mergeStacks,
  totalUnits,
  isMarchTransition,
  isTerminalMarchStatus,
  isCancellable,
  ACTIVE_MARCH_STATUSES,
  MARCH_TRANSITIONS,
} from '../../../src/lib/game/engine/march/movement'
import { MARCH_STATUSES, MARCH_TYPES } from '../../../src/lib/game/types/common'
import type { MarchStatus } from '../../../src/lib/game/types/common'

// ── Config invariants ────────────────────────────────────────────────────────

describe('MARCH config invariants', () => {
  it('is versioned and bounded sanely', () => {
    expect(MARCH.version).toBeGreaterThanOrEqual(1)
    expect(MARCH.secondsPerCell).toBeGreaterThan(0)
    expect(MARCH.referenceSpeed).toBeGreaterThan(0)
    expect(MARCH.minTravelSeconds).toBeLessThan(MARCH.maxTravelSeconds)
    expect(MARCH.maxUnitsPerMarch).toBeGreaterThan(0)
    expect(MARCH.cancelRefundEnergyBps).toBe(0) // mobilization never refunded
  })

  it('every terrain has a move cost within the documented range', () => {
    for (const terrain of TERRAIN_TYPES) {
      const def = TERRAIN[terrain]
      expect(def.moveCostBps).toBeGreaterThanOrEqual(5_000)
      expect(def.moveCostBps).toBeLessThanOrEqual(30_000)
    }
  })

  it('plains/city are neutral (10_000 bps) and swamp is the costliest', () => {
    expect(TERRAIN.PLAINS.moveCostBps).toBe(10_000)
    expect(TERRAIN.CITY.moveCostBps).toBe(10_000)
    expect(TERRAIN.SWAMP.moveCostBps).toBe(16_000)
    let costliest = TERRAIN_TYPES[0]!
    for (const t of TERRAIN_TYPES) {
      if (TERRAIN[t]!.moveCostBps > TERRAIN[costliest]!.moveCostBps) costliest = t
    }
    expect(costliest).toBe('SWAMP')
  })
})

// ── Travel time (the ONLY timing authority) ──────────────────────────────────

describe('marchTravelSeconds', () => {
  it('reference army on neutral terrain: distance × secondsPerCell (min-clamped)', () => {
    // speed 5 = referenceSpeed → factor 10_000; PLAINS = 10_000
    // distance 1 → 20s raw, but the rushed-departure clamp raises it to 30s.
    expect(marchTravelSeconds({ distance: 1, armySpeed: 5, destinationTerrain: 'PLAINS' })).toBe(
      MARCH.minTravelSeconds,
    )
    expect(marchTravelSeconds({ distance: 4, armySpeed: 5, destinationTerrain: 'PLAINS' })).toBe(80)
  })

  it('Manhattan scale: 40-cell world crossing stays within the clamp', () => {
    const seconds = marchTravelSeconds({ distance: 80, armySpeed: 5, destinationTerrain: 'PLAINS' })
    expect(seconds).toBe(1600)
  })

  it('slower armies take longer; the factor is clamped above', () => {
    // speed 1 → factor 50_000 → clamped to maxSpeedFactorBps 20_000 → 2× time
    const slow = marchTravelSeconds({ distance: 4, armySpeed: 1, destinationTerrain: 'PLAINS' })
    expect(slow).toBe(160) // 80 × 2
  })

  it('slower armies are strictly slower than the reference pace', () => {
    const ref = marchTravelSeconds({ distance: 10, armySpeed: 5, destinationTerrain: 'PLAINS' })
    const slow = marchTravelSeconds({ distance: 10, armySpeed: 3, destinationTerrain: 'PLAINS' })
    expect(slow).toBeGreaterThan(ref)
  })

  it('terrain multiplies the travel time', () => {
    const plains = marchTravelSeconds({ distance: 5, armySpeed: 5, destinationTerrain: 'PLAINS' })
    const swamp = marchTravelSeconds({ distance: 5, armySpeed: 5, destinationTerrain: 'SWAMP' })
    expect(swamp).toBe(Math.ceil((plains * TERRAIN.SWAMP.moveCostBps) / 10_000))
    expect(swamp).toBeGreaterThan(plains)
  })

  it('the scout bonus (SCOUT_CENTER effect) shortens scout marches', () => {
    const plain = marchTravelSeconds({ distance: 5, armySpeed: 5, destinationTerrain: 'PLAINS' })
    const scouted = marchTravelSeconds({
      distance: 5,
      armySpeed: 5,
      destinationTerrain: 'PLAINS',
      scoutSpeedBps: 13_000,
    })
    expect(scouted).toBeLessThan(plain)
    expect(scouted).toBe(Math.ceil(plain / 1.3))
  })

  it('everything is clamped into [minTravelSeconds, maxTravelSeconds]', () => {
    const tiny = marchTravelSeconds({ distance: 0, armySpeed: 12, destinationTerrain: 'CITY' })
    expect(tiny).toBe(MARCH.minTravelSeconds)
    const huge = marchTravelSeconds({ distance: 10_000, armySpeed: 1, destinationTerrain: 'SWAMP' })
    expect(huge).toBe(MARCH.maxTravelSeconds)
  })

  it('is deterministic — same inputs, same seconds (repeatedly)', () => {
    const a = marchTravelSeconds({ distance: 7, armySpeed: 4, destinationTerrain: 'HILLS' })
    const b = marchTravelSeconds({ distance: 7, armySpeed: 4, destinationTerrain: 'HILLS' })
    expect(a).toBe(b)
    expect(Number.isInteger(a)).toBe(true)
  })

  it('scoutSpeedBonusBps mirrors the SCOUT_CENTER catalog (reserved effect consumed)', () => {
    expect(scoutSpeedBonusBps(1)).toBe(10_000)
    expect(scoutSpeedBonusBps(5)).toBe(10_000 + 300 * 4)
  })
})

// ── Distance metric ──────────────────────────────────────────────────────────

describe('manhattanDistance (the 4-dir world metric)', () => {
  it('measures the N/S/E/W path length', () => {
    expect(manhattanDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7)
    expect(manhattanDistance({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(0)
    expect(manhattanDistance({ x: 40, y: 40 }, { x: 0, y: 0 })).toBe(80)
  })

  it('is symmetric and direction-agnostic', () => {
    expect(manhattanDistance({ x: 1, y: 2 }, { x: 5, y: 5 })).toBe(
      manhattanDistance({ x: 5, y: 5 }, { x: 1, y: 2 }),
    )
  })
})

// ── Stack algebra (reservation manifests & survivors) ────────────────────────

describe('march stack algebra', () => {
  it('parseMarchStacks canonicalizes and sorts', () => {
    const stacks = parseMarchStacks([
      { unitId: 'archer', count: 30 },
      { unitId: 'swordsman', count: 70 },
    ])
    expect(stacks).toEqual([
      { unitId: 'archer', count: 30 },
      { unitId: 'swordsman', count: 70 },
    ])
  })

  it('parseMarchStacks rejects every malformed shape', () => {
    expect(() => parseMarchStacks('nope')).toThrow()
    expect(() => parseMarchStacks([])).toThrow()
    expect(() => parseMarchStacks([{ unitId: 'swordsman', count: 0 }])).toThrow()
    expect(() => parseMarchStacks([{ unitId: 'swordsman', count: -5 }])).toThrow()
    expect(() => parseMarchStacks([{ unitId: 'swordsman', count: 1.5 }])).toThrow()
    expect(() =>
      parseMarchStacks([
        { unitId: 'swordsman', count: 1 } as never,
        { unitId: 'swordsman', count: 2 },
      ]),
    ).toThrow() // duplicate
    expect(() =>
      parseMarchStacks(
        Array.from({ length: MARCH.maxStacksPerMarch + 1 }, (_, i) => ({
          unitId: `u${i}`,
          count: 1,
        })),
      ),
    ).toThrow()
    expect(() =>
      parseMarchStacks([{ unitId: 'swordsman', count: MARCH.maxUnitsPerMarch + 1 }]),
    ).toThrow()
  })

  it('subtractStacks: committed − losses = survivors', () => {
    const committed = [
      { unitId: 'swordsman', count: 70 },
      { unitId: 'archer', count: 30 },
    ]
    const survivors = subtractStacks(committed, [{ unitTypeId: 'swordsman', count: 70 }])
    expect(survivors).toEqual([{ unitId: 'archer', count: 30 }])
  })

  it('subtractStacks refuses losses for uncommitted or exceeding units', () => {
    const committed = [{ unitId: 'swordsman', count: 5 }]
    expect(() => subtractStacks(committed, [{ unitTypeId: 'archer', count: 1 }])).toThrow()
    expect(() => subtractStacks(committed, [{ unitTypeId: 'swordsman', count: 6 }])).toThrow()
  })

  it('mergeStacks and totalUnits round-trip', () => {
    const a = [{ unitId: 'swordsman', count: 5 }]
    const b = [
      { unitId: 'swordsman', count: 2 },
      { unitId: 'archer', count: 3 },
    ]
    const merged = mergeStacks(a, b)
    expect(totalUnits(merged)).toBe(10)
    expect(merged).toEqual([
      { unitId: 'archer', count: 3 },
      { unitId: 'swordsman', count: 7 },
    ])
  })

  it('slowestArmySpeed picks the slowest catalog speed and refuses unknown ids', () => {
    const speeds = new Map([
      ['swordsman', 4],
      ['scout', 12],
    ])
    expect(
      slowestArmySpeed(
        [
          { unitId: 'swordsman', count: 1 },
          { unitId: 'scout', count: 2 },
        ],
        speeds,
      ),
    ).toBe(4)
    expect(() => slowestArmySpeed([{ unitId: 'ghost', count: 1 }], speeds)).toThrow()
  })

  it('readStoredStacks validates stored manifests fail-closed', () => {
    expect(readStoredStacks([{ unitId: 'swordsman', count: 5 }])).toHaveLength(1)
    expect(() => readStoredStacks([{ unitId: 'swordsman', count: 0 }])).toThrow()
    expect(() => readStoredStacks(null)).toThrow()
  })
})

// ── State machine ────────────────────────────────────────────────────────────

describe('march state machine', () => {
  it('covers exactly the MARCH_STATUSES vocabulary', () => {
    expect(Object.keys(MARCH_TRANSITIONS).sort()).toEqual([...MARCH_STATUSES].sort())
  })

  it('legal transitions pass', () => {
    expect(isMarchTransition('EN_ROUTE', 'RESOLVING')).toBe(true)
    expect(isMarchTransition('EN_ROUTE', 'CANCELLED')).toBe(true)
    expect(isMarchTransition('RESOLVING', 'RETURNING')).toBe(true)
    expect(isMarchTransition('RESOLVING', 'COMPLETED')).toBe(true)
    expect(isMarchTransition('RESOLVING', 'LOST')).toBe(true)
    expect(isMarchTransition('RETURNING', 'RESOLVING')).toBe(true)
  })

  it('every illegal transition is rejected (including STEP 27 examples)', () => {
    expect(isMarchTransition('COMPLETED', 'RETURNING')).toBe(false)
    expect(isMarchTransition('COMPLETED', 'EN_ROUTE')).toBe(false)
    expect(isMarchTransition('CANCELLED', 'RESOLVING')).toBe(false)
    expect(isMarchTransition('CANCELLED', 'EN_ROUTE')).toBe(false)
    expect(isMarchTransition('LOST', 'RETURNING')).toBe(false)
    expect(isMarchTransition('LOST', 'RESOLVING')).toBe(false)
    expect(isMarchTransition('RETURNING', 'COMPLETED')).toBe(false) // must claim RESOLVING first
    expect(isMarchTransition('RETURNING', 'CANCELLED')).toBe(false) // too late — combat may be done
    expect(isMarchTransition('EN_ROUTE', 'COMPLETED')).toBe(false)
    expect(isMarchTransition('EN_ROUTE', 'LOST')).toBe(false)
  })

  it('terminals never leave; ARRIVED is live (garrisoned detachments)', () => {
    for (const terminal of ['COMPLETED', 'CANCELLED', 'LOST'] as MarchStatus[]) {
      expect(isTerminalMarchStatus(terminal)).toBe(true)
      expect(MARCH_TRANSITIONS[terminal]).toHaveLength(0)
    }
    // Phase 34: ARRIVED is a LIVE stationed state — a delivered DEFEND/
    // REINFORCE detachment parks here until withdrawal or battle routing.
    expect(MARCH_TRANSITIONS.ARRIVED).toEqual(['RETURNING', 'LOST'])
    expect(isTerminalMarchStatus('ARRIVED')).toBe(false)
    expect(isTerminalMarchStatus('EN_ROUTE')).toBe(false)
    expect(isTerminalMarchStatus('RETURNING')).toBe(false)
  })

  it('cancellation is legal ONLY while EN_ROUTE', () => {
    expect(isCancellable('EN_ROUTE')).toBe(true)
    for (const status of MARCH_STATUSES) {
      if (status !== 'EN_ROUTE') expect(isCancellable(status)).toBe(false)
    }
  })

  it('active statuses (slot capacity) are exactly EN_ROUTE/RESOLVING/RETURNING', () => {
    // Phase 34: stationed (ARRIVED) detachments are STATIONARY — they consume
    // no march slot (bounded by garrison capacity instead).
    expect(ACTIVE_MARCH_STATUSES).toEqual(['EN_ROUTE', 'RESOLVING', 'RETURNING'])
  })

  it('client-requestable actions exclude RETURN', () => {
    const clientable = ['ATTACK', 'DEFEND', 'SCOUT', 'REINFORCE']
    for (const type of clientable) expect(MARCH_TYPES).toContain(type as never)
    expect(MARCH_TYPES).toContain('RETURN') // reserved in the union
  })
})
