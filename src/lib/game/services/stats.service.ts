/**
 * WARLORDS — Statistics service (typed counter store on Player.stats JSON).
 *
 * Write path: `recordPlayerStats` — append-only increments, validated against
 * the data-driven catalog (config/stats.ts). Counters NEVER decrease: negative
 * or fractional deltas are rejected (anti-tamper; "spent/lost" counters exist
 * precisely so nothing needs to go down).
 *
 * Read path: `readPlayerStats` — normalizes whatever JSON is stored against
 * the catalog: missing → 0, unknown → dropped, non-conforming → 0. A corrupt
 * or legacy blob can therefore never crash a read or smuggle fake values.
 */

import type { Tx } from './player-bootstrap.service'
import { emptyPlayerStats, STAT_KEYS } from '@/lib/game/config/stats'
import { AppError } from '@/lib/api/errors'

export type PlayerStats = Record<string, number>

export type StatDeltas = Partial<Record<string, number>>

/** Normalizes any stored JSON blob into a conforming stats record. Exported for tests. */
export function normalizeStoredStats(raw: unknown): PlayerStats {
  const stats = emptyPlayerStats()
  if (raw === null || raw === undefined) return stats
  if (typeof raw !== 'object' || Array.isArray(raw)) return stats

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!STAT_KEYS.includes(key)) continue // unknown keys are dropped
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) continue
    if (value > Number.MAX_SAFE_INTEGER) continue
    stats[key] = value
  }
  return stats
}

/** Reads and normalizes the player's statistics. Works on tx or plain db. */
export async function readPlayerStats(client: Tx, playerId: string): Promise<PlayerStats> {
  const player = await client.player.findUnique({
    where: { id: playerId },
    select: { stats: true },
  })
  if (!player) throw new AppError('PLAYER_NOT_FOUND', 'Player not found')
  return normalizeStoredStats(player.stats)
}

/**
 * Applies append-only counter increments inside the caller's transaction.
 * Deltas must be positive safe integers for catalog-known keys.
 */
export async function recordPlayerStats(
  tx: Tx,
  playerId: string,
  deltas: StatDeltas,
): Promise<PlayerStats> {
  const entries = Object.entries(deltas)
  if (entries.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Statistics delta must not be empty')
  }

  const validated: Array<[string, number]> = []
  for (const [key, value] of entries) {
    if (!STAT_KEYS.includes(key)) {
      throw new AppError('VALIDATION_ERROR', `Unknown statistic key: ${key}`)
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new AppError('INVALID_AMOUNT', `Statistic delta for ${key} must be a positive integer`)
    }
    validated.push([key, value])
  }

  const current = await readPlayerStats(tx, playerId)
  for (const [key, value] of validated) {
    current[key] = (current[key] ?? 0) + value
  }

  await tx.player.update({
    where: { id: playerId },
    data: { stats: current },
  })
  return current
}
