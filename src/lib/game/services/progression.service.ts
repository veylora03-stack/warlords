/**
 * WARLORDS — Progression service (XP / Level write path).
 *
 * THE single server-side way XP enters the system. Future grantors (quest
 * claims, battle resolution, events, admin tools) all call `grantXp` inside
 * their transaction — the client can NEVER submit an XP amount.
 *
 * Level state is DERIVED from total XP via the data-driven curve
 * (config/leveling.ts): the `level` column is a projection, `xp` is the
 * authority. Level-ups emit an outbox notification in the same transaction.
 */

import type { Tx } from './player-bootstrap.service'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import {
  applyXpGain,
  LEVELING,
  MAX_TOTAL_XP,
  resolveLevelProgress,
  type XpGainResult,
} from '@/lib/game/config/leveling'
import { enqueueNotificationInTx } from '@/lib/game/services/notification.service'
import { applyQuestEventInTx } from './quest-events.service'
import { notificationDedupeKeys } from '@/lib/game/config/notifications'

const log = logger.child({ module: 'game/progression' })

/** Notification type used for level-ups (see common.ts NOTIFICATION_TYPES). */
const LEVEL_UP_NOTIFICATION_TYPE = 'RANK_CHANGE'

export interface GrantXpInput {
  playerId: string
  /** Positive safe integer. Sources pass catalog values — never client input. */
  amount: number
  /** Audit marker persisted in the level-up notification + logs. */
  source: string
}

export interface GrantXpResult {
  xp: number
  level: number
  levelsGained: number
  leveledUp: boolean
  atMaxLevel: boolean
}

/**
 * Grants XP inside the caller's transaction and derives the new level.
 * Throws INVALID_AMOUNT for non-positive/non-integer/overflowing amounts —
 * callers must never pass raw client values.
 */
export async function grantXp(tx: Tx, input: GrantXpInput): Promise<GrantXpResult> {
  const { amount, playerId, source } = input
  if (!Number.isInteger(amount) || amount <= 0 || amount > Number.MAX_SAFE_INTEGER) {
    throw new AppError('INVALID_AMOUNT', 'XP amount must be a positive safe integer', {
      source,
    })
  }

  const player = await tx.player.findUnique({
    where: { id: playerId },
    select: { id: true, xp: true, level: true, name: true },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')

  // SECURITY (Phase 23): the xp/level write is a compare-and-set on the
  // previously-read xp — a concurrent grantor can no longer be lost by a
  // last-write-wins over the whole column. Each retry re-derives the level
  // from the FRESH xp (the curve is a pure function of xp), so the final
  // state and the level-up event reflect the actually-reached level.
  // Bounded re-read/retry; exhaustion aborts the caller's transaction with
  // a typed retry-safe 409.
  const XP_CAS_MAX_ATTEMPTS = 8
  let currentXp = Number(player.xp)
  let levelBefore = player.level
  let appliedGain: XpGainResult | null = null
  for (let attempt = 0; attempt < XP_CAS_MAX_ATTEMPTS; attempt++) {
    const gain = applyXpGain(currentXp, amount)
    const guard = await tx.player.updateMany({
      where: { id: playerId, xp: BigInt(currentXp) },
      data: { xp: BigInt(gain.xp), level: gain.level },
    })
    if (guard.count === 1) {
      appliedGain = gain
      break
    }
    const fresh = await tx.player.findUnique({
      where: { id: playerId },
      select: { xp: true, level: true },
    })
    if (!fresh) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
    currentXp = Number(fresh.xp)
    levelBefore = fresh.level
  }
  if (!appliedGain) {
    throw new AppError(
      'PROGRESSION_CONFLICT',
      'Progression is under heavy contention — retry the operation',
    )
  }
  const gain = appliedGain
  const newLevel = gain.level

  if (gain.leveledUp) {
    // Quest event (Phase 31): REACH_LEVEL objectives consume the new level
    // (SET mode — monotonic) inside the same transaction as the grant.
    await applyQuestEventInTx(tx, playerId, { kind: 'LEVEL_REACHED', level: newLevel })

    // Level-up notice rides the notification engine's queue (Phase 22) —
    // dedupe key carries the EVENT IDENTITY (player + reached level), so a
    // level can never announce twice.
    await enqueueNotificationInTx(tx, {
      playerId,
      type: LEVEL_UP_NOTIFICATION_TYPE,
      dedupeKey: notificationDedupeKeys.levelUp(playerId, newLevel),
      payload: {
        kind: 'LEVEL_UP' as const,
        level: newLevel,
        levelsGained: gain.levelsGained,
        source,
      },
    })
    log.info('player leveled up', {
      playerId,
      from: levelBefore,
      to: newLevel,
      source,
    })
  }

  return {
    xp: gain.xp,
    level: gain.level,
    levelsGained: gain.levelsGained,
    leveledUp: gain.leveledUp,
    atMaxLevel: gain.atMaxLevel,
  }
}

/**
 * Read-side projection of the player's progression from the authoritative
 * `xp` column (never trusts the stored `level` for display math).
 */
export function readLevelProgress(totalXp: bigint | number) {
  return resolveLevelProgress(Number(totalXp))
}

/** Exposed for services/tests that need the cap without importing config. */
export const XP_CAPS = { maxLevel: LEVELING.maxLevel, maxTotalXp: MAX_TOTAL_XP } as const
