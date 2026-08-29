/**
 * WARLORDS — Player registration service.
 *
 * THE single idempotent, concurrency-safe path from an authenticated user to
 * a fully bootstrapped player (Telegram User → User → Player → City →
 * Initial Resources). Every entry point (auth first login, dev seed, future
 * admin tools) MUST go through here.
 *
 * Invariants:
 *  - DUPLICATE registration is impossible: Player.userId is UNIQUE and this
 *    service treats "row already exists" as SUCCESS (idempotent re-attach),
 *    never as an error — a retried login can never fork a second player.
 *  - CONCURRENT registration converges: two parallel transactions that both
 *    observe "no player" still cannot both insert — the UNIQUE constraint
 *    makes exactly one win; the loser catches Prisma P2002 and re-reads.
 *    Transient SQLite write contention (dev driver only) is retried with
 *    bounded backoff, so parallel Mini App logins cannot fail spuriously.
 *  - ALL-OR-NOTHING: the caller's transaction wraps the whole bootstrap —
 *    a half-created player can never exist (player-bootstrap.service).
 *
 * NEVER TRUST THE CLIENT: the player name is truncated/sanitized here, and
 * every numeric game value comes from server config, never from input.
 */

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { logger } from '@/lib/logger'
import { bootstrapPlayer, type Tx } from './player-bootstrap.service'
import { findFreeCityCoordinate } from './city-site.service'

const log = logger.child({ module: 'game/player-registration' })

export interface EnsurePlayerInput {
  userId: string
  /** Display name source (Telegram first name / username). Sanitized here. */
  name: string
}

export interface EnsurePlayerResult {
  playerId: string
  cityId: string
  /** True when THIS call created the player; false for an idempotent re-attach. */
  created: boolean
}

const PLAYER_NAME_MAX_LENGTH = 32

/** Strips control chars/whitespace noise and hard-caps the length. */
export function sanitizePlayerName(raw: string): string {
  const cleaned = raw.replace(/[\p{C}\p{Zs}]+/gu, ' ').trim()
  return cleaned.slice(0, PLAYER_NAME_MAX_LENGTH) || 'Warlord'
}

/** Transient write-contention errors (SQLite dev driver) worth retrying. */
export function isTransientWriteError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P1008') {
    // Transaction socket timeout — always caused by write-lock queuing here.
    return true
  }
  const message = err instanceof Error ? err.message : String(err)
  return (
    /database is locked/i.test(message) ||
    /SQLITE_BUSY/i.test(message) ||
    /database table is locked/i.test(message)
  )
}

/** True for Prisma unique-constraint violations (P2002). */
export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

const RETRY_DELAYS_MS = [25, 50, 100, 200, 400]

/**
 * Registration transactions queue behind SQLite's single writer, so the
 * Prisma defaults (maxWait 2s / timeout 5s) are too tight under bursts of
 * first logins. Generous bounds + the in-process lock below make parallel
 * signups deterministic.
 */
export const REGISTRATION_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

// ── In-process registration lock ─────────────────────────────────────────────
// Serializes registration-class transactions within this server process so
// concurrent Mini App signups queue instead of fighting over the SQLite
// write lock (P1008/BUSY). Cross-process contention is still covered by the
// DB UNIQUE constraints + withWriteRetry (PostgreSQL production path).

let registrationQueue: Promise<unknown> = Promise.resolve()

export function withRegistrationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = registrationQueue.then(fn, fn)
  // Keep the chain alive regardless of this run's outcome.
  registrationQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Bounded retry wrapper. Retries while `isRetryable(err)` holds (plus transient
 * SQLite write contention, always) — logic errors are rethrown untouched.
 * Registration flows use this so parallel Mini App logins converge instead of
 * failing spuriously; PostgreSQL does not need the transient arm.
 */
export async function withWriteRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (err: unknown) => boolean = () => false,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      const retryable = isTransientWriteError(err) || isRetryable(err)
      if (attempt === RETRY_DELAYS_MS.length || !retryable) throw err
      const delay = RETRY_DELAYS_MS[attempt]!
      log.warn('write retry after transient contention', {
        attempt: attempt + 1,
        delayMs: delay,
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

async function readPlayerByUserId(tx: Tx, userId: string) {
  return tx.player.findUnique({
    where: { userId },
    include: { city: { select: { id: true } } },
  })
}

/**
 * Idempotently guarantees the user has a player. Safe to call on EVERY login:
 * existing players short-circuit to a single read; new players are created
 * with the full bootstrap inside the caller's transaction.
 */
export async function ensurePlayer(tx: Tx, input: EnsurePlayerInput): Promise<EnsurePlayerResult> {
  // NOTE: runs as a callback INSIDE the caller's transaction. Errors bubble
  // to the tx-level wrappers (runRegistrationTransaction / issueSession)
  // which retry the WHOLE transaction cleanly — never retry in a dead tx here.

  // 1) Fast path — player already exists (the overwhelmingly common case).
  const existing = await readPlayerByUserId(tx, input.userId)
  if (existing) {
    return {
      playerId: existing.id,
      cityId: existing.city?.id ?? '',
      created: false,
    }
  }

  // 2) Registration path — full bootstrap in the caller's transaction.
  const name = sanitizePlayerName(input.name)
  const city = await findFreeCityCoordinate(tx)
  try {
    const bootstrapped = await bootstrapPlayer(tx, {
      userId: input.userId,
      name,
      city,
    })
    log.info('player registered', { userId: input.userId, playerId: bootstrapped.playerId })
    return { playerId: bootstrapped.playerId, cityId: bootstrapped.cityId, created: true }
  } catch (err) {
    // 3) Concurrent registration lost the UNIQUE race INSIDE this tx —
    //    the winner's row is visible here → re-attach to it (idempotent).
    //    A commit-time conflict is NOT caught (nothing is visible in this
    //    dead tx); it bubbles to the caller's tx-level retry instead.
    if (isUniqueConstraintError(err)) {
      const winner = await readPlayerByUserId(tx, input.userId)
      if (winner) {
        log.info('player registration converged after concurrent insert', {
          userId: input.userId,
          playerId: winner.id,
        })
        return { playerId: winner.id, cityId: winner.city?.id ?? '', created: false }
      }
    }
    throw err
  }
}

/**
 * Concurrency-hardened wrapper for whole registration transactions:
 * in-process lock (no SQLite write-lock queuing) → generous tx bounds →
 * bounded retry for the rare cross-process unique race (PostgreSQL path).
 */
export async function runRegistrationTransaction<T>(run: (tx: Tx) => Promise<T>): Promise<T> {
  return withRegistrationLock(() =>
    withWriteRetry(() => db.$transaction(run, REGISTRATION_TX_OPTIONS), isUniqueConstraintError),
  )
}
