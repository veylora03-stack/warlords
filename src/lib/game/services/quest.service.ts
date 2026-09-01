/**
 * WARLORDS — Quest service (Phase 31: Quest + Achievement Engine).
 *
 * Player-facing quest board + the claim pipeline. All state transitions are
 * server-authoritative:
 *   - progress: ONLY via quest events applied inside the transactions of
 *     real game actions (quest-events.service) — there is no client-write
 *     surface for progress, completion or rewards anywhere.
 *   - claim: objective reached → COMPLETED (reward becomes claimable) → the
 *     player claims → a guarded status transition (updateMany on
 *     status=COMPLETED, count===1) is the DB-level exactly-once arbiter →
 *     the reward flows through the Economy/Ledger (QUEST_REWARD) + existing
 *     progression (XP) + the honor column — ONE transaction, rollback-safe.
 *
 * Cycle model: MAIN/ACHIEVEMENT/CLAN/EVENT quests are permanent (cycle '0');
 * DAILY resets at UTC midnight, WEEKLY at UTC Monday 00:00, SEASONAL binds
 * to the ACTIVE season and expires at season end. Completed-but-unclaimed
 * DAILY/WEEKLY rewards remain claimable (player-friendly, documented);
 * SEASONAL unclaimed rewards EXPIRE at the boundary (spec §18 decision).
 */

import { Prisma } from '@prisma/client'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { db, dbWrite } from '@/lib/db'
import { grantResources, runEconomyTransaction, getWalletBalances } from './economy.service'
import { grantXp } from './progression.service'
import { ensureQuestAssignmentsInTx } from './quest-events.service'
import { recordAdminAuditInTx } from './admin/admin-audit.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import type { QuestType } from '@/lib/game/types/common'
import { splitReward, summarizeReward } from '@/lib/game/engine/quest/progress'
import type { EconomyResource } from '@/lib/game/config/economy'

const log = logger.child({ module: 'game/quests' })

// ── Read model ───────────────────────────────────────────────────────────────

export interface QuestInstanceView {
  instanceId: string
  cycle: string
  status: 'ACTIVE' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED'
  progress: number
  target: number
  claimable: boolean
  assignedAt: string
  expiresAt: string | null
  completedAt: string | null
  claimedAt: string | null
}

export interface QuestBoardEntry {
  id: string
  type: QuestType
  title: string
  description: string
  objectiveType: string
  objectiveTarget: Record<string, unknown>
  reward: Record<string, number>
  minLevel: number
  prerequisiteQuestIds: string[]
  sortOrder: number
  /** Present when the player has an instance for the quest's current cycle. */
  instance: QuestInstanceView | null
  /** Server-side eligibility verdict for this cycle (locked quests show why). */
  eligibility:
    | { eligible: true }
    | { eligible: false; reason: 'INACTIVE' | 'MIN_LEVEL' | 'PREREQUISITES' | 'NO_ACTIVE_SEASON' }
}

export interface QuestBoardView {
  quests: QuestBoardEntry[]
  counts: { active: number; completed: number; claimable: number; claimed: number; expired: number }
}

function asRecord(raw: Prisma.JsonValue): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/**
 * Full quest board: lazily expires stale instances, assigns due quests
 * (unique-guarded), then projects the catalog + the player's instances.
 */
export async function getQuestBoardView(playerId: string): Promise<QuestBoardView> {
  await runEconomyTransaction(playerId, async (tx) => {
    await ensureQuestAssignmentsInTx(tx, playerId)
    return true
  })

  const [player, catalog, instances] = await Promise.all([
    db.player.findUnique({ where: { id: playerId }, select: { level: true } }),
    db.quest.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    db.playerQuest.findMany({
      where: { playerId },
      orderBy: [{ assignedAt: 'desc' }],
    }),
  ])
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const claimed = new Set(instances.filter((i) => i.status === 'CLAIMED').map((i) => i.questId))
  // Latest instance per quest (instances are ordered assignedAt desc).
  const latestByQuest = new Map<string, (typeof instances)[number]>()
  for (const instance of instances) {
    if (!latestByQuest.has(instance.questId)) latestByQuest.set(instance.questId, instance)
  }

  const quests: QuestBoardEntry[] = catalog.map((quest) => {
    const instance = latestByQuest.get(quest.id)
    const prereqIds = Array.isArray(quest.prerequisiteQuestIds)
      ? quest.prerequisiteQuestIds.filter((v): v is string => typeof v === 'string')
      : []

    let eligibility: QuestBoardEntry['eligibility'] = { eligible: true }
    if (!quest.isActive) {
      eligibility = { eligible: false, reason: 'INACTIVE' }
    } else if (quest.minLevel > player.level) {
      eligibility = { eligible: false, reason: 'MIN_LEVEL' }
    } else if (!prereqIds.every((id) => claimed.has(id))) {
      eligibility = { eligible: false, reason: 'PREREQUISITES' }
    }

    return {
      id: quest.id,
      type: quest.type as QuestType,
      title: quest.title,
      description: quest.description,
      objectiveType: quest.objectiveType,
      objectiveTarget: asRecord(quest.objectiveTarget),
      reward: asRecord(quest.reward) as Record<string, number>,
      minLevel: quest.minLevel,
      prerequisiteQuestIds: prereqIds,
      sortOrder: quest.sortOrder,
      instance: instance
        ? {
            instanceId: instance.id,
            cycle: instance.cycle,
            status: instance.status as QuestInstanceView['status'],
            progress: instance.progress,
            target: instance.target,
            claimable: instance.status === 'COMPLETED',
            assignedAt: instance.assignedAt.toISOString(),
            expiresAt: instance.expiresAt ? instance.expiresAt.toISOString() : null,
            completedAt: instance.completedAt ? instance.completedAt.toISOString() : null,
            claimedAt: instance.claimedAt ? instance.claimedAt.toISOString() : null,
          }
        : null,
      eligibility,
    }
  })

  const counts = { active: 0, completed: 0, claimable: 0, claimed: 0, expired: 0 }
  for (const entry of quests) {
    if (!entry.instance) continue
    if (entry.instance.status === 'ACTIVE') counts.active += 1
    else if (entry.instance.status === 'COMPLETED') {
      counts.completed += 1
      counts.claimable += 1
    } else if (entry.instance.status === 'CLAIMED') counts.claimed += 1
    else if (entry.instance.status === 'EXPIRED') counts.expired += 1
  }

  return { quests, counts }
}

export interface QuestDetailView {
  quest: QuestBoardEntry
}

export async function getQuestDetailView(
  playerId: string,
  questId: string,
): Promise<QuestDetailView> {
  const board = await getQuestBoardView(playerId)
  const quest = board.quests.find((q) => q.id === questId)
  if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')
  return { quest }
}

// ── Claim pipeline ───────────────────────────────────────────────────────────

export interface QuestClaimResult {
  questId: string
  title: string
  cycle: string
  reward: Record<string, number>
  wallet: Record<string, string>
}

/**
 * Claims the reward of the OLDEST completed-but-unclaimed instance of the
 * quest. Exactly-once: the guarded status transition (where status is still
 * COMPLETED) commits with the reward grants in ONE economy transaction —
 * concurrent claims serialize on the status flip; the loser gets a typed 409.
 */
export async function claimQuest(playerId: string, questId: string): Promise<QuestClaimResult> {
  return runEconomyTransaction(playerId, async (tx) => {
    const now = new Date()

    const quest = await tx.quest.findUnique({ where: { id: questId } })
    if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')

    // Player must own at least one instance — no cross-player claims ever.
    const instances = await tx.playerQuest.findMany({
      where: { playerId, questId },
      orderBy: [{ assignedAt: 'asc' }],
    })
    if (instances.length === 0) {
      throw new AppError('QUEST_NOT_FOUND', 'Quest has not been assigned to you')
    }

    const completed = instances.find((i) => i.status === 'COMPLETED')
    if (!completed) {
      const claimedInstance = instances.find((i) => i.status === 'CLAIMED')
      if (claimedInstance && !instances.some((i) => i.status === 'ACTIVE')) {
        throw new AppError('QUEST_ALREADY_CLAIMED', 'Quest reward has already been claimed')
      }
      if (instances.some((i) => i.status === 'ACTIVE')) {
        throw new AppError('QUEST_NOT_COMPLETED', 'Quest objective is not yet reached')
      }
      throw new AppError('QUEST_EXPIRED', 'No claimable quest instance remains')
    }

    // Seasonal rewards expire at the season boundary (spec §18 decision).
    if (completed.expiresAt && completed.expiresAt.getTime() <= now.getTime()) {
      throw new AppError('QUEST_EXPIRED', 'This quest reward expired with its season')
    }

    // Guarded transition — the exactly-once arbiter. count===0 means a
    // concurrent claim won the race; this request reports ALREADY_CLAIMED.
    const claim = await tx.playerQuest.updateMany({
      where: { id: completed.id, status: 'COMPLETED' },
      data: { status: 'CLAIMED', claimedAt: now },
    })
    if (claim.count !== 1) {
      throw new AppError('QUEST_ALREADY_CLAIMED', 'Quest reward has already been claimed')
    }

    // ── Reward payout (same transaction — rollback reverts the flip too) ──
    const split = splitReward(quest.reward)
    if (split.unsupported.length > 0) {
      // Fail CLOSED: a reward must never silently shrink.
      throw new AppError(
        'QUEST_REWARD_INVALID',
        `Quest ${quest.id} declares unsupported reward keys: ${split.unsupported.join(', ')}`,
      )
    }

    const walletEntries = Object.entries(split.wallet) as Array<[EconomyResource, number]>
    if (walletEntries.length > 0) {
      const amounts = Object.fromEntries(
        walletEntries.map(([resource, amount]) => [resource, BigInt(amount)]),
      ) as Partial<Record<EconomyResource, bigint>>
      await grantResources(tx, playerId, amounts, {
        reason: 'QUEST_REWARD',
        refType: 'quest',
        refId: quest.id,
        idempotencyKey: `quest_claim:${playerId}:${quest.id}:${completed.cycle}`,
      })
    }

    if (split.xp > 0) {
      await grantXp(tx, { playerId, amount: split.xp, source: 'quest' })
    }

    if (split.honor > 0) {
      await tx.player.update({
        where: { id: playerId },
        data: { honor: { increment: BigInt(split.honor) } },
      })
    }

    await enqueueNotificationInTx(tx, {
      playerId,
      type: 'REWARD',
      dedupeKey: notificationDedupeKeys.questClaim(playerId, quest.id, completed.cycle),
      payload: {
        rewardTitle: `Reward claimed — ${quest.title}`,
        rewardBody: summarizeReward(quest.reward) ?? 'Your reward has been delivered.',
      },
    })

    const balances = await getWalletBalances(tx, playerId)

    log.info('quest reward claimed', { playerId, questId: quest.id, cycle: completed.cycle })

    return {
      questId: quest.id,
      title: quest.title,
      cycle: completed.cycle,
      reward: asRecord(quest.reward) as Record<string, number>,
      wallet: Object.fromEntries(
        Object.entries(balances).map(([resource, amount]) => [resource, amount.toString()]),
      ),
    }
  })
}

// ── Admin operations (RBAC-guarded at the route; audited here) ───────────────

export interface AdminQuestToggleInput {
  actorUserId: string
  questId: string
  isActive: boolean
  ip?: string
  reason?: string
}

export async function adminSetQuestActive(
  input: AdminQuestToggleInput,
): Promise<{ id: string; isActive: boolean }> {
  return dbWrite.$transaction(async (tx) => {
    const quest = await tx.quest.findUnique({ where: { id: input.questId } })
    if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')
    const before = { isActive: quest.isActive }
    const updated = await tx.quest.update({
      where: { id: quest.id },
      data: { isActive: input.isActive },
      select: { id: true, isActive: true },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'quest.set_active',
      targetType: 'quest',
      targetId: quest.id,
      before,
      after: { isActive: input.isActive },
      reason: input.reason,
      ip: input.ip,
    })
    log.info('admin quest toggled', { questId: quest.id, isActive: input.isActive })
    return updated
  })
}

export interface AdminPlayerQuestResetInput {
  actorUserId: string
  playerId: string
  questId: string
  /** Omit to reset EVERY cycle of the quest for the player. */
  cycle?: string
  ip?: string
  reason?: string
}

/** Deletes the player's quest instance(s) — the quest can re-assign cleanly. */
export async function adminResetPlayerQuest(
  input: AdminPlayerQuestResetInput,
): Promise<{ deleted: number }> {
  return dbWrite.$transaction(async (tx) => {
    const quest = await tx.quest.findUnique({ where: { id: input.questId } })
    if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')
    const player = await tx.player.findUnique({
      where: { id: input.playerId },
      select: { id: true },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

    const deleted = await tx.playerQuest.deleteMany({
      where: {
        playerId: input.playerId,
        questId: input.questId,
        ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
      },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'quest.reset_player_quest',
      targetType: 'player_quest',
      targetId: `${input.playerId}:${input.questId}${input.cycle !== undefined ? `:${input.cycle}` : ''}`,
      before: { instances: deleted.count },
      after: { instances: 0 },
      reason: input.reason,
      ip: input.ip,
    })
    log.info('admin player quest reset', {
      playerId: input.playerId,
      questId: input.questId,
      deleted: deleted.count,
    })
    return { deleted: deleted.count }
  })
}

export interface AdminPlayerQuestGrantInput {
  actorUserId: string
  playerId: string
  questId: string
  ip?: string
  reason?: string
}

/**
 * Marks the player's current instance COMPLETED (reward still flows through
 * the normal claim — no unsafe reward injection). Assigns the quest first if
 * the player has no current-cycle instance.
 */
export async function adminGrantQuestCompletion(
  input: AdminPlayerQuestGrantInput,
): Promise<{ questId: string; instanceId: string }> {
  return dbWrite.$transaction(async (tx) => {
    const now = new Date()
    const quest = await tx.quest.findUnique({ where: { id: input.questId } })
    if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')
    const player = await tx.player.findUnique({
      where: { id: input.playerId },
      select: { id: true },
    })
    if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

    await ensureQuestAssignmentsInTx(tx, input.playerId, now)
    const instance = await tx.playerQuest.findFirst({
      where: { playerId: input.playerId, questId: input.questId, status: 'ACTIVE' },
      orderBy: { assignedAt: 'desc' },
    })
    if (!instance) {
      throw new AppError(
        'QUEST_NOT_COMPLETED',
        'Quest has no ACTIVE instance to complete (check eligibility/cycle)',
      )
    }
    await tx.playerQuest.update({
      where: { id: instance.id },
      data: {
        status: 'COMPLETED',
        completedAt: now,
        progress: instance.target,
        lastEventKey: 'ADMIN_GRANT',
      },
    })
    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'quest.grant_completion',
      targetType: 'player_quest',
      targetId: `${input.playerId}:${input.questId}:${instance.cycle}`,
      before: { status: instance.status, progress: instance.progress },
      after: { status: 'COMPLETED', progress: instance.target },
      reason: input.reason,
      ip: input.ip,
    })
    log.info('admin quest completion granted', {
      playerId: input.playerId,
      questId: input.questId,
    })
    return { questId: quest.id, instanceId: instance.id }
  })
}

export interface AdminPlayerQuestRevokeInput {
  actorUserId: string
  playerId: string
  questId: string
  ip?: string
  reason?: string
}

/**
 * Revokes a completed-but-UNclaimed instance (deletes it). A CLAIMED
 * instance is refused — granted rewards are NEVER clawed back silently
 * (an operator who needs that path has the audited resource-adjustment tool).
 */
export async function adminRevokeQuestCompletion(
  input: AdminPlayerQuestRevokeInput,
): Promise<{ revoked: boolean }> {
  return dbWrite.$transaction(async (tx) => {
    const quest = await tx.quest.findUnique({ where: { id: input.questId } })
    if (!quest) throw new AppError('QUEST_NOT_FOUND', 'Quest not found')

    const instance = await tx.playerQuest.findFirst({
      where: { playerId: input.playerId, questId: input.questId, status: 'COMPLETED' },
      orderBy: { assignedAt: 'desc' },
    })
    if (!instance) {
      throw new AppError(
        'QUEST_NOT_COMPLETED',
        'No completed-but-unclaimed instance exists (claimed rewards are never revoked)',
      )
    }
    await tx.playerQuest.delete({ where: { id: instance.id } })
    await recordAdminAuditInTx(tx, {
      actorUserId: input.actorUserId,
      action: 'quest.revoke_completion',
      targetType: 'player_quest',
      targetId: `${input.playerId}:${input.questId}:${instance.cycle}`,
      before: { status: 'COMPLETED', progress: instance.progress },
      after: { status: 'DELETED' },
      reason: input.reason,
      ip: input.ip,
    })
    log.info('admin quest completion revoked', {
      playerId: input.playerId,
      questId: input.questId,
    })
    return { revoked: true }
  })
}
