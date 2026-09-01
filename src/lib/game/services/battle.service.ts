/**
 * WARLORDS — Battle service (Phase 28: Battle Engine).
 *
 * THE single server-side write path for PvP combat. The client supplies ONLY
 * a target player id (and an optional idempotency key) — every other number
 * (armies, modifiers, seed, casualties, loot, honor, XP, season points,
 * cooldown, protection) is resolved from server state and the data-driven
 * battle config (NEVER TRUST THE CLIENT).
 *
 * Pipeline (docs/BATTLE-ENGINE.md §Flow):
 *
 *   request → idempotency fast-path → runBattleTransaction:
 *     validate target / season / cooldown / protection
 *     → sync + spend energy (CAS)
 *     → load BOTH armies + wall (real rows, under the global write lock)
 *     → build BattleInput (seed = crypto.randomInt, config snapshot)
 *     → simulateBattle(input)   ← PURE, deterministic, replayable
 *     → apply: battle row · rounds · unit CAS decrements · ledger loot
 *              honor · XP (grantXp) · season points · statistics
 *              power recalculation · battle logs · outbox notifications
 *     → idempotency claim (same tx)
 *   → response
 *
 * Concurrency: battles run behind the dedicated `battle:engine` mutex and the
 * process-wide `db:write` mutex — the SAME barrier every other game mutation
 * uses. A battle therefore cannot interleave with training, construction or
 * another battle; a second attack on the same defender sees post-first-battle
 * state; unit decrements are additionally CAS-guarded (`count >= loss`), so
 * counts can never go negative even if a lock were bypassed. Lock order is
 * battle:engine → db:write everywhere; nothing else takes battle:engine, so
 * the composition is deadlock-free.
 *
 * Idempotency: a client-supplied key is claimed in the SAME transaction as
 * the battle (IdempotencyKey table, action BATTLE_ATTACK, 24h TTL). A replay
 * returns the ORIGINAL response — a double-click can never create two
 * battles, and a cooldown additionally rate-limits the second fire.
 */

import { Prisma } from '@prisma/client'
import { createHash, randomInt } from 'node:crypto'
import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import type { Tx } from './player-bootstrap.service'
import { BATTLE } from '@/lib/game/config/battle'
import { effectsFor } from '@/lib/game/config/buildings'
import { getWalletBalances, grantResources, spendResources } from './economy.service'
import type { EconomyResource } from '@/lib/game/config/economy'
import { syncPlayerEnergy } from './energy.service'
import { recalculatePlayerPower } from './power.service'
import { grantXp } from './progression.service'
import { awardSeasonPointsInTx, resolveSeasonStateInTx } from './season.service'
import { recordPlayerStats } from './stats.service'
import { applyQuestEventInTx } from './quest-events.service'
import { evaluateAchievementsInTx } from './achievement.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import { simulateBattle } from '@/lib/game/engine/battle/simulator'
import type {
  BattleConfig,
  BattleSimulationResult,
  BattleSide,
  BattleUnitStack,
  BpsModifiers,
  LootAmounts,
  LootResource,
} from '@/lib/game/types/battle'
import { EMPTY_BPS } from '@/lib/game/types/battle'
import type { BattleResult } from '@/lib/game/types/common'

const log = logger.child({ module: 'game/battle' })

type ReadClient = Tx | typeof db

/** Process-wide battle serialization key (see module docblock). */
export const BATTLE_ENGINE_LOCK = 'battle:engine'

/** Economy transaction bounds reuse — battles share the interactive-tx budget. */
const BATTLE_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

const LOOT_RESOURCES: LootResource[] = ['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL']

const IDEMPOTENCY_ACTION = 'BATTLE_ATTACK'

// ── Config snapshot ──────────────────────────────────────────────────────────

/** The exact snapshot persisted with each battle (replay fidelity). */
export function battleConfigSnapshot(): BattleConfig {
  return {
    version: BATTLE.version,
    maxRounds: BATTLE.maxRounds,
    varianceBps: BATTLE.varianceBps,
    classInitiative: [...BATTLE.classInitiative],
    defenseDivisorBase: BATTLE.defenseDivisorBase,
    counters: {
      maxStrongBps: BATTLE.counters.maxStrongBps,
      maxWeakBps: BATTLE.counters.maxWeakBps,
    },
    loot: {
      defenderLootableBps: BATTLE.loot.defenderLootableBps,
      minCarryToLoot: BATTLE.loot.minCarryToLoot,
    },
    casualties: {
      defenderHospitalBps: BATTLE.casualties.defenderHospitalBps,
      attackerDeathBps: BATTLE.casualties.attackerDeathBps,
    },
    energy: {
      attackCost: BATTLE.energy.attackCost,
      scoutCost: BATTLE.energy.scoutCost,
    },
    protection: {
      newbieLevelCap: BATTLE.protection.newbieLevelCap,
      newbieAgeHours: BATTLE.protection.newbieAgeHours,
      maxLevelGap: BATTLE.protection.maxLevelGap,
      inactiveProtectDays: BATTLE.protection.inactiveProtectDays,
      maxAttacksPerTargetPerDay: BATTLE.protection.maxAttacksPerTargetPerDay,
      attackCooldownSec: BATTLE.cooldown.attackCooldownSec,
    },
    terrainAttackBps: { ...BATTLE.terrainAttackBps },
  }
}

// ── Internal loaders ─────────────────────────────────────────────────────────

interface UnitCatalogRow {
  id: string
  class: string
  attack: number
  defense: number
  health: number
  speed: number
  carryCapacity: number
  strongAgainst: unknown
  weakAgainst: unknown
}

function counterMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const unitId = (entry as { unitId?: unknown }).unitId
    const bonus = (entry as { bonusBps?: unknown }).bonusBps
    const penalty = (entry as { penaltyBps?: unknown }).penaltyBps
    if (typeof unitId !== 'string') continue
    if (typeof bonus === 'number') out[unitId] = bonus
    else if (typeof penalty === 'number') out[unitId] = -penalty
  }
  return out
}

/**
 * Builds a battle stack snapshot from a real PlayerUnit row + its catalog row.
 * Exported since Phase 32 — the territory assault pipeline reuses the SAME
 * army loading (no second combat stack builder exists).
 */
export function toBattleStack(count: number, unit: UnitCatalogRow): BattleUnitStack {
  return {
    unitTypeId: unit.id,
    class: unit.class as BattleUnitStack['class'],
    count,
    attack: unit.attack,
    defense: unit.defense,
    health: unit.health,
    speed: unit.speed,
    strongAgainst: counterMap(unit.strongAgainst),
    weakAgainst: counterMap(unit.weakAgainst),
    carryCapacity: unit.carryCapacity,
  }
}

interface LoadedArmy {
  side: BattleSide
  totalCount: number
  names: Map<string, string>
}

/**
 * Loads one side's army from REAL PlayerUnit rows + catalog. Exported since
 * Phase 32 — the territory assault reuses this loader under the same
 * battle-engine lock (never a second army builder).
 */
export async function loadArmySide(
  tx: ReadClient,
  playerId: string,
  name: string,
  modifiers: BpsModifiers,
  wallLevel: number,
  hospitalBps: number,
): Promise<LoadedArmy> {
  const rows = await tx.playerUnit.findMany({
    where: { playerId, count: { gt: 0 } },
    orderBy: { unitId: 'asc' },
    include: { unit: true },
  })
  const names = new Map<string, string>()
  const stacks = rows.map((row) => {
    names.set(row.unit.id, row.unit.name)
    return toBattleStack(row.count, row.unit as UnitCatalogRow)
  })
  return {
    side: {
      playerId,
      name,
      stacks,
      modifiers,
      wallLevel,
      hospitalBps,
    },
    totalCount: stacks.reduce((sum, s) => sum + s.count, 0),
    names,
  }
}

/** Defender wall bonus (bps above neutral) from the REAL wall level. */
function wallDefenseBonusBps(wallLevel: number): number {
  if (wallLevel <= 0) return 0
  const effects = effectsFor(BATTLE.wall.buildingType, wallLevel)
  const defenseBps = effects['defenseBps']
  if (typeof defenseBps !== 'number') return 0
  return defenseBps - BATTLE.wall.neutralBps
}

// ── Views (API surface) ──────────────────────────────────────────────────────

export interface CasualtyRow {
  unitId: string
  unitName: string
  count: number
}

export interface AttackResult {
  battleId: string
  /** Attacker-perspective outcome. */
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  result: BattleResult
  opponent: { playerId: string; name: string; level: number }
  roundsCount: number
  seed: number
  configVersion: number
  /** True when the defender had no units — the city fell without a fight. */
  unguardedCity: boolean
  casualties: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  survivors: { attacker: CasualtyRow[]; defender: CasualtyRow[] }
  /** Loot transferred (BigInt → string for JSON safety). */
  loot: Partial<Record<LootResource, string>>
  honor: { attackerDelta: number; defenderDelta: number }
  xp: {
    attackerGained: number
    defenderGained: number
    attackerLevel: number
    attackerLevelsGained: number
  }
  seasonPointsAwarded: number
  energySpent: number
  /** ISO timestamp when the attacker may attack again. */
  cooldownUntil: string
  /** True when this response is a stored replay of an identical request. */
  replayed?: boolean
}

interface LossRow {
  unitTypeId: string
  count: number
}

/** Casualty display rows — exported since Phase 32 (territory assault reports). */
export function casualtyRows(
  losses: readonly LossRow[],
  names: Map<string, string>,
): CasualtyRow[] {
  return losses.map((loss) => ({
    unitId: loss.unitTypeId,
    unitName: names.get(loss.unitTypeId) ?? loss.unitTypeId,
    count: loss.count,
  }))
}

function outcomeFor(result: BattleResult, role: 'ATTACKER' | 'DEFENDER'): AttackResult['outcome'] {
  if (result === 'DRAW') return 'DRAW'
  const attackerWon = result === 'ATTACKER_WIN'
  return attackerWon === (role === 'ATTACKER') ? 'VICTORY' : 'DEFEAT'
}

function lootToStrings(loot: LootAmounts): Partial<Record<LootResource, string>> {
  const out: Partial<Record<LootResource, string>> = {}
  for (const [resource, amount] of Object.entries(loot) as Array<[LootResource, bigint]>) {
    if (amount > 0n) out[resource] = amount.toString()
  }
  return out
}

function lootSummaryText(loot: LootAmounts, perspective: 'GAIN' | 'LOSS'): string | undefined {
  const codes: Record<LootResource, string> = {
    GOLD: 'Au',
    WOOD: 'Wd',
    IRON: 'Ir',
    FOOD: 'Fd',
    CRYSTAL: 'Cr',
  }
  const parts = LOOT_RESOURCES.filter((r) => (loot[r] ?? 0n) > 0n).map(
    (r) => `${codes[r]} ${loot[r]!.toString()}`,
  )
  if (parts.length === 0) return undefined
  return perspective === 'GAIN'
    ? `Plundered ${parts.join(' · ')}.`
    : `Lost ${parts.join(' · ')} to plunder.`
}

// ── Idempotency helpers ──────────────────────────────────────────────────────

function attackRequestHash(playerId: string, targetPlayerId: string): string {
  return createHash('sha256')
    .update(`${IDEMPOTENCY_ACTION}|${playerId}|${targetPlayerId}|${BATTLE.version}`)
    .digest('hex')
}

interface ReplayPayload {
  result: AttackResult
  replayed: true
}

function parseReplay(raw: unknown): ReplayPayload['result'] {
  return raw as AttackResult
}

// ── Transaction runner ───────────────────────────────────────────────────────

/**
 * Runs a battle transaction behind the battle-engine mutex + the process-wide
 * write mutex (lock order battle:engine → db:write; deadlock-free — see
 * module docblock).
 */
function runBattleTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withKeyLock(BATTLE_ENGINE_LOCK, () =>
    withKeyLock('db:write', () =>
      withWriteRetry(() => dbWrite.$transaction(run, BATTLE_TX_OPTIONS)),
    ),
  )
}

// ── The attack ───────────────────────────────────────────────────────────────

export interface AttackInput {
  targetPlayerId: string
  /** Client-generated key — a repeated submission replays the first battle. */
  idempotencyKey?: string
}

export async function attack(
  playerId: string,
  input: AttackInput,
): Promise<AttackResult & { replayed?: boolean }> {
  const targetPlayerId = input.targetPlayerId
  if (
    typeof targetPlayerId !== 'string' ||
    targetPlayerId.length === 0 ||
    targetPlayerId.length > 64
  ) {
    throw new AppError('INVALID_TARGET', 'targetPlayerId must be a 1…64 character string')
  }
  if (targetPlayerId === playerId) {
    throw new AppError('SELF_TARGET', 'You cannot attack your own city')
  }

  const idempotencyKey = input.idempotencyKey
  if (idempotencyKey !== undefined) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > BATTLE.idempotency.keyMaxLength
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        `idempotencyKey must be a 1…${BATTLE.idempotency.keyMaxLength} character string`,
      )
    }
  }

  const requestHash = attackRequestHash(playerId, targetPlayerId)

  // Replay fast-path (read-only) — the authoritative claim happens in-tx.
  if (idempotencyKey !== undefined) {
    const existing = await db.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
    if (existing && existing.expiresAt.getTime() > Date.now()) {
      if (existing.action !== IDEMPOTENCY_ACTION || existing.requestHash !== requestHash) {
        throw new AppError(
          'IDEMPOTENT_REPLAY',
          'Idempotency key was already used for a different request',
        )
      }
      if (existing.responseBody !== null) {
        return { ...parseReplay(existing.responseBody), replayed: true }
      }
    }
  }

  const now = new Date()

  return runBattleTransaction(async (tx) => {
    // ── Idempotency claim (in-tx, mirrors the economy grant pattern) ────────
    if (idempotencyKey !== undefined) {
      const existing = await tx.idempotencyKey.findUnique({ where: { key: idempotencyKey } })
      if (existing) {
        if (existing.expiresAt.getTime() <= now.getTime()) {
          await tx.idempotencyKey.delete({ where: { key: idempotencyKey } })
        } else if (existing.action !== IDEMPOTENCY_ACTION || existing.requestHash !== requestHash) {
          throw new AppError(
            'IDEMPOTENT_REPLAY',
            'Idempotency key was already used for a different request',
          )
        } else if (existing.responseBody !== null) {
          return { ...parseReplay(existing.responseBody), replayed: true }
        } else {
          throw new AppError('IDEMPOTENT_REPLAY', 'Attack is still in flight — retry shortly')
        }
      }
    }

    // ── Attacker & target ───────────────────────────────────────────────────
    const attacker = await tx.player.findUnique({
      where: { id: playerId },
      select: { id: true, name: true, level: true, honor: true },
    })
    if (!attacker) throw new AppError('PLAYER_NOT_FOUND', 'Attacker not found')

    const target = await tx.player.findUnique({
      where: { id: targetPlayerId },
      select: {
        id: true,
        name: true,
        level: true,
        honor: true,
        createdAt: true,
        clanId: true,
        user: { select: { isBanned: true, lastLoginAt: true } },
      },
    })
    if (!target) throw new AppError('PLAYER_NOT_FOUND', 'Target player not found')
    if (target.id === attacker.id) {
      throw new AppError('SELF_TARGET', 'You cannot attack your own city')
    }
    if (target.user.isBanned) {
      throw new AppError('INVALID_TARGET', 'Target is not attackable')
    }

    // ── Season gate (lazy state machine resolved inside the tx) ─────────────
    const season = await resolveSeasonStateInTx(tx, now)
    if (!season || season.status !== 'ACTIVE') {
      throw new AppError('SEASON_NOT_ACTIVE', 'Battles require an active season')
    }

    // ── Cooldown (server clock — the ONLY authority) ────────────────────────
    const lastAttack = await tx.battle.findFirst({
      where: { attackerPlayerId: attacker.id, type: 'PVP_ATTACK' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    })
    if (lastAttack) {
      const cooldownEndsAt =
        lastAttack.startedAt.getTime() + BATTLE.cooldown.attackCooldownSec * 1000
      if (cooldownEndsAt > now.getTime()) {
        throw new AppError(
          'ACTION_ON_COOLDOWN',
          'Your army needs time to regroup before attacking again',
          {
            retryAfterSec: Math.ceil((cooldownEndsAt - now.getTime()) / 1000),
          },
        )
      }
    }

    // ── Protection rules (all config-driven, all server-evaluated) ──────────
    const blockedBy: string[] = []
    if (target.level < BATTLE.protection.newbieLevelCap) {
      blockedBy.push('NEWBIE_SHIELD')
    }
    const accountAgeHours = (now.getTime() - target.createdAt.getTime()) / 3_600_000
    if (accountAgeHours < BATTLE.protection.newbieAgeHours) {
      blockedBy.push('NEWBIE_SHIELD')
    }
    const lastLogin = target.user.lastLoginAt ?? target.createdAt
    const inactiveDays = (now.getTime() - lastLogin.getTime()) / 86_400_000
    if (inactiveDays >= BATTLE.protection.inactiveProtectDays) {
      blockedBy.push('INACTIVE_SHIELD')
    }
    if (Math.abs(attacker.level - target.level) > BATTLE.protection.maxLevelGap) {
      blockedBy.push('LEVEL_GAP')
    }
    const recentAttacks = await tx.battle.count({
      where: {
        attackerPlayerId: attacker.id,
        defenderPlayerId: target.id,
        type: 'PVP_ATTACK',
        startedAt: { gt: new Date(now.getTime() - 86_400_000) },
      },
    })
    if (recentAttacks >= BATTLE.protection.maxAttacksPerTargetPerDay) {
      blockedBy.push('REPEATED_RAIDS')
    }
    if (blockedBy.length > 0) {
      throw new AppError('PROTECTED_TARGET', 'Target is protected from this attack', {
        reasons: blockedBy,
      })
    }

    // ── Energy (lazy-tick sync + CAS decrement, never below zero) ───────────
    await syncPlayerEnergy(tx, attacker.id, now)
    const spend = await tx.player.updateMany({
      where: { id: attacker.id, energy: { gte: BATTLE.energy.attackCost } },
      data: { energy: { decrement: BATTLE.energy.attackCost } },
    })
    if (spend.count === 0) {
      throw new AppError(
        'INSUFFICIENT_ENERGY',
        `Not enough energy: need ${BATTLE.energy.attackCost}`,
        { needed: BATTLE.energy.attackCost },
      )
    }

    // ── Armies & modifiers (real rows under the global write lock) ──────────
    const wall = await tx.building.findFirst({
      where: { city: { playerId: target.id }, type: BATTLE.wall.buildingType },
      select: { level: true },
    })
    const wallLevel = wall?.level ?? 0
    const wallBps = wallDefenseBonusBps(wallLevel)
    const defenderModifiers: BpsModifiers =
      wallBps !== 0
        ? {
            attackBps: {},
            defenseBps: { INFANTRY: wallBps, RANGED: wallBps, CAVALRY: wallBps, SIEGE: wallBps },
            healthBps: {},
            speedBps: 0,
            lootBps: 0,
          }
        : EMPTY_BPS

    const attackerArmy = await loadArmySide(tx, attacker.id, attacker.name, EMPTY_BPS, 0, 0)
    const defenderArmy = await loadArmySide(
      tx,
      target.id,
      target.name,
      defenderModifiers,
      wallLevel,
      BATTLE.casualties.defenderHospitalBps,
    )
    if (attackerArmy.totalCount <= 0) {
      throw new AppError('ARMY_EMPTY', 'You have no units to attack with')
    }
    const unitNames = new Map<string, string>([...attackerArmy.names, ...defenderArmy.names])

    const defenderBalances = await getWalletBalances(tx, target.id)
    const seed = randomInt(0, 2_147_483_647)
    const configSnapshot = battleConfigSnapshot()

    // ── Simulate (PURE — no DB access inside) ───────────────────────────────
    let sim: BattleSimulationResult
    let unguardedCity = false
    if (defenderArmy.totalCount <= 0) {
      // An unguarded city falls without a fight — a documented rule, not a
      // special bug: no rounds, no losses, loot capped by carry capacity.
      unguardedCity = true
      sim = resolveUnguarded(attackerArmy.side, defenderBalances, configSnapshot)
    } else {
      sim = simulateBattle({
        seed,
        config: configSnapshot,
        attacker: attackerArmy.side,
        defender: defenderArmy.side,
        context: { type: 'PVP_ATTACK', terrain: 'CITY' },
        defenderBalances: Object.fromEntries(
          LOOT_RESOURCES.map((r) => [r, defenderBalances[r as EconomyResource].toString()]),
        ),
      })
    }

    // ── Persist the battle ──────────────────────────────────────────────────
    const battle = await tx.battle.create({
      data: {
        type: 'PVP_ATTACK',
        seed,
        configVersion: BATTLE.version,
        attackerPlayerId: attacker.id,
        defenderPlayerId: target.id,
        result: sim.result,
        attackerPower: BigInt(sim.attackerPower),
        defenderPower: BigInt(sim.defenderPower),
        roundsCount: unguardedCity ? 0 : new Set(sim.rounds.map((r) => r.roundNumber)).size,
        loot: lootToStrings(sim.loot) as Prisma.InputJsonValue,
        honorDelta:
          sim.result === 'ATTACKER_WIN'
            ? BATTLE.rewards.attackWinHonor
            : sim.result === 'DEFENDER_WIN'
              ? BATTLE.rewards.defenseWinHonor
              : BATTLE.rewards.drawHonor,
        reputationDelta: 0,
        energySpent: BATTLE.energy.attackCost,
        startedAt: now,
        endedAt: now,
      },
    })

    if (sim.rounds.length > 0) {
      await tx.battleRound.createMany({
        data: sim.rounds.map((round) => ({
          battleId: battle.id,
          roundNumber: round.roundNumber,
          side: round.side,
          unitsCommitted: round.unitsCommitted as unknown as Prisma.InputJsonValue,
          unitsLost: round.unitsLost as unknown as Prisma.InputJsonValue,
          damageDealt: BigInt(round.damageDealt),
          events: round.actions as unknown as Prisma.InputJsonValue,
        })),
      })
    }

    // ── Apply casualties (CAS-guarded decrements — never negative) ──────────
    const applyLosses = async (ownerId: string, losses: readonly LossRow[]): Promise<void> => {
      for (const loss of losses) {
        if (loss.count <= 0) continue
        const claim = await tx.playerUnit.updateMany({
          where: { playerId: ownerId, unitId: loss.unitTypeId, count: { gte: loss.count } },
          data: { count: { decrement: loss.count } },
        })
        if (claim.count === 0) {
          // Unreachable under the engine lock — a hard invariant backstop.
          throw new AppError('INTERNAL_ERROR', `Casualty invariant violated for ${loss.unitTypeId}`)
        }
      }
    }
    await applyLosses(attacker.id, sim.attackerLosses)
    await applyLosses(target.id, sim.defenderLosses)

    // ── Loot through the ledger (defender debit → attacker credit) ──────────
    const lootEntries = LOOT_RESOURCES.filter((r) => (sim.loot[r] ?? 0n) > 0n)
    const ledgerMeta = { reason: 'BATTLE_REWARD' as const, refType: 'battle', refId: battle.id }
    if (lootEntries.length > 0) {
      const amounts: Partial<Record<EconomyResource, bigint>> = {}
      for (const resource of lootEntries) amounts[resource] = sim.loot[resource]!
      await spendResources(tx, target.id, amounts, ledgerMeta)
      await grantResources(tx, attacker.id, amounts, ledgerMeta)
    }

    // ── Rewards: honor (never negative), XP, season points ──────────────────
    const attackerWon = sim.result === 'ATTACKER_WIN'
    const defenderWon = sim.result === 'DEFENDER_WIN'
    const attackerHonorDelta = attackerWon
      ? BATTLE.rewards.attackWinHonor
      : BATTLE.rewards.drawHonor
    const defenderHonorDelta = defenderWon
      ? BATTLE.rewards.defenseWinHonor
      : BATTLE.rewards.drawHonor
    if (attackerHonorDelta > 0) {
      await tx.player.update({
        where: { id: attacker.id },
        data: { honor: { increment: BigInt(attackerHonorDelta) } },
      })
    }
    if (defenderHonorDelta > 0) {
      await tx.player.update({
        where: { id: target.id },
        data: { honor: { increment: BigInt(defenderHonorDelta) } },
      })
    }

    const attackerXpAmount = attackerWon
      ? BATTLE.rewards.attackWinXp
      : BATTLE.rewards.attackParticipationXp
    const defenderXpAmount = defenderWon
      ? BATTLE.rewards.defenseWinXp
      : BATTLE.rewards.defenseParticipationXp
    const attackerXp = await grantXp(tx, {
      playerId: attacker.id,
      amount: attackerXpAmount,
      source: 'battle',
    })
    await grantXp(tx, { playerId: target.id, amount: defenderXpAmount, source: 'battle' })

    let seasonPointsAwarded = 0
    if (attackerWon) {
      seasonPointsAwarded = await awardSeasonPointsInTx(
        tx,
        attacker.id,
        BATTLE.rewards.victorySeasonPoints,
        'BATTLE_VICTORY',
        {
          battleId: battle.id,
        },
      )
    } else if (defenderWon) {
      await awardSeasonPointsInTx(
        tx,
        target.id,
        BATTLE.rewards.victorySeasonPoints,
        'BATTLE_VICTORY',
        {
          battleId: battle.id,
        },
      )
    }

    // ── Statistics (append-only counters) ───────────────────────────────────
    const sumLosses = (rows: readonly LossRow[]): number =>
      rows.reduce((sum, row) => sum + row.count, 0)
    const lootTotal = LOOT_RESOURCES.reduce((sum, r) => sum + (sim.loot[r] ?? 0n), 0n)

    const attackerStats: Record<string, number> = { attacksLaunched: 1 }
    if (attackerWon) attackerStats['battlesWon'] = 1
    else if (sim.result === 'DEFENDER_WIN') attackerStats['battlesLost'] = 1
    const attackerLostUnits = sumLosses(sim.attackerLosses)
    if (attackerLostUnits > 0) attackerStats['unitsLost'] = attackerLostUnits
    if (lootTotal > 0n) attackerStats['resourcesPlundered'] = Number(lootTotal)
    await recordPlayerStats(tx, attacker.id, attackerStats)

    const defenderStats: Record<string, number> = {}
    if (defenderWon) defenderStats['defensesWon'] = 1
    else if (sim.result === 'ATTACKER_WIN') defenderStats['battlesLost'] = 1
    const defenderLostUnits = sumLosses(sim.defenderLosses)
    if (defenderLostUnits > 0) defenderStats['unitsLost'] = defenderLostUnits
    if (Object.keys(defenderStats).length > 0) {
      await recordPlayerStats(tx, target.id, defenderStats)
    }

    // ── Power recalculation (army changed on both sides) ────────────────────
    await recalculatePlayerPower(tx, attacker.id)
    await recalculatePlayerPower(tx, target.id)

    // ── Quest events (Phase 31 — same transaction as the battle) ────────────
    await applyQuestEventInTx(
      tx,
      attacker.id,
      { kind: 'BATTLE_FINISHED', won: attackerWon, role: 'ATTACKER', battleId: battle.id },
      now,
    )
    await applyQuestEventInTx(
      tx,
      target.id,
      { kind: 'BATTLE_FINISHED', won: defenderWon, role: 'DEFENDER', battleId: battle.id },
      now,
    )

    // ── Achievement evaluation (stats/level/power settled above) ────────────
    await evaluateAchievementsInTx(tx, attacker.id, {}, now)
    await evaluateAchievementsInTx(tx, target.id, {}, now)

    // ── Battle logs (per-participant pre-formatted reports) ─────────────────
    const attackerView = {
      battleId: battle.id,
      type: 'PVP_ATTACK',
      result: sim.result,
      myRole: 'ATTACKER',
      opponent: { playerId: target.id, name: target.name, level: target.level },
      roundsCount: battle.roundsCount,
      seed: battle.seed,
      configVersion: BATTLE.version,
      unguardedCity,
      yourArmy: attackerArmy.side.stacks,
      enemyArmy: defenderArmy.side.stacks,
      yourLosses: casualtyRows(sim.attackerLosses, unitNames),
      enemyLosses: casualtyRows(sim.defenderLosses, unitNames),
      loot: lootToStrings(sim.loot),
      honorDelta: attackerHonorDelta,
      energySpent: BATTLE.energy.attackCost,
      startedAt: now.toISOString(),
    }
    const defenderView = {
      battleId: battle.id,
      type: 'PVP_ATTACK',
      result: sim.result,
      myRole: 'DEFENDER',
      opponent: { playerId: attacker.id, name: attacker.name, level: attacker.level },
      roundsCount: battle.roundsCount,
      seed: battle.seed,
      configVersion: BATTLE.version,
      unguardedCity,
      yourArmy: defenderArmy.side.stacks,
      enemyArmy: attackerArmy.side.stacks,
      yourLosses: casualtyRows(sim.defenderLosses, unitNames),
      enemyLosses: casualtyRows(sim.attackerLosses, unitNames),
      loot: lootToStrings(sim.loot),
      honorDelta: defenderHonorDelta,
      startedAt: now.toISOString(),
    }
    await tx.battleLog.createMany({
      data: [
        {
          battleId: battle.id,
          playerId: attacker.id,
          role: 'ATTACKER',
          content: attackerView as unknown as Prisma.InputJsonValue,
        },
        {
          battleId: battle.id,
          playerId: target.id,
          role: 'DEFENDER',
          content: defenderView as unknown as Prisma.InputJsonValue,
        },
      ],
    })

    // ── Notifications (existing outbox — no second system) ──────────────────
    const attackerOutcome = outcomeFor(sim.result, 'ATTACKER')
    const defenderOutcome = outcomeFor(sim.result, 'DEFENDER')
    await enqueueNotificationInTx(tx, {
      playerId: attacker.id,
      type: 'ATTACK_RESULT',
      dedupeKey: notificationDedupeKeys.attackResult(battle.id, attacker.id),
      payload: {
        battleId: battle.id,
        viewerRole: 'ATTACKER',
        outcome: attackerOutcome,
        opponentName: target.name,
        lootSummary: lootSummaryText(sim.loot, 'GAIN'),
      },
    })
    await enqueueNotificationInTx(tx, {
      playerId: target.id,
      type: 'ATTACK_RESULT',
      dedupeKey: notificationDedupeKeys.attackResult(battle.id, target.id),
      payload: {
        battleId: battle.id,
        viewerRole: 'DEFENDER',
        outcome: defenderOutcome,
        opponentName: attacker.name,
        lootSummary: lootSummaryText(sim.loot, 'LOSS'),
      },
    })

    // ── Idempotency claim commits WITH the battle ───────────────────────────
    const cooldownUntil = new Date(now.getTime() + BATTLE.cooldown.attackCooldownSec * 1000)
    const response: AttackResult = {
      battleId: battle.id,
      outcome: attackerOutcome,
      result: sim.result,
      opponent: { playerId: target.id, name: target.name, level: target.level },
      roundsCount: battle.roundsCount,
      seed,
      configVersion: BATTLE.version,
      unguardedCity,
      casualties: {
        attacker: casualtyRows(sim.attackerLosses, unitNames),
        defender: casualtyRows(sim.defenderLosses, unitNames),
      },
      survivors: {
        attacker: casualtyRows(sim.attackerSurvivors, unitNames),
        defender: casualtyRows(sim.defenderSurvivors, unitNames),
      },
      loot: lootToStrings(sim.loot),
      honor: { attackerDelta: attackerHonorDelta, defenderDelta: defenderHonorDelta },
      xp: {
        attackerGained: attackerXpAmount,
        defenderGained: defenderXpAmount,
        attackerLevel: attackerXp.level,
        attackerLevelsGained: attackerXp.levelsGained,
      },
      seasonPointsAwarded,
      energySpent: BATTLE.energy.attackCost,
      cooldownUntil: cooldownUntil.toISOString(),
    }

    if (idempotencyKey !== undefined) {
      await tx.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          playerId: attacker.id,
          action: IDEMPOTENCY_ACTION,
          requestHash,
          responseBody: response as unknown as Prisma.InputJsonValue,
          expiresAt: new Date(now.getTime() + BATTLE.idempotency.ttlSeconds * 1000),
        },
      })
    }

    log.info('battle resolved', {
      battleId: battle.id,
      attackerId: attacker.id,
      defenderId: target.id,
      result: sim.result,
      rounds: battle.roundsCount,
      seed,
      lootTotal: lootTotal.toString(),
    })

    return response
  })
}

/** Unguarded-city resolution — attacker wins, no rounds, carry-capped loot. */
function resolveUnguarded(
  attackerSide: BattleSide,
  defenderBalances: Record<EconomyResource, bigint>,
  config: BattleConfig,
): BattleSimulationResult {
  const carry = attackerSide.stacks.reduce(
    (sum, stack) => sum + BigInt(stack.carryCapacity) * BigInt(stack.count),
    0n,
  )
  const loot: LootAmounts = {}
  if (carry > 0n && config.loot.defenderLootableBps > 0) {
    for (const resource of LOOT_RESOURCES) {
      const share = (defenderBalances[resource] * BigInt(config.loot.defenderLootableBps)) / 10_000n
      loot[resource] = share > carry ? carry : share
    }
  }
  const attackerPower = attackerSide.stacks.reduce(
    (sum, s) => sum + s.count * (s.attack + s.defense + s.health),
    0,
  )
  return {
    result: 'ATTACKER_WIN',
    rounds: [],
    attackerLosses: [],
    defenderLosses: [],
    attackerSurvivors: attackerSide.stacks.map((s) => ({
      unitTypeId: s.unitTypeId,
      count: s.count,
    })),
    defenderSurvivors: [],
    defenderHospitalized: [],
    loot,
    honorDelta: 0,
    reputationDelta: 0,
    attackerPower,
    defenderPower: 0,
  }
}

// ── Read models ──────────────────────────────────────────────────────────────

export interface AttackTargetView {
  playerId: string
  name: string
  level: number
  power: string
  honor: string
  reputation: string
  lastLoginAt: string | null
  attackable: boolean
  blockedBy: string[]
}

export interface BattleTargetsView {
  attacker: {
    energy: number
    energyMax: number
    nextRegenAtMs: number | null
    attackCost: number
    cooldownRemainingSec: number
    armyUnits: number
  }
  targets: AttackTargetView[]
}

/** Public target roster — NEVER reveals defender armies (hidden information). */
export async function listTargets(
  playerId: string,
  limit: number = 20,
): Promise<BattleTargetsView> {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)))

  const attacker = await db.player.findUnique({
    where: { id: playerId },
    select: { id: true, level: true },
  })
  if (!attacker) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const [energy, army, lastAttack, rows] = await Promise.all([
    syncPlayerEnergy(db, playerId),
    db.playerUnit.aggregate({
      where: { playerId, count: { gt: 0 } },
      _sum: { count: true },
    }),
    db.battle.findFirst({
      where: { attackerPlayerId: playerId, type: 'PVP_ATTACK' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    db.player.findMany({
      where: { id: { not: playerId }, user: { isBanned: false } },
      orderBy: [{ power: 'desc' }, { id: 'asc' }],
      take: boundedLimit * 2, // over-fetch: protected rows still occupy slots
      select: {
        id: true,
        name: true,
        level: true,
        power: true,
        honor: true,
        reputation: true,
        createdAt: true,
        user: { select: { lastLoginAt: true } },
      },
    }),
  ])

  const now = new Date()
  const cooldownRemainingSec = lastAttack
    ? Math.max(
        0,
        Math.ceil(
          (lastAttack.startedAt.getTime() +
            BATTLE.cooldown.attackCooldownSec * 1000 -
            now.getTime()) /
            1000,
        ),
      )
    : 0

  const targets: AttackTargetView[] = []
  for (const row of rows) {
    if (targets.length >= boundedLimit) break
    const blockedBy: string[] = []
    if (row.level < BATTLE.protection.newbieLevelCap) blockedBy.push('NEWBIE_SHIELD')
    if ((now.getTime() - row.createdAt.getTime()) / 3_600_000 < BATTLE.protection.newbieAgeHours)
      blockedBy.push('NEWBIE_SHIELD')
    const lastLogin = row.user.lastLoginAt ?? row.createdAt
    if ((now.getTime() - lastLogin.getTime()) / 86_400_000 >= BATTLE.protection.inactiveProtectDays)
      blockedBy.push('INACTIVE_SHIELD')
    if (Math.abs(attacker.level - row.level) > BATTLE.protection.maxLevelGap)
      blockedBy.push('LEVEL_GAP')
    targets.push({
      playerId: row.id,
      name: row.name,
      level: row.level,
      power: row.power.toString(),
      honor: row.honor.toString(),
      reputation: row.reputation,
      lastLoginAt: (row.user.lastLoginAt ?? row.createdAt).toISOString(),
      attackable: blockedBy.length === 0,
      blockedBy: [...new Set(blockedBy)],
    })
  }

  return {
    attacker: {
      energy: energy.energy,
      energyMax: energy.max,
      nextRegenAtMs: energy.nextRegenAtMs,
      attackCost: BATTLE.energy.attackCost,
      cooldownRemainingSec,
      armyUnits: army._sum.count ?? 0,
    },
    targets,
  }
}

export interface BattleHistoryRow {
  battleId: string
  type: string
  result: BattleResult
  myRole: 'ATTACKER' | 'DEFENDER'
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  opponent: { playerId: string; name: string | null }
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: unknown
  honorDelta: number
  energySpent: number
  startedAt: string
  endedAt: string | null
}

export interface BattleHistoryView {
  battles: BattleHistoryRow[]
  page: number
  pageSize: number
  total: number
  pages: number
}

export async function listPlayerBattles(
  playerId: string,
  page: number,
  pageSize: number,
): Promise<BattleHistoryView> {
  const boundedPage = Math.max(1, Math.floor(page))
  const boundedSize = Math.max(1, Math.min(50, Math.floor(pageSize)))
  const where = {
    OR: [{ attackerPlayerId: playerId }, { defenderPlayerId: playerId }],
  }
  const [total, rows] = await Promise.all([
    db.battle.count({ where }),
    db.battle.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (boundedPage - 1) * boundedSize,
      take: boundedSize,
      include: {
        attacker: { select: { id: true, name: true } },
        defender: { select: { id: true, name: true } },
      },
    }),
  ])

  return {
    battles: rows.map((battle) => {
      const myRole: 'ATTACKER' | 'DEFENDER' =
        battle.attackerPlayerId === playerId ? 'ATTACKER' : 'DEFENDER'
      const opponent =
        myRole === 'ATTACKER'
          ? { playerId: battle.defenderPlayerId ?? '', name: battle.defender?.name ?? null }
          : { playerId: battle.attackerPlayerId, name: battle.attacker.name }
      return {
        battleId: battle.id,
        type: battle.type,
        result: battle.result as BattleResult,
        myRole,
        outcome: outcomeFor(battle.result as BattleResult, myRole),
        opponent,
        attackerPower: battle.attackerPower.toString(),
        defenderPower: battle.defenderPower.toString(),
        roundsCount: battle.roundsCount,
        loot: battle.loot,
        honorDelta: battle.honorDelta,
        energySpent: battle.energySpent,
        startedAt: battle.startedAt.toISOString(),
        endedAt: battle.endedAt?.toISOString() ?? null,
      }
    }),
    page: boundedPage,
    pageSize: boundedSize,
    total,
    pages: Math.max(1, Math.ceil(total / boundedSize)),
  }
}

export interface BattleDetailView {
  battleId: string
  type: string
  result: BattleResult
  myRole: 'ATTACKER' | 'DEFENDER'
  outcome: 'VICTORY' | 'DEFEAT' | 'DRAW'
  opponent: { playerId: string; name: string | null }
  seed: number
  configVersion: number
  attackerPower: string
  defenderPower: string
  roundsCount: number
  loot: unknown
  honorDelta: number
  energySpent: number
  startedAt: string
  endedAt: string | null
  rounds: Array<{
    roundNumber: number
    side: string
    unitsCommitted: unknown
    unitsLost: unknown
    damageDealt: string
    actions: unknown
  }>
  report: unknown
}

/** Participant-only battle detail (the admin panel has its own surface). */
export async function getBattleForPlayer(
  playerId: string,
  battleId: string,
): Promise<BattleDetailView> {
  const battle = await db.battle.findUnique({
    where: { id: battleId },
    include: {
      attacker: { select: { id: true, name: true } },
      defender: { select: { id: true, name: true } },
      rounds: { orderBy: [{ roundNumber: 'asc' }, { side: 'asc' }] },
      logs: { where: { playerId }, take: 1 },
    },
  })
  if (!battle) throw new AppError('BATTLE_NOT_FOUND', 'Battle not found')

  const myRole: 'ATTACKER' | 'DEFENDER' | null =
    battle.attackerPlayerId === playerId
      ? 'ATTACKER'
      : battle.defenderPlayerId === playerId
        ? 'DEFENDER'
        : null
  if (!myRole) {
    throw new AppError('FORBIDDEN', 'You did not participate in this battle')
  }

  const opponent =
    myRole === 'ATTACKER'
      ? { playerId: battle.defenderPlayerId ?? '', name: battle.defender?.name ?? null }
      : { playerId: battle.attackerPlayerId, name: battle.attacker.name }

  return {
    battleId: battle.id,
    type: battle.type,
    result: battle.result as BattleResult,
    myRole,
    outcome: outcomeFor(battle.result as BattleResult, myRole),
    opponent,
    seed: battle.seed,
    configVersion: battle.configVersion,
    attackerPower: battle.attackerPower.toString(),
    defenderPower: battle.defenderPower.toString(),
    roundsCount: battle.roundsCount,
    loot: battle.loot,
    honorDelta: battle.honorDelta,
    energySpent: battle.energySpent,
    startedAt: battle.startedAt.toISOString(),
    endedAt: battle.endedAt?.toISOString() ?? null,
    rounds: battle.rounds.map((round) => ({
      roundNumber: round.roundNumber,
      side: round.side,
      unitsCommitted: round.unitsCommitted,
      unitsLost: round.unitsLost,
      damageDealt: round.damageDealt.toString(),
      actions: round.events,
    })),
    report: battle.logs[0]?.content ?? null,
  }
}
