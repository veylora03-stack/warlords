/**
 * WARLORDS — Battle Simulator (Phase 28: Battle Engine).
 *
 * A PURE function: simulateBattle(input) → result. No I/O, no Date.now,
 * no Math.random — the ONLY randomness is the seeded PRNG derived from
 * `input.seed`, so (seed, config, attacker, defender, context) ⇒ byte-identical
 * outcome. This is what makes battles replayable, auditable, debuggable and
 * testable: the DB snapshot stored on the battle row re-simulates exactly.
 *
 * The simulator NEVER touches the database. The battle service loads real
 * state, builds BattleInput, runs this function, and applies the returned
 * result inside its transaction.
 *
 * Model (docs/BATTLE-ENGINE.md §Formula):
 *   effective stats   eff = base × (1 + sideModifierBps[class] / 10_000)
 *   incoming damage   raw = count × effAttack × counterMult × variance
 *   after defense     dmg = raw × defenseDivisorBase / (base + effDefense)
 *   kills             min(alive, floor(dmg / effHealth))
 *   initiative        config order (CAVALRY → INFANTRY → RANGED → SIEGE);
 *                     within a round the ATTACKER side acts first
 *   targeting         counter target if any (actor's strongAgainst ∩ alive),
 *                     else lowest remaining total HP, else stack order —
 *                     fully deterministic, no PRNG in targeting
 *   end               side wiped → other wins; maxRounds reached → the side
 *                     with strictly more remaining effective HP wins, else DRAW
 */

import type {
  BattleInput,
  BattleRoundRecord,
  BattleSimulationResult,
  BattleUnitStack,
  RoundAction,
} from '@/lib/game/types/battle'
import type { BattleResult, UnitClass } from '@/lib/game/types/common'

// ── Seeded PRNG (mulberry32 — tiny, fast, fully deterministic) ───────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Internal runtime state ───────────────────────────────────────────────────

interface RuntimeStack {
  stackId: string
  unitTypeId: string
  class: UnitClass
  /** Alive unit count (mutated as casualties land). */
  count: number
  initialCount: number
  effAttack: number
  effDefense: number
  effHealth: number
  strongAgainst: Record<string, number>
  weakAgainst: Record<string, number>
  carryCapacity: number
}

interface RuntimeSide {
  playerId: string
  name: string
  stacks: RuntimeStack[]
  hospitalBps: number
}

/** Extended input: the simulator also accepts defender balances for loot math. */
export interface SimulatorInput extends BattleInput {
  /** Defender wallet balances (BigInt-able) — loot is drawn from these. */
  defenderBalances?: Record<string, string | number | bigint>
}

// ── Validation ───────────────────────────────────────────────────────────────

export class BattleInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BattleInputError'
  }
}

function buildSide(side: BattleInput['attacker'], role: 'ATTACKER' | 'DEFENDER'): RuntimeSide {
  if (!side || typeof side !== 'object') {
    throw new BattleInputError(`${role} side is missing`)
  }
  if (!Array.isArray(side.stacks) || side.stacks.length === 0) {
    throw new BattleInputError(`${role} side has no stacks`)
  }
  const stacks: RuntimeStack[] = side.stacks.map((stack: BattleUnitStack, index: number) => {
    if (!stack || typeof stack !== 'object') {
      throw new BattleInputError(`${role} stack #${index} is malformed`)
    }
    for (const field of ['attack', 'defense', 'health'] as const) {
      if (!Number.isFinite(stack[field]) || stack[field] < 0) {
        throw new BattleInputError(`${role} stack #${index} has invalid ${field}`)
      }
    }
    if (!Number.isInteger(stack.count) || stack.count < 0) {
      throw new BattleInputError(`${role} stack #${index} count must be a non-negative integer`)
    }
    if (!stack.unitTypeId || typeof stack.unitTypeId !== 'string') {
      throw new BattleInputError(`${role} stack #${index} has no unitTypeId`)
    }
    const classValue = stack.class as UnitClass
    const atkMod = side.modifiers?.attackBps?.[classValue] ?? 0
    const defMod = side.modifiers?.defenseBps?.[classValue] ?? 0
    const hpMod = side.modifiers?.healthBps?.[classValue] ?? 0
    return {
      stackId: `${role === 'ATTACKER' ? 'A' : 'D'}${index}`,
      unitTypeId: stack.unitTypeId,
      class: classValue,
      count: stack.count,
      initialCount: stack.count,
      effAttack: stack.attack * (1 + atkMod / 10_000),
      effDefense: stack.defense * (1 + defMod / 10_000),
      effHealth: stack.health * (1 + hpMod / 10_000),
      strongAgainst: stack.strongAgainst ?? {},
      weakAgainst: stack.weakAgainst ?? {},
      carryCapacity: stack.carryCapacity ?? 0,
    }
  })
  return {
    playerId: side.playerId,
    name: side.name,
    stacks,
    hospitalBps: side.hospitalBps ?? 0,
  }
}

function aliveStacks(side: RuntimeSide): RuntimeStack[] {
  return side.stacks.filter((s) => s.count > 0)
}

function totalEffectiveHp(side: RuntimeSide): number {
  let total = 0
  for (const stack of side.stacks) total += stack.count * stack.effHealth
  return total
}

/** Deterministic target choice: counter → lowest total HP → stack order. */
function pickTarget(actor: RuntimeStack, enemy: RuntimeSide): RuntimeStack | null {
  const alive = aliveStacks(enemy)
  if (alive.length === 0) return null

  for (const stack of alive) {
    const bonus = actor.strongAgainst[stack.unitTypeId]
    if (bonus !== undefined && bonus > 0) return stack
  }
  let best = alive[0]!
  for (const stack of alive) {
    const bestHp = best.count * best.effHealth
    const stackHp = stack.count * stack.effHealth
    if (stackHp < bestHp) best = stack
  }
  return best
}

function counterMultiplierBps(
  actor: RuntimeStack,
  target: RuntimeStack,
  config: BattleInput['config'],
): number {
  // strongAgainst holds positive bonuses; weakAgainst holds NEGATIVE penalties
  // (the catalog's penaltyBps is negated when the stack is built) — the sum
  // is the net counter edge, clamped to the configured maximums.
  const strong = Math.min(actor.strongAgainst[target.unitTypeId] ?? 0, config.counters.maxStrongBps)
  const weak = Math.max(actor.weakAgainst[target.unitTypeId] ?? 0, -config.counters.maxWeakBps)
  return strong + weak
}

// ── The simulation ───────────────────────────────────────────────────────────

export function simulateBattle(input: SimulatorInput): BattleSimulationResult {
  if (!input || typeof input !== 'object') throw new BattleInputError('BattleInput is missing')
  if (!Number.isFinite(input.seed) || input.seed < 0) {
    throw new BattleInputError('seed must be a non-negative finite number')
  }
  const config = input.config
  if (!config || typeof config !== 'object') throw new BattleInputError('config is missing')
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 1) {
    throw new BattleInputError('config.maxRounds must be a positive integer')
  }
  const rng = mulberry32(input.seed)

  const attacker = buildSide(input.attacker, 'ATTACKER')
  const defender = buildSide(input.defender, 'DEFENDER')
  if (totalEffectiveHp(attacker) <= 0) throw new BattleInputError('attacker army is empty')
  if (totalEffectiveHp(defender) <= 0) throw new BattleInputError('defender army is empty')

  const terrainBps = config.terrainAttackBps?.[input.context.terrain] ?? 0
  const initiative: UnitClass[] = config.classInitiative
  const classRank = new Map<UnitClass, number>(initiative.map((c, i) => [c, i]))
  const byInitiative = (a: RuntimeStack, b: RuntimeStack): number =>
    (classRank.get(a.class) ?? initiative.length) - (classRank.get(b.class) ?? initiative.length)

  const rounds: BattleRoundRecord[] = []
  let result: BattleResult | null = null

  for (let roundNumber = 1; roundNumber <= config.maxRounds && result === null; roundNumber++) {
    const turnPlan: Array<{
      actorSide: RuntimeSide
      targetSide: RuntimeSide
      role: 'ATTACKER' | 'DEFENDER'
    }> = [
      { actorSide: attacker, targetSide: defender, role: 'ATTACKER' },
      { actorSide: defender, targetSide: attacker, role: 'DEFENDER' },
    ]

    // Per-round accumulators keyed by the OWNING side: each side's row records
    // the damage it dealt, the stacks it committed, and the casualties it
    // SUFFERED (landed by the opponent's turn) — the natural battle-report
    // reading, fully auditable.
    const roundActions: Record<'ATTACKER' | 'DEFENDER', RoundAction[]> = {
      ATTACKER: [],
      DEFENDER: [],
    }
    const roundDamage: Record<'ATTACKER' | 'DEFENDER', number> = { ATTACKER: 0, DEFENDER: 0 }
    const lossesByOwner: Record<'ATTACKER' | 'DEFENDER', Map<string, number>> = {
      ATTACKER: new Map(),
      DEFENDER: new Map(),
    }
    const committedSnapshot = {
      ATTACKER: aliveStacks(attacker).map((s) => ({ unitTypeId: s.unitTypeId, count: s.count })),
      DEFENDER: aliveStacks(defender).map((s) => ({ unitTypeId: s.unitTypeId, count: s.count })),
    }
    const turnsRun: Array<'ATTACKER' | 'DEFENDER'> = []

    for (const turn of turnPlan) {
      if (result !== null) break
      turnsRun.push(turn.role)

      for (const actor of [...aliveStacks(turn.actorSide)].sort(byInitiative)) {
        if (actor.count <= 0) continue // wiped earlier in this same turn
        const target = pickTarget(actor, turn.targetSide)
        if (!target) break

        const counterBps = counterMultiplierBps(actor, target, config)
        const counterMult = 1 + counterBps / 10_000
        const varianceBps = config.varianceBps
        const varianceFactor = (10_000 - varianceBps + Math.floor(rng() * 2 * varianceBps)) / 10_000
        const rawDamage =
          actor.count * actor.effAttack * counterMult * varianceFactor * (1 + terrainBps / 10_000)
        const damage = Math.max(
          0,
          Math.floor(
            (rawDamage * config.defenseDivisorBase) /
              (config.defenseDivisorBase + target.effDefense),
          ),
        )
        const kills = Math.min(target.count, Math.floor(damage / Math.max(1, target.effHealth)))

        target.count -= kills
        roundDamage[turn.role] += damage
        const owner: 'ATTACKER' | 'DEFENDER' = turn.role === 'ATTACKER' ? 'DEFENDER' : 'ATTACKER'
        lossesByOwner[owner].set(
          target.stackId,
          (lossesByOwner[owner].get(target.stackId) ?? 0) + kills,
        )

        roundActions[turn.role].push({
          actorStackId: actor.stackId,
          actorUnitTypeId: actor.unitTypeId,
          targetUnitTypeId: target.unitTypeId,
          damage,
          kills,
          counterMultBps: counterBps,
        })
      }

      if (aliveStacks(turn.targetSide).length === 0) {
        result = turn.role === 'ATTACKER' ? 'ATTACKER_WIN' : 'DEFENDER_WIN'
      }
    }

    const resolveLosses = (
      owner: RuntimeSide,
      lost: Map<string, number>,
    ): Array<{ unitTypeId: string; count: number }> =>
      [...lost.entries()]
        .filter(([, count]) => count > 0)
        .map(([stackId, count]) => ({
          unitTypeId: owner.stacks.find((s) => s.stackId === stackId)?.unitTypeId ?? stackId,
          count,
        }))

    if (turnsRun.includes('ATTACKER')) {
      rounds.push({
        roundNumber,
        side: 'ATTACKER',
        unitsCommitted: committedSnapshot['ATTACKER'],
        unitsLost: resolveLosses(attacker, lossesByOwner['ATTACKER']),
        damageDealt: roundDamage['ATTACKER'],
        actions: roundActions['ATTACKER'],
      })
    }
    if (turnsRun.includes('DEFENDER')) {
      rounds.push({
        roundNumber,
        side: 'DEFENDER',
        unitsCommitted: committedSnapshot['DEFENDER'],
        unitsLost: resolveLosses(defender, lossesByOwner['DEFENDER']),
        damageDealt: roundDamage['DEFENDER'],
        actions: roundActions['DEFENDER'],
      })
    }
  }

  if (result === null) {
    // Max rounds reached — resolve by remaining effective HP (config tiebreak).
    const attackerHp = totalEffectiveHp(attacker)
    const defenderHp = totalEffectiveHp(defender)
    result =
      attackerHp > defenderHp ? 'ATTACKER_WIN' : defenderHp > attackerHp ? 'DEFENDER_WIN' : 'DRAW'
  }

  // ── Casualties & survivors ────────────────────────────────────────────────
  const toLosses = (side: RuntimeSide): Array<{ unitTypeId: string; count: number }> =>
    side.stacks
      .filter((s) => s.count < s.initialCount)
      .map((s) => ({ unitTypeId: s.unitTypeId, count: s.initialCount - s.count }))

  const attackerLosses = toLosses(attacker)
  const defenderTotalLosses = toLosses(defender)

  // Hospital: a policy share of DEFENDER losses returns home (no standalone
  // hospital pool yet — hospitalized troops simply survive; see config).
  const defenderHospitalized = defenderTotalLosses
    .map((loss) => ({
      unitTypeId: loss.unitTypeId,
      count: Math.min(loss.count, Math.floor((loss.count * defender.hospitalBps) / 10_000)),
    }))
    .filter((entry) => entry.count > 0)
  const hospitalizedByUnit = new Map(defenderHospitalized.map((e) => [e.unitTypeId, e.count]))
  const defenderLosses = defenderTotalLosses.map((loss) => ({
    unitTypeId: loss.unitTypeId,
    count: loss.count - (hospitalizedByUnit.get(loss.unitTypeId) ?? 0),
  }))

  const survivorsOf = (side: RuntimeSide, extra: Map<string, number>) =>
    side.stacks
      .filter((s) => s.count + (extra.get(s.unitTypeId) ?? 0) > 0)
      .map((s) => ({ unitTypeId: s.unitTypeId, count: s.count + (extra.get(s.unitTypeId) ?? 0) }))

  const attackerSurvivors = survivorsOf(attacker, new Map())
  const defenderSurvivors = survivorsOf(defender, hospitalizedByUnit)

  // ── Loot (attacker victory only) — BigInt, carry-capped, balance-safe ─────
  const loot: BattleSimulationResult['loot'] = {}
  if (result === 'ATTACKER_WIN' && input.defenderBalances) {
    const lootableBps = config.loot.defenderLootableBps
    const carry = attackerSurvivors.reduce((sum, survivor) => {
      const stack = attacker.stacks.find((s) => s.unitTypeId === survivor.unitTypeId)
      return sum + BigInt(Math.max(0, stack?.carryCapacity ?? 0)) * BigInt(survivor.count)
    }, 0n)

    const lootable = new Map<string, bigint>()
    let poolTotal = 0n
    for (const [resource, rawBalance] of Object.entries(input.defenderBalances)) {
      const balance = BigInt(rawBalance)
      const share = (balance * BigInt(lootableBps)) / 10_000n
      if (share > 0n) {
        lootable.set(resource, share)
        poolTotal += share
      }
    }

    if (poolTotal > 0n && carry >= BigInt(config.loot.minCarryToLoot)) {
      // Full share when the pool fits in the carry, else a proportional cut.
      // Direct BigInt ratio (no intermediate bps) keeps small-loot cases exact;
      // Σ floor(shareᵢ × carry / pool) ≤ carry holds because floors sum under
      // the exact ratio.
      for (const [resource, share] of lootable) {
        const amount = poolTotal <= carry ? share : (share * carry) / poolTotal
        if (amount > 0n) loot[resource as keyof typeof loot] = amount
      }
    }
  }

  // ── Side powers (initial effective pools — the engagement's scale) ────────
  const sidePower = (side: RuntimeSide): number =>
    side.stacks.reduce(
      (sum, s) => sum + s.initialCount * (s.effAttack + s.effDefense + s.effHealth),
      0,
    )

  return {
    result,
    rounds,
    attackerLosses,
    defenderLosses,
    attackerSurvivors,
    defenderSurvivors,
    defenderHospitalized,
    loot,
    honorDelta: 0, // rewards are a service/policy concern, not simulation
    reputationDelta: 0,
    attackerPower: Math.round(sidePower(attacker)),
    defenderPower: Math.round(sidePower(defender)),
  }
}
