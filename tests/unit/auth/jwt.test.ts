/**
 * Unit tests — session JWT mint/verify (src/lib/auth/jwt).
 * Pure crypto — no DB, no env.
 */

import { describe, it, expect } from 'bun:test'
import { SignJWT } from 'jose'
import { mintSessionToken, verifySessionToken } from '../../../src/lib/auth/jwt'
import { AppError } from '../../../src/lib/api/errors'

const SECRET = 'unit-test-secret-0123456789abcdef0123456789abcdef'
/** jose verifies against the real clock, so fixtures anchor to `Date.now()`. */
const NOW = () => new Date()
const CLAIMS = { sub: 'usr_123', sid: 'sess_abc', role: 'USER' }

describe('mintSessionToken / verifySessionToken', () => {
  it('round-trips claims with issuer/audience/expiry set', async () => {
    const now = NOW()
    const minted = await mintSessionToken({
      claims: CLAIMS,
      jwtSecret: SECRET,
      ttlSeconds: 3600,
      now,
    })
    expect(minted.token.split('.')).toHaveLength(3)
    expect(minted.expiresAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 3599 * 1000)

    const claims = await verifySessionToken(minted.token, SECRET)
    expect(claims.sub).toBe('usr_123')
    expect(claims.sid).toBe('sess_abc')
    expect(claims.role).toBe('USER')
  })

  it('rejects an expired token with SESSION_EXPIRED', async () => {
    const minted = await mintSessionToken({
      claims: CLAIMS,
      jwtSecret: SECRET,
      ttlSeconds: -10,
      now: NOW(),
    })
    try {
      await verifySessionToken(minted.token, SECRET)
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('SESSION_EXPIRED')
    }
  })

  it('rejects a token signed with a different secret as UNAUTHORIZED', async () => {
    const minted = await mintSessionToken({
      claims: CLAIMS,
      jwtSecret: SECRET,
      ttlSeconds: 3600,
      now: NOW(),
    })
    try {
      await verifySessionToken(minted.token, 'other-secret-0123456789abcdef0123456789abcdef')
      expect.unreachable()
    } catch (err) {
      expect((err as AppError).code).toBe('UNAUTHORIZED')
    }
  })

  it('rejects tampered payloads', async () => {
    const minted = await mintSessionToken({
      claims: CLAIMS,
      jwtSecret: SECRET,
      ttlSeconds: 3600,
      now: NOW(),
    })
    const [head, _payload, sig] = minted.token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ sub: 'usr_admin', sid: 'sess_abc', role: 'SUPERADMIN' }),
    )
      .toString('base64url')
      .toString()
    try {
      await verifySessionToken(`${head}.${forged}.${sig}`, SECRET)
      expect.unreachable()
    } catch (err) {
      expect((err as AppError).code).toBe('UNAUTHORIZED')
    }
  })

  it('rejects tokens from another issuer', async () => {
    const alien = await new SignJWT({ sid: 'sess_abc', role: 'USER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_123')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setIssuer('not-warlords')
      .sign(new TextEncoder().encode(SECRET))
    try {
      await verifySessionToken(alien, SECRET)
      expect.unreachable()
    } catch (err) {
      expect((err as AppError).code).toBe('UNAUTHORIZED')
    }
  })

  it('rejects tokens missing the sid claim', async () => {
    const noSid = await new SignJWT({ role: 'USER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_123')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setIssuer('warlords')
      .setAudience('warlords-mini-app')
      .sign(new TextEncoder().encode(SECRET))
    try {
      await verifySessionToken(noSid, SECRET)
      expect.unreachable()
    } catch (err) {
      expect((err as AppError).code).toBe('UNAUTHORIZED')
    }
  })
})
