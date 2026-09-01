/**
 * WARLORDS — Achievement service (Phase 31: Quest + Achievement Engine).
 *
 * Achievements are the PERMANENT honor layer: they never reset with cycles
 * and persist across seasons. Unlocks are evaluated SERVER-SIDE from
 * persisted state (Player.stats counters, player columns, city building
 * levels, season-settlement ranks) inside the caller's transaction — the
 * client has no write surface, not even a "claim": the reward is granted
 * automatically at unlock through the Economy/Ledger (ACHIEVEMENT_REWARD
 * reason) and announced via the existing Notification Engine.
 *
 * Exactly-once unlock: the PlayerAchievement @@unique([playerId,
 * achievementId]) constraint is the arbiter — a lost concurrent unlock race
 * simply skips the reward. Exactly-once reward: the unlock row and the
 * ledger payout commit in the SAME transaction, backed by an idempotent
 * economy grant key (`achievement:${playerId}:${achievementId}`).
 */

import { Prisma } from '@prisma/client'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { db } from '@/lib/db'
import type { Tx } from './player-bootstrap.service'
import { grantResources } from './economy.service'
import { grantXp } from './progression.service'
import { readPlayerStats } from './stats.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'

import { splitReward, summarizeReward } from '@/lib/game/engine/quest/progress'
import type { EconomyResource } from '@/lib/game/config/economy'

const log = logger.child({ module: 'game/achievements' })

interface AchievementDefinitionRow {
  id: string
  title: string
  category: string
  target: number
  metric: string
  meta: Prisma.JsonValue
  reward: Prisma.JsonValue
}

export interface AchievementUnlockedInfo {
  achievementId: string
  title: string
  rewardSummary?: string
}

export interface AchievementEvaluationContext {
  /** Final rank of the player in the just-settled season (SEASON_TOP metric). */
  seasonRank?: number
}

/**
 * Evaluates every active achievement against the player's persisted state
 * and unlocks the newly-satisfied ones (auto reward, atomic with the tx).
 * `buildingTypes` lets callers hint which building levels matter; without
 * the hint, BUILDING_LEVEL achievements query their own rows (still bounded).
 */
export async function evaluateAchievementsInTx(
  tx: Tx,
  playerId: string,
  ctx: AchievementEvaluationContext = {},
  now: Date = new Date(),
): Promise<AchievementUnlockedInfo[]> {
  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { id: true, level: true, power: true },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const [stats, catalog, unlockedRows] = await Promise.all([
    readPlayerStats(tx, playerId),
    tx.achievement.findMany({ where: { isActive: true } }),
    tx.playerAchievement.findMany({
      where: { playerId },
      select: { achievementId: true },
    }),
  ])

  const unlocked = new Set(unlockedRows.map((r) => r.achievementId))
  const candidates = catalog.filter((a) => !unlocked.has(a.id))
  if (candidates.length === 0) return []

  // Bounded building lookup — only when an unevaluated BUILDING_LEVEL
  // achievement exists (avoids a per-candidate query on the hot path).
  const needsBuildings = candidates.some((a) => a.metric === 'BUILDING_LEVEL')
  const buildingLevels = new Map<string, number>()
  if (needsBuildings) {
    const rows = await tx.building.findMany({
      where: { city: { playerId } },
      select: { type: true, level: true },
    })
    for (const row of rows) buildingLevels.set(row.type, row.level)
  }

  const newlyUnlocked: AchievementDefinitionRow[] = []
  for (const achievement of candidates) {
    if (achievementSatisfied(achievement, stats, player, buildingLevels, ctx)) {
      newlyUnlocked.push(achievement)
    }
  }
  if (newlyUnlocked.length === 0) return []

  const granted: AchievementUnlockedInfo[] = []
  for (const achievement of newlyUnlocked) {
    try {
      await tx.playerAchievement.create({
        data: { playerId, achievementId: achievement.id, unlockedAt: now },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue // concurrent unlock already committed — reward must not repeat
      }
      throw err
    }

    await grantAchievementRewardInTx(tx, playerId, achievement, now)
    const rewardSummary = summarizeReward(achievement.reward)
    await enqueueNotificationInTx(tx, {
      playerId,
      type: 'ACHIEVEMENT_UNLOCKED',
      dedupeKey: notificationDedupeKeys.achievement(playerId, achievement.id),
      payload: {
        achievementId: achievement.id,
        achievementName: achievement.title,
        rewardSummary,
      },
    })
    granted.push({
      achievementId: achievement.id,
      title: achievement.title,
      rewardSummary,
    })
    log.info('achievement unlocked', { playerId, achievementId: achievement.id })
  }

  return granted
}

/** Pure predicate — the single definition of "satisfied" per metric. */
function achievementSatisfied(
  achievement: AchievementDefinitionRow,
  stats: Record<string, number>,
  player: { level: number; power: bigint },
  buildingLevels: Map<string, number>,
  ctx: AchievementEvaluationContext,
): boolean {
  const meta =
    achievement.meta !== null &&
    typeof achievement.meta === 'object' &&
    !Array.isArray(achievement.meta)
      ? (achievement.meta as Record<string, unknown>)
      : {}
  switch (achievement.metric) {
    case 'STAT': {
      const statKey = typeof meta['statKey'] === 'string' ? meta['statKey'] : null
      if (!statKey) return false
      return (stats[statKey] ?? 0) >= achievement.target
    }
    case 'PLAYER_LEVEL':
      return player.level >= achievement.target
    case 'PLAYER_POWER':
      return player.power >= BigInt(achievement.target)
    case 'BUILDING_LEVEL': {
      const buildingType = typeof meta['buildingType'] === 'string' ? meta['buildingType'] : null
      if (!buildingType) return false
      return (buildingLevels.get(buildingType) ?? 0) >= achievement.target
    }
    case 'SEASON_TOP':
      return ctx.seasonRank !== undefined && ctx.seasonRank <= achievement.target
    default:
      // Unknown metric — inert (fail closed), surfaced by the catalog test.
      return false
  }
}

/**
 * Grants the achievement's reward through the EXISTING economy/progression
 * rails inside the caller's transaction: wallet resources via the ledger
 * (ACHIEVEMENT_REWARD), XP via grantXp (CAS), honor via the player column.
 * An unsupported reward key fails the transaction CLOSED — a reward can
 * never silently shrink.
 */
async function grantAchievementRewardInTx(
  tx: Tx,
  playerId: string,
  achievement: AchievementDefinitionRow,
  _now: Date,
): Promise<void> {
  const split = splitReward(achievement.reward)
  if (split.unsupported.length > 0) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Achievement ${achievement.id} declares unsupported reward keys: ${split.unsupported.join(', ')}`,
    )
  }

  const walletEntries = Object.entries(split.wallet) as Array<[EconomyResource, number]>
  if (walletEntries.length > 0) {
    const amounts = Object.fromEntries(
      walletEntries.map(([resource, amount]) => [resource, BigInt(amount)]),
    ) as Partial<Record<EconomyResource, bigint>>
    await grantResources(tx, playerId, amounts, {
      reason: 'ACHIEVEMENT_REWARD',
      refType: 'achievement',
      refId: achievement.id,
      idempotencyKey: `achievement:${playerId}:${achievement.id}`,
    })
  }

  if (split.xp > 0) {
    await grantXp(tx, { playerId, amount: split.xp, source: 'achievement' })
  }

  if (split.honor > 0) {
    await tx.player.update({
      where: { id: playerId },
      data: { honor: { increment: BigInt(split.honor) } },
    })
  }
}

// ── Read model ───────────────────────────────────────────────────────────────

export interface AchievementView {
  id: string
  title: string
  description: string
  category: string
  metric: string
  target: number
  reward: Record<string, number>
  progress: {
    current: number
    target: number
    complete: boolean
  } | null
  unlocked: boolean
  unlockedAt: string | null
}

/**
 * Full achievement board for a player: unlocked + locked, with live progress
 * where the metric is player-visible. SEASON_TOP carries no live progress
 * (it resolves only at settlement).
 */
export async function listAchievementsView(playerId: string): Promise<{
  achievements: AchievementView[]
}> {
  const [player, catalog, unlockedRows] = await Promise.all([
    db.player.findUnique({
      where: { id: playerId },
      select: { level: true, power: true },
    }),
    db.achievement.findMany({
      where: { isActive: true },
      orderBy: [{ category: 'asc' }, { id: 'asc' }],
    }),
    db.playerAchievement.findMany({ where: { playerId } }),
  ])
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const unlockedMap = new Map(unlockedRows.map((r) => [r.achievementId, r.unlockedAt]))
  const needsStats = catalog.some((a) => a.metric === 'STAT')
  const stats = needsStats ? await readPlayerStats(db, playerId) : {}
  const needsBuildings = catalog.some((a) => a.metric === 'BUILDING_LEVEL')
  const buildingLevels = new Map<string, number>()
  if (needsBuildings) {
    const rows = await db.building.findMany({
      where: { city: { playerId } },
      select: { type: true, level: true },
    })
    for (const row of rows) buildingLevels.set(row.type, row.level)
  }

  const achievements: AchievementView[] = catalog.map((a) => {
    const meta =
      a.meta !== null && typeof a.meta === 'object' && !Array.isArray(a.meta)
        ? (a.meta as Record<string, unknown>)
        : {}
    const unlockedAt = unlockedMap.get(a.id)
    let progress: AchievementView['progress'] = null
    if (!unlockedAt) {
      let current: number | null = null
      switch (a.metric) {
        case 'STAT': {
          const statKey = typeof meta['statKey'] === 'string' ? meta['statKey'] : null
          if (statKey) current = stats[statKey] ?? 0
          break
        }
        case 'PLAYER_LEVEL':
          current = player.level
          break
        case 'PLAYER_POWER':
          current = Number(player.power)
          break
        case 'BUILDING_LEVEL': {
          const buildingType =
            typeof meta['buildingType'] === 'string' ? meta['buildingType'] : null
          if (buildingType) current = buildingLevels.get(buildingType) ?? 0
          break
        }
        default:
          current = null
      }
      if (current !== null) {
        progress = {
          current: Math.min(current, a.target),
          target: a.target,
          complete: current >= a.target,
        }
      }
    }
    return {
      id: a.id,
      title: a.title,
      description: a.description,
      category: a.category,
      metric: a.metric,
      target: a.target,
      reward: (a.reward as Record<string, number>) ?? {},
      progress,
      unlocked: unlockedAt !== undefined,
      unlockedAt: unlockedAt ? unlockedAt.toISOString() : null,
    }
  })

  return { achievements }
}
