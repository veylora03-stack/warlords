/**
 * Unit tests — Positional Garrison pure layer (Phase 34).
 *
 * Everything here is PURE: the capacity policy, the deterministic loss
 * distribution algebra, the authorization matrix and the clan policy
 * helpers. No DB, no clock, no I/O — the invariants that must hold before
 * any transaction touches them (STEP 17 of the Phase 34 contract).
 */

import { describe, it, expect } from 'bun:test'
import {
  distributeGarrisonLosses,
  sumContributionUnits,
  resolveGarrisonAuthorization,
  type GarrisonContributionManifest,
} from '../../../src/lib/game/services/garrison.service'
import { GARRISON, garrisonCapacity } from '../../../src/lib/game/config/garrison'
import { CLAN } from '../../../src/lib/game/config/clan'
import { joinPolicyOf, roleRank } from '../../../src/lib/game/services/clan.service'
import {
  MARCH_TRANSITIONS,
  ACTIVE_MARCH_STATUSES,
} from '../../../src/lib/game/engine/march/movement'

function manifest(
  id: string,
  marchId: string,
  units: Array<[string, number]>,
): GarrisonContributionManifest {
  return {
    contributionId: id,
    marchId,
    units: units.map(([unitId, count]) => ({ unitId, count })),
  }
}

describe('garrison config', () => {
  it('capacity is deterministic and grows with strategicValue', () => {
    expect(garrisonCapacity(0)).toBe(GARRISON.capacityBase)
    expect(garrisonCapacity(1)).toBe(GARRISON.capacityBase + GARRISON.capacityPerStrategicValue)
    expect(garrisonCapacity(5)).toBe(GARRISON.capacityBase + 5 * GARRISON.capacityPerStrategicValue)
    expect(garrisonCapacity(10)).toBe(garrisonCapacity(10)) // stable
  })

  it('capacity clamps absurd strategic values instead of exploding', () => {
    expect(garrisonCapacity(-5)).toBe(garrisonCapacity(0))
    expect(garrisonCapacity(999)).toBe(garrisonCapacity(10))
    expect(garrisonCapacity(2.9)).toBe(garrisonCapacity(2))
  })

  it('maxContributionsPerTerritory bounds the defense aggregation', () => {
    expect(GARRISON.maxContributionsPerTerritory).toBeGreaterThanOrEqual(1)
    expect(GARRISON.maxContributionsPerTerritory).toBeLessThanOrEqual(100)
  })
})

describe('garrison loss distribution (deterministic casualty algebra)', () => {
  const holders = () => [
    manifest('c1', 'm1', [['swordsman', 60]]),
    manifest('c2', 'm2', [['swordsman', 40]]),
  ]

  it('distributes losses proportionally with an exact total', () => {
    const plan = distributeGarrisonLosses(holders(), [{ unitTypeId: 'swordsman', count: 30 }])
    const c1 = plan.get('c1')!.reduce((s, l) => s + l.count, 0)
    const c2 = plan.get('c2')!.reduce((s, l) => s + l.count, 0)
    expect(c1 + c2).toBe(30)
    // 60/100 and 40/100 shares of 30 → 18/12 (exact, no remainder needed)
    expect(c1).toBe(18)
    expect(c2).toBe(12)
  })

  it('assigns the integer remainder in the fixed contribution order', () => {
    // 30 loss over 3 equal holdings → 10 each; 25 over 60/40 → floor(15)=15,
    // floor(10)=10 → assigned 25 exactly; try 31 over 60/40: 18.6/12.4 →
    // floor 18 + 12 = 30, remainder 1 → first holder.
    const plan = distributeGarrisonLosses(holders(), [{ unitTypeId: 'swordsman', count: 31 }])
    const c1 = plan.get('c1')!.reduce((s, l) => s + l.count, 0)
    const c2 = plan.get('c2')!.reduce((s, l) => s + l.count, 0)
    expect(c1 + c2).toBe(31)
    expect(c1).toBe(19) // remainder went to the OLDEST contribution
    expect(c2).toBe(12)
  })

  it('wipes every holder in full when the whole type is lost', () => {
    const plan = distributeGarrisonLosses(holders(), [{ unitTypeId: 'swordsman', count: 100 }])
    expect(plan.get('c1')![0]!.count).toBe(60)
    expect(plan.get('c2')![0]!.count).toBe(40)
  })

  it('never assigns losses for unit types a contribution does not hold', () => {
    const plan = distributeGarrisonLosses(
      [manifest('c1', 'm1', [['swordsman', 10]]), manifest('c2', 'm2', [['archer', 10]])],
      [{ unitTypeId: 'swordsman', count: 4 }],
    )
    expect(plan.get('c2')).toEqual([])
  })

  it('is a no-op for zero losses', () => {
    const plan = distributeGarrisonLosses(holders(), [{ unitTypeId: 'swordsman', count: 0 }])
    expect(plan.get('c1')).toEqual([])
    expect(plan.get('c2')).toEqual([])
  })

  it('FAILS CLOSED when losses exceed the garrison holdings (invariant guard)', () => {
    expect(() =>
      distributeGarrisonLosses(holders(), [{ unitTypeId: 'swordsman', count: 101 }]),
    ).toThrow(/invariant violated/i)
  })

  it('is deterministic: the same inputs always produce the same plan', () => {
    const a = distributeGarrisonLosses(holders(), [
      { unitTypeId: 'swordsman', count: 37 },
      { unitTypeId: 'archer', count: 0 },
    ])
    const b = distributeGarrisonLosses(holders(), [
      { unitTypeId: 'swordsman', count: 37 },
      { unitTypeId: 'archer', count: 0 },
    ])
    expect(JSON.stringify([...a.entries()])).toBe(JSON.stringify([...b.entries()]))
  })

  it('sumContributionUnits merges multi-contribution manifests exactly', () => {
    const totals = sumContributionUnits([
      [{ unitId: 'swordsman', count: 30 }],
      [
        { unitId: 'swordsman', count: 20 },
        { unitId: 'archer', count: 5 },
      ],
    ])
    expect(totals).toEqual([
      { unitId: 'archer', count: 5 },
      { unitId: 'swordsman', count: 50 },
    ])
  })
})

describe('garrison authorization matrix (STEP 14 — the ONLY authority)', () => {
  const base = { playerId: 'p1', playerClanId: null as string | null }

  it('owner can DEFEND their own territory', () => {
    expect(
      resolveGarrisonAuthorization({
        ...base,
        type: 'DEFEND',
        territoryOwnerPlayerId: 'p1',
        territoryOwnerClanId: null,
      }),
    ).toEqual({ authorized: true })
  })

  it('a foreign player can NEVER defend someone else’s territory', () => {
    expect(
      resolveGarrisonAuthorization({
        ...base,
        type: 'DEFEND',
        territoryOwnerPlayerId: 'p2',
        territoryOwnerClanId: null,
      }).authorized,
    ).toBe(false)
    expect(
      resolveGarrisonAuthorization({
        ...base,
        playerClanId: 'clan1',
        type: 'DEFEND',
        territoryOwnerPlayerId: 'p2',
        territoryOwnerClanId: 'clan1', // even SAME clan cannot DEFEND foreign soil
        territoryOwnerPlayerId: 'p2',
      }).authorized,
    ).toBe(false)
  })

  it('REINFORCE requires the owner OR a same-clan comrade of the owner', () => {
    expect(
      resolveGarrisonAuthorization({
        ...base,
        type: 'REINFORCE',
        territoryOwnerPlayerId: 'p1',
        territoryOwnerClanId: null,
      }).authorized,
    ).toBe(true)
    expect(
      resolveGarrisonAuthorization({
        ...base,
        playerClanId: 'clan1',
        type: 'REINFORCE',
        territoryOwnerPlayerId: 'p2',
        territoryOwnerClanId: 'clan1',
      }).authorized,
    ).toBe(true)
    expect(
      resolveGarrisonAuthorization({
        ...base,
        playerClanId: 'clan1',
        type: 'REINFORCE',
        territoryOwnerPlayerId: 'p2',
        territoryOwnerClanId: 'clan2',
      }).authorized,
    ).toBe(false)
    expect(
      resolveGarrisonAuthorization({
        ...base,
        playerClanId: null,
        type: 'REINFORCE',
        territoryOwnerPlayerId: 'p2',
        territoryOwnerClanId: 'clan1',
      }).authorized,
    ).toBe(false)
  })

  it('no authorization ever exists on unclaimed soil', () => {
    for (const type of ['DEFEND', 'REINFORCE'] as const) {
      expect(
        resolveGarrisonAuthorization({
          ...base,
          type,
          territoryOwnerPlayerId: null,
          territoryOwnerClanId: null,
        }).authorized,
      ).toBe(false)
    }
  })
})

describe('clan policy helpers', () => {
  it('joinPolicyOf falls back to the default on corrupt settings', () => {
    expect(joinPolicyOf({ joinPolicy: 'INVITE_ONLY' })).toBe('INVITE_ONLY')
    expect(joinPolicyOf({ joinPolicy: 'HACKED' })).toBe(CLAN.defaultJoinPolicy)
    expect(joinPolicyOf(null)).toBe(CLAN.defaultJoinPolicy)
    expect(joinPolicyOf('nonsense')).toBe(CLAN.defaultJoinPolicy)
    expect(joinPolicyOf([1, 2])).toBe(CLAN.defaultJoinPolicy)
  })

  it('role ranks are strictly ordered and fail closed', () => {
    expect(roleRank('LEADER')).toBeGreaterThan(roleRank('OFFICER'))
    expect(roleRank('OFFICER')).toBeGreaterThan(roleRank('MEMBER'))
    expect(roleRank('USURPER')).toBe(0)
  })
})

describe('march state machine Phase 34 extension', () => {
  it('ARRIVED is a live stationed state with exactly two exits', () => {
    expect(MARCH_TRANSITIONS.ARRIVED).toEqual(['RETURNING', 'LOST'])
  })

  it('stationed detachments consume no march slot', () => {
    expect(ACTIVE_MARCH_STATUSES).not.toContain('ARRIVED')
  })
})
