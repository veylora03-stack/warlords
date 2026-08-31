/**
 * WARLORDS — Battle configuration (Phase 28: Battle Engine).
 *
 * The ONLY place combat balance/policy numbers live (ARCHITECTURE.md rule).
 * Engines and services read this config; rebalancing never touches logic.
 * The version is snapshotted onto every Battle row (battles.configVersion),
 * so a balance patch can never retroactively corrupt a historical battle or
 * its replay.
 *
 * Numeric policy: bonuses are BASIS POINTS (10_000 bps = 100%); damage math
 * uses integers/floats only inside the pure simulator; loot math is BigInt.
 * Everything here is data-driven — the counter EDGES live per unit in
 * config/units.ts (strongAgainst/weakAgainst), the class weights and caps
 * live HERE.
 */

import type { UnitClass } from '@/lib/game/types/common'
import type { TerrainType } from '@/lib/game/types/battle'

/**
 * Battle engine configuration — versioned as a whole. Bump `version` whenever
 * ANY value below changes: the old snapshot stays on existing battles.
 */
export const BATTLE = {
  /** Snapshot version persisted on every battle row (replay fidelity). */
  version: 1,

  /** Hard cap on simulation rounds — prevents infinite engagements. */
  maxRounds: 12,

  /** ± damage spread in bps (1500 → damage × [0.85, 1.15), seeded PRNG). */
  varianceBps: 1500,

  /** Class initiative order — earlier classes strike first every round. */
  classInitiative: ['CAVALRY', 'INFANTRY', 'RANGED', 'SIEGE'] as UnitClass[],

  /**
   * Defense divisor: incoming damage is scaled by
   * `defenseDivisorBase / (defenseDivisorBase + targetEffectiveDefense)`.
   * Raise to make defense matter more; 0 would disable defense entirely.
   */
  defenseDivisorBase: 10_000,

  /** Counter bonuses come from the per-unit catalog; these cap the EDGE. */
  counters: {
    /** Max strong-against bonus honored (bps) — catalog values are clamped. */
    maxStrongBps: 5000,
    /** Max weak-against penalty honored (bps) — catalog values are clamped. */
    maxWeakBps: 5000,
  },

  /** Loot policy (attacker victory). All wallet resources, never GEMS. */
  loot: {
    /** Share (bps) of EACH defender wallet balance that is lootable. */
    defenderLootableBps: 3000,
    /**
     * The attacker's surviving carry capacity caps the TOTAL loot; when the
     * lootable pool exceeds it, every resource is scaled down proportionally
     * (integer math — see simulator).
     */
    minCarryToLoot: 1,
  },

  /** Casualty policy. */
  casualties: {
    /**
     * Share (bps) of DEFENDER losses that return home wounded instead of
     * dying. The standalone hospital pool is a future system — for now
     * hospitalized troops simply survive at home, so 0 keeps every loss
     * permanent and any value above it is an explicit policy choice.
     */
    defenderHospitalBps: 0,
    /** Attacker losses are always permanent (10_000 bps = 100%). */
    attackerDeathBps: 10_000,
  },

  /** Energy cost per action (deducted through the lazy-tick energy pool). */
  energy: {
    attackCost: 10,
    /** Scout actions are a later phase — reserved in the same scale. */
    scoutCost: 3,
  },

  /** Attack cooldown (server clock is the ONLY authority). */
  cooldown: {
    /** Minimum seconds between two attacks launched by the same player. */
    attackCooldownSec: 60,
  },

  /** Attack-request idempotency (double-click / retry protection). */
  idempotency: {
    /** How long an attack idempotency key stays replayable. */
    ttlSeconds: 86_400,
    /** Key length bound (client supplies the key; the server owns semantics). */
    keyMaxLength: 64,
  },

  /**
   * Anti-bullying protection (all evaluated SERVER-SIDE against real rows;
   * every rule is documented in docs/BATTLE-ENGINE.md §Protection).
   */
  protection: {
    /** Targets below this level are protected (newbie shield). */
    newbieLevelCap: 5,
    /** Targets younger than this are protected (hours, account age). */
    newbieAgeHours: 48,
    /** Level gap: |attacker.level − target.level| above this → protected. */
    maxLevelGap: 25,
    /** Targets inactive this many days (no login) are shielded. */
    inactiveProtectDays: 7,
    /** Max attacks by the same attacker onto the SAME target per rolling 24h. */
    maxAttacksPerTargetPerDay: 5,
  },

  /**
   * Terrain modifiers for the ATTACKER (bps; 0 = neutral). PVP city raids
   * always resolve on CITY terrain today; the table is the extension point
   * for the territory/world map phase.
   */
  terrainAttackBps: {
    PLAINS: 0,
    FOREST: -500,
    MOUNTAINS: -1000,
    RIVER: -750,
    CITY: 0,
  } as Record<TerrainType, number>,

  /** Wall defense bonus comes from the REAL Wall level (config/buildings.ts). */
  wall: {
    /** Building type read for the defender wall bonus. */
    buildingType: 'WALL' as const,
    /** The WALL effect is stored as `10_000 + 600 × (level−1)` bps. */
    neutralBps: 10_000,
  },

  /** Reward policy (server-computed; never client-supplied). */
  rewards: {
    /** Honor (BigInt on Player) — no negative deltas: defeats never destroy. */
    attackWinHonor: 25,
    defenseWinHonor: 15,
    drawHonor: 0,
    /** XP granted through progression.grantXp (CAS + level-up events). */
    attackWinXp: 40,
    attackParticipationXp: 10,
    defenseWinXp: 25,
    defenseParticipationXp: 5,
    /** Season points awarded to the victor when a season is ACTIVE. */
    victorySeasonPoints: 15,
  },
} as const

export type BattlePolicy = typeof BATTLE

/** Invariants — a broken config must fail fast at first import. */
;((): void => {
  const problems: string[] = []
  if (!Number.isInteger(BATTLE.version) || BATTLE.version < 1)
    problems.push('version must be a positive integer')
  if (!Number.isInteger(BATTLE.maxRounds) || BATTLE.maxRounds < 1 || BATTLE.maxRounds > 100)
    problems.push('maxRounds must be within 1..100')
  if (BATTLE.varianceBps < 0 || BATTLE.varianceBps > 5000)
    problems.push('varianceBps must be within 0..5000')
  if (BATTLE.defenseDivisorBase <= 0) problems.push('defenseDivisorBase must be positive')
  if (BATTLE.classInitiative.length !== 4)
    problems.push('classInitiative must cover exactly the four unit classes')
  if (new Set(BATTLE.classInitiative).size !== 4)
    problems.push('classInitiative must not repeat classes')
  for (const key of ['maxStrongBps', 'maxWeakBps'] as const) {
    if (BATTLE.counters[key] < 0) problems.push(`counters.${key} must be non-negative`)
  }
  if (BATTLE.loot.defenderLootableBps < 0 || BATTLE.loot.defenderLootableBps > 10_000)
    problems.push('loot.defenderLootableBps must be within 0..10000')
  if (BATTLE.casualties.defenderHospitalBps < 0 || BATTLE.casualties.defenderHospitalBps > 10_000)
    problems.push('casualties.defenderHospitalBps must be within 0..10000')
  if (BATTLE.casualties.attackerDeathBps !== 10_000)
    problems.push('casualties.attackerDeathBps is fixed at 10000 (attacker losses are permanent)')
  if (BATTLE.energy.attackCost < 0 || BATTLE.energy.scoutCost < 0)
    problems.push('energy costs must be non-negative')
  if (BATTLE.cooldown.attackCooldownSec < 0) problems.push('cooldown must be non-negative')
  if (!Number.isInteger(BATTLE.idempotency.ttlSeconds) || BATTLE.idempotency.ttlSeconds < 60)
    problems.push('idempotency.ttlSeconds must be an integer >= 60')
  if (!Number.isInteger(BATTLE.idempotency.keyMaxLength) || BATTLE.idempotency.keyMaxLength < 8)
    problems.push('idempotency.keyMaxLength must be an integer >= 8')
  if (BATTLE.protection.newbieLevelCap < 0) problems.push('protection.newbieLevelCap >= 0')
  if (BATTLE.protection.newbieAgeHours < 0) problems.push('protection.newbieAgeHours >= 0')
  if (BATTLE.protection.maxLevelGap < 0) problems.push('protection.maxLevelGap >= 0')
  if (BATTLE.protection.inactiveProtectDays < 0) problems.push('inactiveProtectDays >= 0')
  if (BATTLE.protection.maxAttacksPerTargetPerDay < 1)
    problems.push('maxAttacksPerTargetPerDay must be >= 1')
  for (const [terrain, bps] of Object.entries(BATTLE.terrainAttackBps)) {
    if (bps < -10_000 || bps > 10_000) problems.push(`terrainAttackBps.${terrain} out of range`)
  }
  for (const [key, value] of Object.entries(BATTLE.rewards)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      problems.push(`rewards.${key} must be a non-negative integer`)
  }
  if (problems.length > 0) throw new Error(`Invalid BATTLE config: ${problems.join('; ')}`)
})()
