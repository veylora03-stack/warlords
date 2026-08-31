/**
 * WARLORDS — Session service (AUTHENTICATION.md Flow A/B implementation).
 *
 * Responsibilities:
 *  - exchangeInitData: verify initData → tx { upsert user → ban check →
 *    replay resolution → session row → player bootstrap on first login } →
 *    mint JWT. One transaction for every write (sensitive-operation rule).
 *  - exchangeDevImpersonation: env-guarded, allowlisted, audited dev login.
 *  - authenticate: bearer/cookie → JWT verify → session row (revocation +
 *    token-hash authority) → ban check. DB is the source of truth for role
 *    and ban state on EVERY request.
 *  - Optional sliding refresh: sessions nearing expiry get a fresh token.
 *
 * Security invariants (see SECURITY.md §1):
 *  - raw initData and raw tokens are never persisted — sha256 digests only
 *  - a replayed initData re-attaches to the SAME session row and rotates its
 *    token (no session farming, old token invalid immediately, retry-safe)
 *  - logging out revokes the row; the stolen-token window is the initData
 *    freshness bound (TELEGRAM_AUTH_MAX_AGE_SECONDS), a Telegram design limit
 */

import { randomUUID } from 'node:crypto'
import { db, dbWrite } from '@/lib/db'
import { AppError } from '@/lib/api/errors'
import { logger } from '@/lib/logger'
import { verifyInitData, type TelegramInitDataUser } from '@/lib/telegram'
import {
  ensurePlayer,
  isUniqueConstraintError,
  withWriteRetry,
  withRegistrationLock,
  REGISTRATION_TX_OPTIONS,
} from '@/lib/game/services/player-registration.service'
import type { Env } from '@/config/env'
import { mintSessionToken, verifySessionToken, type SessionClaims } from './jwt'
import { sha256Hex, safeDigestEqual } from './hash'
import { readSessionToken } from './cookies'
import type { AuthConfig } from './session.config'
import { SESSION_REFRESH_THRESHOLD_SECONDS } from './session.config'
import type {
  AuthPrincipal,
  AuthUserProfile,
  ExchangeInput,
  ExchangeResult,
  RefreshedSession,
} from './session.types'

const log = logger.child({ module: 'auth' })

/** Internal retry signal: a concurrent registration raced this transaction. */
class RegistrationRaceError extends Error {
  constructor() {
    super('concurrent player registration raced this session transaction')
  }
}

// ── Shared internals ─────────────────────────────────────────────────────────

function toUserProfile(user: {
  id: string
  telegramId: string
  username: string | null
  firstName: string
  lastName: string | null
  photoUrl: string | null
  role: string
}): AuthUserProfile {
  return {
    id: user.id,
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    role: user.role,
  }
}

function assertNotBanned(user: {
  telegramId: string
  isBanned: boolean
  banReason: string | null
  banExpiresAt: Date | null
}): void {
  if (!user.isBanned) return
  const now = new Date()
  if (user.banExpiresAt && user.banExpiresAt.getTime() <= now.getTime()) return // temp ban elapsed

  const details: Record<string, string> = {}
  if (user.banReason) details['reason'] = user.banReason
  if (user.banExpiresAt) details['banExpiresAt'] = user.banExpiresAt.toISOString()
  log.warn('auth banned login rejected', { telegramId: user.telegramId })
  throw new AppError('BANNED', 'This account is banned', details)
}

interface IssueSessionArgs {
  cfg: AuthConfig
  telegramId: string
  telegramAuthDate: Date
  initDataHash: string
  ip?: string
  userAgent?: string
  /** Present for real initData exchanges; absent for dev impersonation. */
  profile?: TelegramInitDataUser
  /** Extra audit trail (dev impersonation). */
  audit?: { action: string; reason: string }
}

/**
 * The transactional core shared by initData exchange and dev impersonation.
 * Creates/updates the user, resolves replay, creates the session row and
 * bootstraps the player on first login — all or nothing.
 */
async function issueSession(args: IssueSessionArgs): Promise<ExchangeResult> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + args.cfg.sessionTtlSeconds * 1000)

  const result = await withRegistrationLock(() =>
    withWriteRetry(
      () =>
        dbWrite
          .$transaction(async (tx) => {
            // 1) Identity upsert — telegramId is THE identity; username is display-only.
            const user = await tx.user.upsert({
              where: { telegramId: args.telegramId },
              create: {
                telegramId: args.telegramId,
                firstName: args.profile?.firstName ?? 'Warlord',
                lastName: args.profile?.lastName,
                username: args.profile?.username,
                languageCode: args.profile?.languageCode ?? 'en',
                photoUrl: args.profile?.photoUrl,
                lastLoginAt: now,
              },
              update: {
                firstName: args.profile?.firstName,
                lastName: args.profile?.lastName ?? null,
                username: args.profile?.username ?? null,
                languageCode: args.profile?.languageCode,
                photoUrl: args.profile?.photoUrl ?? null,
                lastLoginAt: now,
              },
              include: { player: true },
            })

            // 2) Ban enforcement at the gate (tx rolls back everything above on throw).
            assertNotBanned(user)

            // 3) Housekeeping: drop this user's expired session rows.
            await tx.authSession.deleteMany({
              where: { userId: user.id, expiresAt: { lte: now } },
            })

            // 4) Replay resolution — one live session per initData.
            const existing = await tx.authSession.findUnique({
              where: { initDataHash: args.initDataHash },
            })
            let sessionId: string
            let replayed = false

            if (
              existing &&
              existing.userId === user.id &&
              !existing.revokedAt &&
              existing.expiresAt.getTime() > now.getTime()
            ) {
              replayed = true
              sessionId = existing.id
              log.warn('auth initData replay — re-attached to original session', {
                userId: user.id,
                telegramId: user.telegramId,
                sessionId,
              })
            } else {
              if (existing) {
                // Revoked or expired row holding this initData hash — replace it.
                await tx.authSession.delete({ where: { id: existing.id } })
              }
              sessionId = randomUUID()
            }

            // 5) Mint JWT (sid → session row) and persist the row with token hash only.
            const minted = await mintSessionToken({
              claims: { sub: user.id, sid: sessionId, role: user.role },
              jwtSecret: args.cfg.jwtSecret,
              ttlSeconds: args.cfg.sessionTtlSeconds,
              now,
            })

            if (replayed && existing) {
              await tx.authSession.update({
                where: { id: sessionId },
                data: {
                  tokenHash: sha256Hex(minted.token),
                  lastUsedAt: now,
                  // Expiry is NOT extended by a replay — only fresh initData refreshes.
                },
              })
            } else {
              await tx.authSession.create({
                data: {
                  id: sessionId,
                  userId: user.id,
                  initDataHash: args.initDataHash,
                  tokenHash: sha256Hex(minted.token),
                  telegramAuthDate: args.telegramAuthDate,
                  issuedIp: args.ip,
                  userAgent: args.userAgent,
                  lastUsedAt: now,
                  expiresAt,
                },
              })
            }

            // 6) First login → full player bootstrap in the SAME transaction
            //    (Phase 2 bootstrap service — the single player-creation path).
            //    ensurePlayer is idempotent + race-safe: duplicate/concurrent
            //    registrations converge on the same Player row (UNIQUE userId).
            let playerProfile: { id: string; name: string; level: number }
            const registration = await ensurePlayer(tx, {
              userId: user.id,
              name:
                args.profile?.username ??
                args.profile?.firstName ??
                user.username ??
                user.firstName ??
                'Warlord',
            })
            if (registration.created) {
              playerProfile = await tx.player.findUniqueOrThrow({
                where: { id: registration.playerId },
                select: { id: true, name: true, level: true },
              })
              log.info('auth first login — player bootstrapped', {
                userId: user.id,
                telegramId: user.telegramId,
                playerId: playerProfile.id,
                cityId: registration.cityId,
              })
            } else if (user.player) {
              playerProfile = {
                id: user.player.id,
                name: user.player.name,
                level: user.player.level,
              }
            } else {
              // Player was created concurrently inside this window — re-attach.
              playerProfile = await tx.player.findUniqueOrThrow({
                where: { id: registration.playerId },
                select: { id: true, name: true, level: true },
              })
            }

            // 7) Optional audit trail (dev impersonation).
            if (args.audit) {
              await tx.auditLog.create({
                data: {
                  actorUserId: user.id,
                  action: args.audit.action,
                  targetType: 'user',
                  targetId: user.id,
                  reason: args.audit.reason,
                  ip: args.ip,
                },
              })
            }

            return {
              user,
              player: playerProfile,
              minted,
              replayed,
              sessionId,
            }
          }, REGISTRATION_TX_OPTIONS)
          .catch((err) => {
            // A unique race means a parallel login for the SAME user won the
            // player-insert between our read and our commit. The tx aborted
            // atomically — a clean retry observes their player and re-attaches.
            if (isUniqueConstraintError(err)) throw new RegistrationRaceError()
            throw err
          }),
      // Concurrent same-user logins converge: unique races + SQLite write
      // contention are retried (bounded); everything else fails fast.
      (err) => err instanceof RegistrationRaceError,
    ),
  )

  log.info('auth session issued', {
    userId: result.user.id,
    telegramId: result.user.telegramId,
    replayed: result.replayed,
  })

  return {
    token: result.minted.token,
    tokenType: 'Bearer',
    expiresAt: result.minted.expiresAt,
    replayed: result.replayed,
    user: toUserProfile(result.user),
    player: result.player,
    session: {
      id: result.sessionId,
      expiresAt: result.minted.expiresAt,
      lastUsedAt: now,
    },
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Flow A — Mini App login: verify → tx → session. */
export async function exchangeInitData(
  input: ExchangeInput,
  cfg: AuthConfig,
): Promise<ExchangeResult> {
  const verified = verifyInitData(input.initData, {
    botToken: cfg.botToken,
    maxAgeSeconds: cfg.initDataMaxAgeSeconds,
  })
  return issueSession({
    cfg,
    telegramId: String(verified.user.id),
    telegramAuthDate: verified.authDate,
    initDataHash: sha256Hex(input.initData),
    ip: input.ip,
    userAgent: input.userAgent,
    profile: verified.user,
  })
}

/** Flow B — dev impersonation guard: env gate, constant-time secret, allowlist. */
export function assertDevImpersonationAllowed(telegramId: string, secret: string, env: Env): void {
  if (env.isProd) {
    throw new AppError('NOT_FOUND', 'Not found')
  }
  if (!env.ADMIN_SECRET) {
    throw new AppError('AUTH_NOT_CONFIGURED', 'ADMIN_SECRET is not configured')
  }
  const a = Buffer.from(sha256Hex(secret), 'hex')
  const b = Buffer.from(sha256Hex(env.ADMIN_SECRET), 'hex')
  if (!safeDigestEqual(a.toString('hex'), b.toString('hex'))) {
    log.warn('auth dev impersonation rejected — bad secret', { telegramId })
    throw new AppError('UNAUTHORIZED', 'Invalid dev impersonation secret')
  }
  if (!env.ADMIN_TELEGRAM_IDS.includes(Number(telegramId))) {
    log.warn('auth dev impersonation rejected — not allowlisted', { telegramId })
    throw new AppError('FORBIDDEN', 'Telegram id is not on the dev allowlist')
  }
}

/** Flow B — dev impersonation session (no initData, fully audited). */
export async function exchangeDevImpersonation(
  input: { telegramId: string; ip?: string; userAgent?: string; reason?: string },
  cfg: AuthConfig,
): Promise<ExchangeResult> {
  const result = await issueSession({
    cfg,
    telegramId: input.telegramId,
    telegramAuthDate: new Date(),
    initDataHash: `dev-impersonate:${input.telegramId}`,
    ip: input.ip,
    userAgent: input.userAgent,
    audit: {
      action: 'DEV_IMPERSONATE',
      reason: input.reason ?? 'dev impersonation session',
    },
  })
  log.warn('auth dev impersonation session issued', {
    telegramId: input.telegramId,
    userId: result.user.id,
    ip: input.ip,
  })
  return result
}

export interface AuthenticateOptions {
  /** Re-issue the token when the session is inside the sliding window. */
  refresh?: boolean
  now?: Date
}

export interface AuthResult {
  principal: AuthPrincipal
  refreshed?: RefreshedSession
}

/**
 * Authorization middleware core: bearer/cookie → JWT → session row → ban
 * check. The session ROW is the revocation + token-hash authority; the JWT
 * only speeds up signature verification.
 */
export async function authenticate(
  request: Request,
  cfg: AuthConfig,
  options: AuthenticateOptions = {},
): Promise<AuthResult> {
  const token = readSessionToken(request)
  if (!token) {
    throw new AppError('UNAUTHORIZED', 'Authentication required')
  }

  const claims: SessionClaims = await verifySessionToken(token, cfg.jwtSecret)
  const tokenHash = sha256Hex(token)
  const now = options.now ?? new Date()

  const row = await db.authSession.findUnique({
    where: { id: claims.sid },
    include: { user: { include: { player: true } } },
  })
  if (!row || !safeDigestEqual(row.tokenHash, tokenHash)) {
    throw new AppError('UNAUTHORIZED', 'Session is not recognized')
  }
  if (row.revokedAt) {
    throw new AppError('SESSION_REVOKED', 'Session has been revoked')
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('SESSION_EXPIRED', 'Session has expired')
  }
  assertNotBanned(row.user)

  // Throttled lastUsedAt — at most one write per minute per session.
  if (now.getTime() - row.lastUsedAt.getTime() > 60_000) {
    await db.authSession
      .update({ where: { id: row.id }, data: { lastUsedAt: now } })
      .catch((err) => log.warn('auth lastUsedAt update failed', { sessionId: row.id, err }))
  }

  let refreshed: RefreshedSession | undefined
  if (options.refresh) {
    const remainingSec = (row.expiresAt.getTime() - now.getTime()) / 1000
    if (remainingSec < SESSION_REFRESH_THRESHOLD_SECONDS) {
      const minted = await mintSessionToken({
        claims: { sub: row.user.id, sid: row.id, role: row.user.role },
        jwtSecret: cfg.jwtSecret,
        ttlSeconds: cfg.sessionTtlSeconds,
        now,
      })
      await db.authSession.update({
        where: { id: row.id },
        data: { tokenHash: sha256Hex(minted.token), expiresAt: minted.expiresAt },
      })
      refreshed = { token: minted.token, expiresAt: minted.expiresAt }
      log.info('auth session refreshed (sliding)', { userId: row.user.id, sessionId: row.id })
    }
  }

  return {
    principal: {
      user: toUserProfile(row.user),
      player: row.user.player
        ? {
            id: row.user.player.id,
            name: row.user.player.name,
            level: row.user.player.level,
          }
        : null,
      session: { id: row.id, expiresAt: row.expiresAt, lastUsedAt: row.lastUsedAt },
      token,
    },
    refreshed,
  }
}

/** Revokes the current session row (logout). Idempotent. */
export async function revokeSession(sessionId: string, userId: string): Promise<void> {
  const row = await db.authSession.findUnique({ where: { id: sessionId } })
  if (!row || row.userId !== userId) return
  if (row.revokedAt) return
  await db.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
  log.info('auth session revoked', { userId, sessionId })
}
