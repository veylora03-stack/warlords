/**
 * WARLORDS — Season state leaf (Phase 31 extraction).
 *
 * The season state machine (UPCOMING → ACTIVE → FINISHED against the server
 * clock) lives here as a DEPENDENCY-FREE leaf module so any service can
 * resolve the current season without creating service-layer import cycles
 * (quest-events.service needs it; season.service itself and the settlement
 * service re-use it unchanged — behavior is byte-for-byte the Phase 20
 * implementation, only relocated).
 */

import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import type { Tx } from './player-bootstrap.service'

const log = logger.child({ module: 'game/season-state' })

export type SeasonStatus = 'UPCOMING' | 'ACTIVE' | 'FINISHED'

export interface SeasonRow {
  id: string
  number: number
  name: string
  startsAt: Date
  endsAt: Date
  status: string
  settledAt: Date | null
  config: unknown
}

/** Applies the server-clock state machine to the CURRENT season row (if any). */
export async function resolveSeasonStateInTx(tx: Tx, now = new Date()): Promise<SeasonRow | null> {
  const current = (await tx.season.findFirst({
    orderBy: { number: 'desc' },
  })) as SeasonRow | null
  if (!current) return null

  if (current.status === 'UPCOMING' && current.startsAt.getTime() <= now.getTime()) {
    await tx.season.updateMany({
      where: { id: current.id, status: 'UPCOMING' },
      data: { status: 'ACTIVE' },
    })
    current.status = 'ACTIVE'
    log.info('season activated by scheduler', { seasonNumber: current.number })
  }

  if (current.status === 'ACTIVE' && current.endsAt.getTime() <= now.getTime()) {
    await tx.season.updateMany({
      where: { id: current.id, status: 'ACTIVE' },
      data: { status: 'FINISHED' },
    })
    current.status = 'FINISHED'
    log.info('season finished by scheduler (awaiting settlement)', {
      seasonNumber: current.number,
    })
  }

  return current
}

/**
 * READ-PATH season resolution — no interactive transaction.
 *
 * Rationale (Phase 25): Prisma's SQLite interactive transactions run
 * `BEGIN IMMEDIATE`, taking the database's RESERVED (write) lock — so
 * wrapping a pure read projection in `$transaction` serializes EVERY such
 * read behind the single global writer. The clock transitions here are
 * guarded conditional `updateMany` statements, which are atomic on their
 * own; losing the race to another process just means re-reading the row.
 * Transactional callers (awardSeasonPointsInTx, settlement) keep using
 * `resolveSeasonStateInTx` inside their existing transaction.
 */
export async function resolveSeasonState(now = new Date()): Promise<SeasonRow | null> {
  const current = (await db.season.findFirst({
    orderBy: { number: 'desc' },
  })) as SeasonRow | null
  if (!current) return null

  const transition = async (
    from: string,
    to: 'ACTIVE' | 'FINISHED',
    message: string,
  ): Promise<boolean> => {
    const claim = await db.season.updateMany({
      where: { id: current.id, status: from },
      data: { status: to },
    })
    if (claim.count === 1) {
      current.status = to
      log.info(message, { seasonNumber: current.number })
      return true
    }
    // Another process flipped it first — adopt the authoritative row.
    const fresh = (await db.season.findUnique({ where: { id: current.id } })) as SeasonRow | null
    if (fresh) current.status = fresh.status
    return false
  }

  if (current.status === 'UPCOMING' && current.startsAt.getTime() <= now.getTime()) {
    await transition('UPCOMING', 'ACTIVE', 'season activated by scheduler')
  }
  if (current.status === 'ACTIVE' && current.endsAt.getTime() <= now.getTime()) {
    await transition('ACTIVE', 'FINISHED', 'season finished by scheduler (awaiting settlement)')
  }

  return current
}
