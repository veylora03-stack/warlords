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
} from '@/lib/game/config/leveling'
import { enqueueNotificationInTx } from '@/lib/game/services/notification.service'
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

  // BigInt → number is safe: XP is clamped to MAX_TOTAL_XP « 2^53 by design.
  const currentXp = Number(player.xp)
  const gain = applyXpGain(currentXp, amount)
  const newXp = BigInt(gain.xp)

  await tx.player.update({
    where: { id: playerId },
    data: { xp: newXp, level: gain.level },
  })

  if (gain.leveledUp) {
    // Level-up notice rides the notification engine's queue (Phase 22) —
    // dedupe key carries the EVENT IDENTITY (player + reached level), so a
    // level can never announce twice.
    await enqueueNotificationInTx(tx, {
      playerId,
      type: LEVEL_UP_NOTIFICATION_TYPE,
      dedupeKey: notificationDedupeKeys.levelUp(playerId, gain.level),
      payload: {
        kind: 'LEVEL_UP' as const,
        level: gain.level,
        levelsGained: gain.levelsGained,
        source,
      },
    })
    log.info('player leveled up', {
      playerId,
      from: player.level,
      to: gain.level,
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
