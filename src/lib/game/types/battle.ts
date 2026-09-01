/**
 * WARLORDS — Battle Model contracts (implementation: Phase 5).
 * Design spec: docs/BATTLE_MODEL.md
 *
 * The battle engine is a PURE function:
 *   simulate(input: BattleInput): BattleSimulationResult
 * — no I/O, no Date.now, no Math.random (seeded PRNG injected).
 * Determinism guarantee: (seed, configVersion, inputs) ⇒ identical outcome.
 */

import type { BattleResult, BattleType, UnitClass } from './common'
import type { Coordinate } from './common'

// TerrainType — the full Phase 32 world terrain set. The battle config
// (terrainAttackBps) covers EVERY member; the world generator assigns only
// members of this union to territories.
export type TerrainType =
  'PLAINS' | 'FOREST' | 'MOUNTAINS' | 'DESERT' | 'SWAMP' | 'HILLS' | 'RIVER' | 'COAST' | 'CITY'

// Re-exported for engine convenience.
export type { BattleResult, BattleType, UnitClass }

// ── Modifiers (all additive basis points, aggregated BEFORE combat) ─────────

export interface BpsModifiers {
  attackBps: Partial<Record<UnitClass, number>>
  defenseBps: Partial<Record<UnitClass, number>>
  healthBps: Partial<Record<UnitClass, number>>
  speedBps: number
  lootBps: number
}

export const EMPTY_BPS: BpsModifiers = {
  attackBps: {},
  defenseBps: {},
  healthBps: {},
  speedBps: 0,
  lootBps: 0,
}

/** Add `add` into `base` (pure — returns new object). */
export function mergeBps(base: BpsModifiers, add: BpsModifiers): BpsModifiers {
  const mergeClass = (
    a: Partial<Record<UnitClass, number>>,
    b: Partial<Record<UnitClass, number>>,
  ): Partial<Record<UnitClass, number>> => {
    const out: Partial<Record<UnitClass, number>> = { ...a }
    for (const key of Object.keys(b) as UnitClass[]) {
      out[key] = (out[key] ?? 0) + (b[key] ?? 0)
    }
    return out
  }
  return {
    attackBps: mergeClass(base.attackBps, add.attackBps),
    defenseBps: mergeClass(base.defenseBps, add.defenseBps),
    healthBps: mergeClass(base.healthBps, add.healthBps),
    speedBps: base.speedBps + add.speedBps,
    lootBps: base.lootBps + add.lootBps,
  }
}

// ── Sides & stacks ───────────────────────────────────────────────────────────

export interface BattleUnitStack {
  unitTypeId: string
  class: UnitClass
  count: number
  attack: number
  defense: number
  health: number
  speed: number
  strongAgainst: Record<string, number> // unitTypeId → bonusBps (from config snapshot)
  weakAgainst: Record<string, number> // unitTypeId → penaltyBps
  carryCapacity: number
}

export interface BattleSide {
  playerId: string
  name: string
  stacks: BattleUnitStack[]
  modifiers: BpsModifiers // commander + equipment + tech + clan + morale, pre-aggregated
  wallLevel: number // 0 for attacker
  hospitalBps: number // % of casualties recoverable (defender only, config)
}

// ── Config snapshot (versioned, persisted with each battle) ─────────────────

/**
 * Config snapshot (versioned, persisted with each battle in the replay
 * payload / battle log content) — mirrors src/lib/game/config/battle.ts.
 */
export interface BattleConfig {
  version: number
  maxRounds: number
  varianceBps: number // ± damage spread
  classInitiative: UnitClass[]
  defenseDivisorBase: number
  counters: { maxStrongBps: number; maxWeakBps: number }
  loot: { defenderLootableBps: number; minCarryToLoot: number }
  casualties: { defenderHospitalBps: number; attackerDeathBps: number }
  energy: { attackCost: number; scoutCost: number }
  protection: {
    newbieLevelCap: number
    newbieAgeHours: number
    maxLevelGap: number
    inactiveProtectDays: number
    maxAttacksPerTargetPerDay: number
    attackCooldownSec: number
  }
  terrainAttackBps: Record<TerrainType, number>
}

// ── Round records (persisted into battle_rounds) ─────────────────────────────

export interface RoundAction {
  actorStackId: string
  actorUnitTypeId: string
  targetUnitTypeId: string
  damage: number
  kills: number
  counterMultBps: number
}

export interface BattleRoundRecord {
  roundNumber: number
  side: 'ATTACKER' | 'DEFENDER'
  unitsCommitted: Array<{ unitTypeId: string; count: number }>
  unitsLost: Array<{ unitTypeId: string; count: number }>
  damageDealt: number
  actions: RoundAction[]
}

// ── Result ───────────────────────────────────────────────────────────────────

/** Resources loot can be drawn from (wallet five — GEMS are never plundered). */
export type LootResource = 'GOLD' | 'WOOD' | 'IRON' | 'FOOD' | 'CRYSTAL'

export type LootAmounts = Partial<Record<LootResource, bigint>>

export interface BattleSimulationResult {
  result: BattleResult
  rounds: BattleRoundRecord[]
  attackerLosses: Array<{ unitTypeId: string; count: number }>
  defenderLosses: Array<{ unitTypeId: string; count: number }>
  attackerSurvivors: Array<{ unitTypeId: string; count: number }>
  defenderSurvivors: Array<{ unitTypeId: string; count: number }>
  defenderHospitalized: Array<{ unitTypeId: string; count: number }>
  loot: LootAmounts
  honorDelta: number
  reputationDelta: number
  attackerPower: number
  defenderPower: number
}

export interface BattleInput {
  seed: number
  config: BattleConfig
  attacker: BattleSide
  defender: BattleSide
  context: {
    type: BattleType
    terrain: TerrainType
    coordinate?: Coordinate
  }
}

/** Engine signature — implemented in Phase 5 as a pure function. */
export type BattleSimulator = (input: BattleInput) => BattleSimulationResult

// ── Replay contract ──────────────────────────────────────────────────────────

/** Persisted payload enabling byte-exact re-simulation (GET /battle/:id/replay). */
export interface BattleReplayPayload {
  seed: number
  config: BattleConfig
  attacker: BattleSide
  defender: BattleSide
  context: BattleInput['context']
}
