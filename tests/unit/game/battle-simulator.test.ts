/**
 * Unit tests — Battle Simulator (Phase 28).
 *
 * The simulator is a PURE function: these tests prove determinism (same seed
 * + same input ⇒ identical output), the counter system, outcome resolution
 * (attacker/defender/draw/max-rounds tiebreak), casualty invariants
 * (casualties ≤ initial, survivors ≥ 0, survivors + losses = initial),
 * loot bounds (≤ carry, ≤ lootable share) and input validation.
 */

import { describe, it, expect } from 'bun:test'
import {
  simulateBattle,
  mulberry32,
  BattleInputError,
} from '../../../src/lib/game/engine/battle/simulator'
import type {
  BattleConfig,
  BattleInput,
  BattleSide,
  BattleUnitStack,
} from '../../../src/lib/game/types/battle'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONFIG: BattleConfig = {
  version: 1,
  maxRounds: 12,
  varianceBps: 1500,
  classInitiative: ['CAVALRY', 'INFANTRY', 'RANGED', 'SIEGE'],
  defenseDivisorBase: 10_000,
  counters: { maxStrongBps: 5000, maxWeakBps: 5000 },
  loot: { defenderLootableBps: 3000, minCarryToLoot: 1 },
  casualties: { defenderHospitalBps: 0, attackerDeathBps: 10_000 },
  energy: { attackCost: 10, scoutCost: 3 },
  protection: {
    newbieLevelCap: 5,
    newbieAgeHours: 48,
    maxLevelGap: 25,
    inactiveProtectDays: 7,
    maxAttacksPerTargetPerDay: 5,
    attackCooldownSec: 60,
  },
  terrainAttackBps: { PLAINS: 0, FOREST: -500, MOUNTAINS: -1000, RIVER: -750, CITY: 0 },
}

function stack(overrides: Partial<BattleUnitStack>): BattleUnitStack {
  return {
    unitTypeId: 'swordsman',
    class: 'INFANTRY',
    count: 10,
    attack: 24,
    defense: 32,
    health: 160,
    speed: 5,
    strongAgainst: { cavalry: 2500, heavy_cavalry: 2500, knight: 2500 },
    weakAgainst: { archer: -2500, crossbowman: -2500 },
    carryCapacity: 35,
    ...overrides,
  }
}

function side(overrides: Partial<BattleSide> & { stacks: BattleUnitStack[] }): BattleSide {
  return {
    playerId: 'p',
    name: 'Player',
    modifiers: { attackBps: {}, defenseBps: {}, healthBps: {}, speedBps: 0, lootBps: 0 },
    wallLevel: 0,
    hospitalBps: 0,
    ...overrides,
  }
}

function input(
  overrides: Partial<BattleInput> & { attacker: BattleSide; defender: BattleSide },
): BattleInput {
  return {
    seed: 42,
    config: CONFIG,
    context: { type: 'PVP_ATTACK', terrain: 'CITY' },
    ...overrides,
  }
}

const totalOf = (rows: Array<{ count: number }>): number =>
  rows.reduce((sum, row) => sum + row.count, 0)

// ── Determinism ──────────────────────────────────────────────────────────────

describe('battle simulator — determinism', () => {
  const armies = {
    attacker: side({
      playerId: 'attacker',
      stacks: [stack({ count: 20 })],
    }),
    defender: side({
      playerId: 'defender',
      stacks: [
        stack({
          unitTypeId: 'archer',
          class: 'RANGED',
          count: 20,
          attack: 15,
          defense: 8,
          health: 80,
        }),
      ],
    }),
  }

  it('same seed + same input ⇒ byte-identical result', () => {
    const a = simulateBattle(input({ ...armies, seed: 777 }))
    const b = simulateBattle(input({ ...armies, seed: 777 }))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('different seed ⇒ different damage trace (variance actually applies)', () => {
    const a = simulateBattle(input({ ...armies, seed: 1 }))
    const b = simulateBattle(input({ ...armies, seed: 999_999 }))
    const aDmg = a.rounds.reduce((sum, r) => sum + r.damageDealt, 0)
    const bDmg = b.rounds.reduce((sum, r) => sum + r.damageDealt, 0)
    expect(aDmg).not.toBe(bDmg)
  })

  it('mulberry32 is a stable pure sequence', () => {
    const rng1 = mulberry32(123)
    const rng2 = mulberry32(123)
    const seq1 = [rng1(), rng1(), rng1()]
    const seq2 = [rng2(), rng2(), rng2()]
    expect(seq1).toEqual(seq2)
    for (const value of seq1) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

// ── Outcomes ─────────────────────────────────────────────────────────────────

describe('battle simulator — outcomes', () => {
  it('overwhelming attacker wins and wipes the defender', () => {
    const result = simulateBattle(
      input({
        seed: 5,
        attacker: side({ playerId: 'a', stacks: [stack({ count: 100 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 2,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
        }),
      }),
    )
    expect(result.result).toBe('ATTACKER_WIN')
    expect(totalOf(result.defenderLosses)).toBe(2)
    expect(result.defenderSurvivors).toEqual([])
    expect(result.attackerSurvivors[0]?.count).toBeLessThanOrEqual(100)
  })

  it('overwhelming defender wins', () => {
    const result = simulateBattle(
      input({
        seed: 5,
        attacker: side({
          playerId: 'a',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 2,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
        }),
        defender: side({ playerId: 'd', stacks: [stack({ count: 100 })] }),
      }),
    )
    expect(result.result).toBe('DEFENDER_WIN')
    expect(totalOf(result.attackerLosses)).toBe(2)
  })

  it('zero-attack armies fight to a max-rounds DRAW with equal HP', () => {
    const pacifist = stack({ attack: 0, defense: 0, health: 100, count: 10 })
    const result = simulateBattle(
      input({
        seed: 9,
        config: { ...CONFIG, varianceBps: 0, maxRounds: 5 },
        attacker: side({ playerId: 'a', stacks: [pacifist] }),
        defender: side({ playerId: 'd', stacks: [{ ...pacifist }] }),
      }),
    )
    expect(result.result).toBe('DRAW')
    expect(result.rounds.length).toBe(10) // 2 side-records × 5 rounds
    expect(totalOf(result.attackerLosses)).toBe(0)
    expect(totalOf(result.defenderLosses)).toBe(0)
  })

  it('max rounds bound is respected — no infinite simulation', () => {
    const tank = stack({ defense: 100_000, health: 100_000, count: 50, attack: 1 })
    const result = simulateBattle(
      input({
        seed: 3,
        attacker: side({ playerId: 'a', stacks: [tank] }),
        defender: side({ playerId: 'd', stacks: [{ ...tank }] }),
      }),
    )
    expect(result.rounds.length).toBeLessThanOrEqual(CONFIG.maxRounds * 2)
  })
})

// ── Counters ─────────────────────────────────────────────────────────────────

describe('battle simulator — unit counters', () => {
  const infantryVersusCavalry = (seed: number) =>
    simulateBattle(
      input({
        seed,
        config: { ...CONFIG, varianceBps: 0 },
        attacker: side({ playerId: 'a', stacks: [stack({ count: 10 })] }), // swordsman
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'cavalry',
              class: 'CAVALRY',
              count: 10,
              attack: 28,
              defense: 18,
              health: 130,
              weakAgainst: { swordsman: -2500 },
              strongAgainst: {},
            }),
          ],
        }),
      }),
    )

  it('swordsman +2500bps edge vs cavalry deals more round-1 damage than a neutral matchup', () => {
    const withCounter = infantryVersusCavalry(11)
    const neutral = simulateBattle(
      input({
        seed: 11,
        config: { ...CONFIG, varianceBps: 0 },
        attacker: side({ playerId: 'a', stacks: [stack({ count: 10, strongAgainst: {} })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'cavalry',
              class: 'CAVALRY',
              count: 10,
              attack: 28,
              defense: 18,
              health: 130,
              weakAgainst: {},
              strongAgainst: {},
            }),
          ],
        }),
      }),
    )
    // Round 1, variance 0: 10×24×1.25 = 300 raw (+counter) vs 240 raw (neutral)
    const firstAttackerDamage = (r: typeof withCounter): bigint | number =>
      r.rounds.find((round) => round.side === 'ATTACKER')?.damageDealt ?? 0
    expect(Number(firstAttackerDamage(withCounter))).toBeGreaterThan(
      Number(firstAttackerDamage(neutral)),
    )
  })

  it('cavalry suffers the weak-against penalty into infantry (fewer kills)', () => {
    const result = infantryVersusCavalry(11)
    // Penalized cavalry: 10×28×0.75 = 210 raw → ~209 after defense → 1 kill
    // round 1; as the attacker thins the cavalry the damage falls below the
    // 160 HP kill threshold. A NEUTRAL cavalry line kills more.
    const neutral = simulateBattle(
      input({
        seed: 11,
        config: { ...CONFIG, varianceBps: 0 },
        attacker: side({ playerId: 'a', stacks: [stack({ count: 10 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'cavalry',
              class: 'CAVALRY',
              count: 10,
              attack: 28,
              defense: 18,
              health: 130,
              weakAgainst: {},
              strongAgainst: {},
            }),
          ],
        }),
      }),
    )
    const cavalryKills = totalOf(
      result.rounds.filter((r) => r.side === 'DEFENDER').flatMap((r) => r.unitsLost),
    )
    const neutralCavalryKills = totalOf(
      neutral.rounds.filter((r) => r.side === 'DEFENDER').flatMap((r) => r.unitsLost),
    )
    expect(cavalryKills).toBeLessThan(neutralCavalryKills)
    expect(cavalryKills).toBeGreaterThan(0)
  })

  it('counter multiplier is recorded on the round actions', () => {
    const result = infantryVersusCavalry(11)
    const attackerActions = result.rounds
      .filter((r) => r.side === 'ATTACKER')
      .flatMap((r) => r.actions)
    expect(attackerActions.length).toBeGreaterThan(0)
    expect(attackerActions[0]!.counterMultBps).toBe(2500)
  })
})

// ── Invariants ───────────────────────────────────────────────────────────────

describe('battle simulator — casualty & loot invariants', () => {
  it('survivors + losses = initial count on both sides', () => {
    const result = simulateBattle(
      input({
        seed: 1234,
        attacker: side({
          playerId: 'a',
          stacks: [
            stack({ count: 30 }),
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 10,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
        }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({ count: 25 }),
            stack({
              unitTypeId: 'cavalry',
              class: 'CAVALRY',
              count: 5,
              attack: 28,
              defense: 18,
              health: 130,
            }),
          ],
        }),
      }),
    )
    const check = (
      stacks: BattleUnitStack[],
      losses: Array<{ unitTypeId: string; count: number }>,
      survivors: Array<{ unitTypeId: string; count: number }>,
    ) => {
      const initial = new Map<string, number>()
      for (const s of stacks) initial.set(s.unitTypeId, (initial.get(s.unitTypeId) ?? 0) + s.count)
      const lost = new Map<string, number>()
      for (const l of losses) lost.set(l.unitTypeId, (lost.get(l.unitTypeId) ?? 0) + l.count)
      const alive = new Map<string, number>()
      for (const s of survivors) alive.set(s.unitTypeId, (alive.get(s.unitTypeId) ?? 0) + s.count)
      for (const [unitTypeId, initialCount] of initial) {
        expect((lost.get(unitTypeId) ?? 0) + (alive.get(unitTypeId) ?? 0)).toBe(initialCount)
        expect(lost.get(unitTypeId) ?? 0).toBeLessThanOrEqual(initialCount)
        expect(alive.get(unitTypeId) ?? 0).toBeGreaterThanOrEqual(0)
      }
    }
    check(
      input({ attacker: side({ stacks: [] }), defender: side({ stacks: [] }) }).attacker.stacks,
      [],
      [],
    ) // sanity: checker works on empty
    check(
      [
        stack({ count: 30 }),
        stack({
          unitTypeId: 'archer',
          class: 'RANGED',
          count: 10,
          attack: 15,
          defense: 8,
          health: 80,
        }),
      ],
      result.attackerLosses,
      result.attackerSurvivors,
    )
    check(
      [
        stack({ count: 25 }),
        stack({
          unitTypeId: 'cavalry',
          class: 'CAVALRY',
          count: 5,
          attack: 28,
          defense: 18,
          health: 130,
        }),
      ],
      result.defenderLosses,
      result.defenderSurvivors,
    )
  })

  it('loot never exceeds carry capacity nor the lootable share', () => {
    const result = simulateBattle(
      input({
        seed: 8,
        attacker: side({ playerId: 'a', stacks: [stack({ count: 5, carryCapacity: 35 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 1,
              attack: 15,
              defense: 8,
              health: 10,
            }),
          ],
        }),
        defenderBalances: { GOLD: '300', FOOD: '150' },
      }),
    )
    expect(result.result).toBe('ATTACKER_WIN')
    const carryTotal = 5 * 35
    const lootSum = Object.values(result.loot).reduce((sum, amount) => sum + amount, 0n)
    expect(lootSum).toBeLessThanOrEqual(BigInt(carryTotal))
    // 30% lootable (pool 135 ≤ carry 175) → the full share is honored
    expect(result.loot['GOLD']).toBe(90n)
    expect(result.loot['FOOD']).toBe(45n)
  })

  it('huge defender wealth is capped by the surviving carry capacity', () => {
    const result = simulateBattle(
      input({
        seed: 8,
        attacker: side({ playerId: 'a', stacks: [stack({ count: 4, carryCapacity: 35 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 1,
              attack: 15,
              defense: 8,
              health: 10,
            }),
          ],
        }),
        defenderBalances: { GOLD: '100000000' },
      }),
    )
    const lootSum = Object.values(result.loot).reduce((sum, amount) => sum + amount, 0n)
    expect(lootSum).toBeLessThanOrEqual(140n)
    expect(lootSum).toBeGreaterThan(0n)
  })

  it('hospital share returns wounded defenders home', () => {
    const result = simulateBattle(
      input({
        seed: 21,
        config: { ...CONFIG, casualties: { defenderHospitalBps: 5000, attackerDeathBps: 10_000 } },
        attacker: side({ playerId: 'a', stacks: [stack({ count: 100 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 8,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
          hospitalBps: 5000,
        }),
      }),
    )
    expect(result.result).toBe('ATTACKER_WIN')
    const totalDefenderLosses =
      totalOf(result.defenderLosses) + totalOf(result.defenderHospitalized)
    expect(totalDefenderLosses).toBe(8)
    expect(totalOf(result.defenderHospitalized)).toBeGreaterThan(0)
    expect(totalOf(result.defenderSurvivors)).toBe(totalOf(result.defenderHospitalized))
  })

  it('defeated attacker carries no loot', () => {
    const result = simulateBattle(
      input({
        seed: 8,
        attacker: side({
          playerId: 'a',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 1,
              attack: 15,
              defense: 8,
              health: 10,
            }),
          ],
        }),
        defender: side({ playerId: 'd', stacks: [stack({ count: 100 })] }),
        defenderBalances: { GOLD: '100000' },
      }),
    )
    expect(result.result).toBe('DEFENDER_WIN')
    expect(Object.keys(result.loot).length).toBe(0)
  })
})

// ── Validation ───────────────────────────────────────────────────────────────

describe('battle simulator — input validation', () => {
  it('rejects an empty attacker army', () => {
    expect(() =>
      simulateBattle(
        input({
          attacker: side({ playerId: 'a', stacks: [] }),
          defender: side({ playerId: 'd', stacks: [stack({})] }),
        }),
      ),
    ).toThrow(BattleInputError)
  })

  it('rejects a zero-count army', () => {
    expect(() =>
      simulateBattle(
        input({
          attacker: side({ playerId: 'a', stacks: [stack({ count: 0 })] }),
          defender: side({ playerId: 'd', stacks: [stack({})] }),
        }),
      ),
    ).toThrow(BattleInputError)
  })

  it('rejects negative counts and negative stats', () => {
    expect(() =>
      simulateBattle(
        input({
          attacker: side({ playerId: 'a', stacks: [stack({ count: -5 })] }),
          defender: side({ playerId: 'd', stacks: [stack({})] }),
        }),
      ),
    ).toThrow(BattleInputError)
    expect(() =>
      simulateBattle(
        input({
          attacker: side({ playerId: 'a', stacks: [stack({ attack: -1 })] }),
          defender: side({ playerId: 'd', stacks: [stack({})] }),
        }),
      ),
    ).toThrow(BattleInputError)
  })

  it('rejects a missing/invalid seed and a broken config', () => {
    const defender = side({ playerId: 'd', stacks: [stack({})] })
    const attacker = side({ playerId: 'a', stacks: [stack({})] })
    expect(() => simulateBattle(input({ attacker, defender, seed: Number.NaN }))).toThrow(
      BattleInputError,
    )
    expect(() =>
      simulateBattle(input({ attacker, defender, config: { ...CONFIG, maxRounds: 0 } })),
    ).toThrow(BattleInputError)
  })

  it('class modifiers change effective stats (BpsModifiers extension point)', () => {
    const base = simulateBattle(
      input({
        seed: 4,
        config: { ...CONFIG, varianceBps: 0 },
        attacker: side({ playerId: 'a', stacks: [stack({ count: 10 })] }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 10,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
        }),
      }),
    )
    const buffed = simulateBattle(
      input({
        seed: 4,
        config: { ...CONFIG, varianceBps: 0 },
        attacker: side({
          playerId: 'a',
          stacks: [stack({ count: 10 })],
          modifiers: {
            attackBps: { INFANTRY: 5000 },
            defenseBps: {},
            healthBps: {},
            speedBps: 0,
            lootBps: 0,
          },
        }),
        defender: side({
          playerId: 'd',
          stacks: [
            stack({
              unitTypeId: 'archer',
              class: 'RANGED',
              count: 10,
              attack: 15,
              defense: 8,
              health: 80,
            }),
          ],
        }),
      }),
    )
    const baseDmg = base.rounds
      .filter((r) => r.side === 'ATTACKER')
      .reduce((s, r) => s + r.damageDealt, 0)
    const buffedDmg = buffed.rounds
      .filter((r) => r.side === 'ATTACKER')
      .reduce((s, r) => s + r.damageDealt, 0)
    expect(buffedDmg).toBeGreaterThan(baseDmg)
  })
})
