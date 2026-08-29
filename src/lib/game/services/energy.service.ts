/**
 * WARLORDS — Energy service (lazy-tick regeneration).
 *
 * No timers, no cron: every read of a player's energy resolves the elapsed
 * regeneration from `energyUpdatedAt` via the pure config function and
 * persists ONLY when something actually changed. This keeps the pool exact
 * under arbitrary gaps between requests (offline hours count, partial ticks
 * carry, the cap never accumulates).
 */

import type { PrismaClient } from '@prisma/client'
import type { Tx } from './player-bootstrap.service'
import { computeEnergyState, ENERGY } from '@/lib/game/config/energy'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'

const log = logger.child({ module: 'game/energy' })

export interface SyncedEnergy {
  energy: number
  max: number
  energyUpdatedAt: Date
  /** Epoch ms of the next point (null at cap). Exposed for UI countdowns. */
  nextRegenAtMs: number | null
}

type EnergyClient = Tx | Pick<PrismaClient, 'player'>

/**
 * Resolves and (when changed) persists the player's current energy.
 * Safe to call on every read — the common case is a single SELECT.
 */
export async function syncPlayerEnergy(
  client: EnergyClient,
  playerId: string,
  now: Date = new Date(),
): Promise<SyncedEnergy> {
  const player = await client.player.findUnique({
    where: { id: playerId },
    select: { energy: true, energyUpdatedAt: true },
  })
  if (!player) {
    throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  }

  const state = computeEnergyState(
    { energy: player.energy, energyUpdatedAt: player.energyUpdatedAt },
    now,
  )

  if (state.changed) {
    await client.player.update({
      where: { id: playerId },
      data: { energy: state.energy, energyUpdatedAt: state.energyUpdatedAt },
    })
    log.debug('energy regenerated', { playerId, energy: state.energy })
  }

  return {
    energy: state.energy,
    max: ENERGY.max,
    energyUpdatedAt: state.energyUpdatedAt,
    nextRegenAtMs: state.nextRegenAtMs,
  }
}
