/**
 * WARLORDS — Quest event engine (Phase 31: Quest + Achievement Engine).
 *
 * The single consumer of real game-domain events. Owning services call
 * `applyQuestEventInTx` INSIDE the transaction that mutated game state, so
 * quest progress is atomic with the action that caused it (no partial
 * completion, no event loss on rollback, no duplicate application on
 * idempotent replays — replays short-circuit before their transaction).
 *
 * Per application (bounded, N+1-free):
 *   1. lazy-expire stale ACTIVE instances (server-clock guarded updateMany)
 *   2. assign eligible quests for the CURRENT cycle (unique-guarded
 *      createMany skipDuplicates — concurrency-safe by DB constraint)
 *   3. load the player's ACTIVE instances with their quest rows (one query)
 *   4. match → contribute → guarded update per matched quest
 *   5. completion side effects (stats counter + QUEST_COMPLETED notification)
 *
 * SECURITY: events are constructed exclusively from server-side state.
 * There is no API surface that accepts progress, completion, rewards or
 * event payloads from the client.
 *
 * Import discipline: this module MUST NOT import economy/achievement/quest
 * services (it sits below them in the dependency graph — they call it).
 */

import type { Prisma } from '@prisma/client'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import type { Tx } from './player-bootstrap.service'
import { resolveSeasonStateInTx } from './season-state.service'
import { recordPlayerStats } from './stats.service'
import { enqueueNotificationInTx } from './notification.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'
import type { QuestType } from '@/lib/game/types/common'
import {
  type QuestEvent,
  questEventKey,
  matchesObjective,
  eventContribution,
  applyContribution,
  cycleForType,
  expiresAtForType,
  summarizeReward,
} from '@/lib/game/engine/quest/progress'

const log = logger.child({ module: 'game/quest-events' })

/** Catalog projection of a quest definition (single source: DB, seeded). */
interface QuestDefinitionRow {
  id: string
  type: string
  title: string
  objectiveType: string
  objectiveTarget: Prisma.JsonValue
  reward: Prisma.JsonValue
  prerequisiteQuestIds: Prisma.JsonValue
  minLevel: number
  isActive: boolean
}

export interface QuestEventApplicationResult {
  assigned: number
  progressed: number
  completed: Array<{ questId: string; questTitle: string; cycle: string }>
}

/** Reads the objective's numeric target from its JSON blob (defensive). */
function objectiveTargetAmount(raw: Prisma.JsonValue): number {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const amount = (raw as Record<string, unknown>)['amount']
    if (typeof amount === 'number' && Number.isInteger(amount) && amount >= 1) return amount
  }
  // A definition without a positive integer amount can never progress —
  // fail closed at event time instead of seeding a lie.
  throw new AppError('INTERNAL_ERROR', 'Quest definition has an invalid objectiveTarget.amount')
}

/**
 * Assignment sweep — assigns every eligible quest lacking a CURRENT-cycle
 * row. Eligibility (server-decided): active catalog + computable cycle +
 * minLevel gate + all prerequisite quests CLAIMED. The (playerId, questId,
 * cycle) unique constraint makes concurrent sweeps idempotent.
 */
export async function ensureQuestAssignmentsInTx(
  tx: Tx,
  playerId: string,
  now: Date = new Date(),
): Promise<number> {
  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { id: true, level: true },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  const catalog = await tx.quest.findMany({ where: { isActive: true } })
  const season = await resolveSeasonStateInTx(tx, now)

  // Lazy expiry — ACTIVE past its expiresAt flips to EXPIRED.
  await tx.playerQuest.updateMany({
    where: { playerId, status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  })

  const instances = await tx.playerQuest.findMany({
    where: { playerId, questId: { in: catalog.map((q) => q.id) } },
    select: { questId: true, cycle: true, status: true },
  })
  const claimedQuestIds = new Set(
    instances.filter((i) => i.status === 'CLAIMED').map((i) => i.questId),
  )
  const existingCycleKeys = new Set(instances.map((i) => `${i.questId}:${i.cycle}`))

  const toAssign: Array<{
    playerId: string
    questId: string
    cycle: string
    target: number
    expiresAt: Date | null
  }> = []
  for (const quest of catalog) {
    const seasonForCycle = season && season.status === 'ACTIVE' ? season : null
    const cycle = cycleForType(quest.type as QuestType, now, seasonForCycle)
    if (cycle === null) continue // SEASONAL without an ACTIVE season → not assignable
    if (existingCycleKeys.has(`${quest.id}:${cycle}`)) continue
    if (quest.minLevel > player.level) continue
    const prereqIds = Array.isArray(quest.prerequisiteQuestIds)
      ? quest.prerequisiteQuestIds.filter((v): v is string => typeof v === 'string')
      : []
    if (!prereqIds.every((id) => claimedQuestIds.has(id))) continue
    toAssign.push({
      playerId,
      questId: quest.id,
      cycle,
      target: objectiveTargetAmount(quest.objectiveTarget),
      expiresAt: expiresAtForType(quest.type as QuestType, now, seasonForCycle),
    })
  }
  if (toAssign.length > 0) {
    // No skipDuplicates on this client (see notification.service fan-out) —
    // the pre-read above plus the caller's db:write mutex make the sweep
    // race-free in-process; the unique constraint is the cross-system
    // backstop and any P2002 here aborts the tx loudly (fail closed).
    await tx.playerQuest.createMany({ data: toAssign })
  }
  return toAssign.length
}

/**
 * Applies one domain event to the player's quest state inside the caller's
 * transaction. The event is trusted unconditionally because it can only be
 * constructed by server code (no route accepts quest events).
 */
export async function applyQuestEventInTx(
  tx: Tx,
  playerId: string,
  event: QuestEvent,
  now: Date = new Date(),
): Promise<QuestEventApplicationResult> {
  // ── 1) Lazy expiry + assignment (shared sweep, unique-guarded) ──────────
  const assigned = await ensureQuestAssignmentsInTx(tx, playerId, now)

  // ── 2) Progress — ACTIVE instances whose quest matches the event ────────
  const activeInstances = await tx.playerQuest.findMany({
    where: { playerId, status: 'ACTIVE' },
    include: { quest: true },
  })

  const result: QuestEventApplicationResult = { assigned, progressed: 0, completed: [] }
  const eventKey = questEventKey(event)
  const writes: Array<Promise<unknown>> = []

  for (const instance of activeInstances) {
    const quest = instance.quest as QuestDefinitionRow
    if (!quest.isActive) continue
    if (
      !matchesObjective(
        quest.objectiveType,
        quest.objectiveTarget as unknown as Record<string, unknown>,
        event,
      )
    )
      continue
    // Event-level idempotency (spec §9): an event can only ever be applied
    // once per instance — accidental double delivery (same battle id, same
    // grant reference, same clock value) is a no-op, never a double increment.
    // Legitimate new occurrences always carry a distinct event key.
    if (instance.lastEventKey === eventKey) continue

    const contribution = eventContribution(
      quest.objectiveType as Parameters<typeof eventContribution>[0],
      quest.objectiveTarget as unknown as Record<string, unknown> & { amount: unknown },
      event,
    )
    const { progress, completed } = applyContribution(
      instance.progress,
      instance.target,
      contribution,
    )

    writes.push(
      tx.playerQuest.update({
        where: { id: instance.id },
        data: {
          progress,
          lastEventKey: eventKey,
          ...(completed ? { status: 'COMPLETED', completedAt: now } : {}),
        },
      }),
    )
    result.progressed += 1

    if (completed) {
      result.completed.push({ questId: quest.id, questTitle: quest.title, cycle: instance.cycle })
      writes.push(recordPlayerStats(tx, playerId, { questsCompleted: 1 }))
      writes.push(
        enqueueNotificationInTx(tx, {
          playerId,
          type: 'QUEST_COMPLETED',
          dedupeKey: notificationDedupeKeys.questCycle(playerId, quest.id, instance.cycle),
          payload: {
            questId: quest.id,
            questName: quest.title,
            rewardSummary: summarizeReward(quest.reward),
          },
        }),
      )
    }
  }

  await Promise.all(writes)

  if (result.assigned > 0 || result.completed.length > 0) {
    log.debug('quest event applied', {
      playerId,
      kind: event.kind,
      assigned: result.assigned,
      progressed: result.progressed,
      completed: result.completed.map((c) => c.questId),
    })
  }

  return result
}

// ── Ledger activity hook (stats + quest events for credit/debit) ────────────

/** Ledger reasons that count as player-earned resources (quest EARN events). */
export const EARNED_LEDGER_REASONS = new Set([
  'BATTLE_REWARD',
  'QUEST_REWARD',
  'ACHIEVEMENT_REWARD',
  'SEASON_REWARD',
])

/** Minimal shape of an applied ledger delta (structural — no economy import). */
interface LedgerActivityEntry {
  resource: string
  appliedDelta: bigint
  skipped: boolean
}

/**
 * THE single resource-activity hook — called by the economy service at the
 * end of applyResourceDeltas, so EVERY credit/debit in the game feeds player
 * stats and quest objectives exactly once (the ledger write and the quest
 * progress share the caller's transaction; idempotent grant replays
 * short-circuit BEFORE applyResourceDeltas, so replays never re-fire it).
 *
 * Exclusions (documented):
 *   - BOOTSTRAP        — the welcome faucet is a grant, not collection
 *                        (counting it would auto-complete early objectives);
 *   - ADMIN_ADJUSTMENT — operator corrections are not gameplay.
 * Only APPLIED deltas count — a credit clamped at the resource cap
 * contributes its clamped amount, a fully-skipped one contributes nothing.
 */
export async function recordLedgerActivityInTx(
  tx: Tx,
  playerId: string,
  entries: readonly LedgerActivityEntry[],
  meta: { reason: string; refType?: string; refId?: string },
  now: Date = new Date(),
): Promise<void> {
  if (meta.reason === 'ADMIN_ADJUSTMENT' || meta.reason === 'BOOTSTRAP') return

  const earned: Record<string, number> = {}
  const spent: Record<string, number> = {}
  let earnedTotal = 0
  let spentTotal = 0
  for (const entry of entries) {
    if (entry.skipped) continue
    const n = Number(entry.appliedDelta)
    if (!Number.isSafeInteger(n) || n === 0) continue
    if (n > 0) {
      earned[entry.resource] = n
      earnedTotal += n
    } else {
      spent[entry.resource] = -n
      spentTotal += -n
    }
  }

  const writes: Array<Promise<unknown>> = []
  if (earnedTotal > 0) {
    writes.push(recordPlayerStats(tx, playerId, { resourcesCollected: earnedTotal }))
    if (EARNED_LEDGER_REASONS.has(meta.reason)) {
      writes.push(
        applyQuestEventInTx(
          tx,
          playerId,
          { kind: 'RESOURCES_EARNED', amounts: earned, sourceRef: activitySourceRef(meta) },
          now,
        ),
      )
    }
  }
  if (spentTotal > 0) {
    writes.push(recordPlayerStats(tx, playerId, { resourcesSpent: spentTotal }))
    writes.push(
      applyQuestEventInTx(
        tx,
        playerId,
        { kind: 'RESOURCES_SPENT', amounts: spent, sourceRef: activitySourceRef(meta) },
        now,
      ),
    )
  }
  await Promise.all(writes)
}

function activitySourceRef(meta: { reason: string; refType?: string; refId?: string }): string {
  return `${meta.refType ?? meta.reason}:${meta.refId ?? 'none'}`
}
