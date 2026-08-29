/**
 * WARLORDS — Session JWT (HS256 via `jose`, per AUTHENTICATION.md §2).
 *
 * Claims: `sub` = user id, `sid` = auth_sessions row id, `role` = snapshot
 * for observability ONLY (authorization re-reads role from the DB on every
 * request, so role grants/revocations apply immediately).
 *
 * The token is a bearer credential: stored server-side as sha256(token),
 * revocable via the session row, rotated on refresh/replay.
 */

import { SignJWT, jwtVerify, JWTPayload } from 'jose'
import { AppError } from '@/lib/api/errors'

export interface SessionClaims {
  sub: string
  sid: string
  role: string
}

interface MintInput {
  claims: SessionClaims
  jwtSecret: string
  ttlSeconds: number
  now?: Date
}

export interface MintedToken {
  token: string
  expiresAt: Date
  issuedAt: Date
}

export async function mintSessionToken(input: MintInput): Promise<MintedToken> {
  const now = input.now ?? new Date()
  const issuedAt = now
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)
  const key = new TextEncoder().encode(input.jwtSecret)

  const token = await new SignJWT({ sid: input.claims.sid, role: input.claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.claims.sub)
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setIssuer('warlords')
    .setAudience('warlords-mini-app')
    .sign(key)

  return { token, expiresAt, issuedAt }
}

/**
 * Verifies signature + expiry + claim shape. Expired → SESSION_EXPIRED,
 * every other verification failure → UNAUTHORIZED (no oracle details).
 */
export async function verifySessionToken(token: string, jwtSecret: string): Promise<SessionClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      issuer: 'warlords',
      audience: 'warlords-mini-app',
      algorithms: ['HS256'],
    })
    return claimsFromPayload(payload)
  } catch (err) {
    if (err instanceof Error && err.name === 'JWTExpired') {
      throw new AppError('SESSION_EXPIRED', 'Session token has expired')
    }
    throw new AppError('UNAUTHORIZED', 'Session token is not valid')
  }
}

function claimsFromPayload(payload: JWTPayload): SessionClaims {
  const { sub, sid, role } = payload as JWTPayload & Partial<SessionClaims>
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AppError('UNAUTHORIZED', 'Session token is missing the subject claim')
  }
  if (typeof sid !== 'string' || sid.length === 0) {
    throw new AppError('UNAUTHORIZED', 'Session token is missing the session id claim')
  }
  return { sub, sid, role: typeof role === 'string' ? role : '' }
}
