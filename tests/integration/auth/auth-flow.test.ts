/**
 * Integration tests — Telegram auth flow (routes + DB, no HTTP server).
 *
 * Route handlers are invoked directly with constructed Request objects, so
 * the FULL stack is exercised: Zod validation → rate limit → HMAC verify →
 * transaction (user upsert / replay / session / bootstrap) → envelope.
 *
 * Uses the REAL env secrets (bun loads .env) — the signer implements the
 * official Telegram algorithm; nothing is mocked. Test identities live in
 * an isolated telegramId range and are removed in afterAll.
 */

import { describe, it, expect, afterAll } from 'bun:test'
import { createHmac, createHash } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as meGet } from '../../../src/app/api/v1/auth/me/route'
import { POST as logoutPost } from '../../../src/app/api/v1/auth/logout/route'
import { POST as devImpersonatePost } from '../../../src/app/api/v1/auth/dev-impersonate/route'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']
const ADMIN_SECRET = process.env['ADMIN_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Integration auth tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '198.51.100.'
let ipCounter = 1
/** Unique source IP per request — the shared limiter's auth budget is 10/min per IP. */
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100001001
const nextTgId = (): string => String(tgCounter++)

function telegramRequest(initData: string): Request {
  return new Request('http://localhost:3000/api/v1/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ initData }),
  })
}

function meRequest(token?: string): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': nextIp() }
  if (token) headers['authorization'] = `Bearer ${token}`
  return new Request('http://localhost:3000/api/v1/auth/me', { headers })
}

function buildInitData(telegramId: string, opts?: { authDate?: number }): string {
  const fields: Record<string, string> = {
    query_id: `AAF9tE0aAAAA${telegramId}`,
    auth_date: String(opts?.authDate ?? Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `TestLord${telegramId.slice(-3)}`,
      username: `test_lord_${telegramId.slice(-4)}`,
      language_code: 'fa',
    }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN!).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

interface MePayload {
  user: { id: string; telegramId: string; firstName: string; role: string }
  player: { id: string; name: string; level: number } | null
  session: { id: string; expiresAt: string }
}

interface ExchangePayload {
  token: string
  tokenType: string
  expiresAt: string
  replayed: boolean
  user: { id: string; telegramId: string; firstName: string; username: string | null }
  player: { id: string; name: string; level: number } | null
  session: { id: string; expiresAt: string }
}

async function parse<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

// ── Scenarios ────────────────────────────────────────────────────────────────

const validTgId = nextTgId()

describe('POST /api/v1/auth/telegram', () => {
  it('scenario 1 — valid authentication creates user + session + player (first login)', async () => {
    const initData = buildInitData(validTgId) // built ONCE — auth_date is time-dependent
    const res = await telegramPost(telegramRequest(initData))
    expect(res.status).toBe(200)
    const body = await parse<ExchangePayload>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.tokenType).toBe('Bearer')
    expect(body.data.replayed).toBe(false)
    expect(body.data.user.telegramId).toBe(validTgId)
    expect(body.data.player).not.toBeNull()
    expect(typeof body.data.session.id).toBe('string')

    // Session cookie issued for web clients.
    const cookie = res.headers.get('set-cookie')
    expect(cookie).toContain('wl_session=')
    expect(cookie).toContain('HttpOnly')

    // First login bootstrapped the FULL player state in one tx.
    const sessionRow = await db.authSession.findUnique({
      where: { id: body.data.session.id },
    })
    expect(sessionRow).not.toBeNull()
    expect(sessionRow!.initDataHash).toBe(createHash('sha256').update(initData).digest('hex'))
    const user = await db.user.findUnique({
      where: { telegramId: validTgId },
      include: { player: { include: { wallet: true, city: true } } },
    })
    expect(user?.player?.wallet).not.toBeNull()
    expect(user?.player?.city).not.toBeNull()
  })

  it('scenario 2 — invalid hash → 401 INVALID_INIT_DATA', async () => {
    const tgId = nextTgId()
    const initData = buildInitData(tgId).replace(/hash=.{6}/, 'hash=dead00')
    const res = await telegramPost(telegramRequest(initData))
    expect(res.status).toBe(401)
    const body = await parse(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('INVALID_INIT_DATA')
  })

  it('scenario 3 — expired authentication → 401 with reason "expired"', async () => {
    const tgId = nextTgId()
    const stale = Math.floor(Date.now() / 1000) - 2 * 86_400 // 2 days old
    const res = await telegramPost(telegramRequest(buildInitData(tgId, { authDate: stale })))
    expect(res.status).toBe(401)
    const body = await parse(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('INVALID_INIT_DATA')
    expect(body.error.details?.['reason']).toBe('expired')
  })

  it('scenario 4 — missing initData → 400 VALIDATION_ERROR', async () => {
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
    const body = await parse(res)
    if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('scenario 5 — manipulated user data → 401 invalid_hash', async () => {
    const tgId = nextTgId()
    const params = new URLSearchParams(buildInitData(tgId))
    params.set('user', JSON.stringify({ id: 1, first_name: 'Hijacked', username: 'victim' }))
    const res = await telegramPost(telegramRequest(params.toString()))
    expect(res.status).toBe(401)
    const body = await parse(res)
    if (!body.ok) expect(body.error.details?.['reason']).toBe('invalid_hash')
  })

  it('scenario 6 — replay attempt re-attaches to the SAME session (no farming)', async () => {
    const tgId = nextTgId()
    const initData = buildInitData(tgId)

    const first = await parse<ExchangePayload>(await telegramPost(telegramRequest(initData)))
    expect(first.ok).toBe(true)
    const second = await parse<ExchangePayload>(await telegramPost(telegramRequest(initData)))
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.data.replayed).toBe(true)
    expect(second.data.session.id).toBe(first.data.session.id)
    expect(second.data.user.id).toBe(first.data.user.id)

    // Exactly one live session row for this initData.
    const rows = await db.authSession.findMany({
      where: { user: { telegramId: tgId } },
    })
    expect(rows).toHaveLength(1)

    // A FRESH initData (new auth_date) mints a NEW session — replays are
    // idempotent, not a global lockout.
    const fresh = await parse<ExchangePayload>(
      await telegramPost(
        telegramRequest(buildInitData(tgId, { authDate: Math.floor(Date.now() / 1000) })),
      ),
    )
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) return
    expect(fresh.data.replayed).toBe(false)
    expect(fresh.data.session.id).not.toBe(first.data.session.id)
  })
})

describe('GET /api/v1/auth/me — authorization middleware', () => {
  let token = ''

  it('scenario 4 — missing authentication → 401 UNAUTHORIZED', async () => {
    const res = await meGet(meRequest())
    expect(res.status).toBe(401)
    const body = await parse(res)
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('scenario 1 — valid bearer token returns identity + player', async () => {
    const tgId = nextTgId()
    const body = await parse<ExchangePayload>(
      await telegramPost(telegramRequest(buildInitData(tgId))),
    )
    if (!body.ok) throw new Error('setup exchange failed')
    token = body.data.token

    const res = await meGet(meRequest(token))
    expect(res.status).toBe(200)
    const me = await parse<MePayload>(res)
    expect(me.ok).toBe(true)
    if (!me.ok) return
    expect(me.data.user.telegramId).toBe(tgId)
    expect(me.data.user.firstName).toBe(`TestLord${tgId.slice(-3)}`)
    expect(me.data.player).not.toBeNull()
    expect(me.data.session.id).toBe(body.data.session.id)
  })

  it('does not trigger sliding refresh on a fresh session', async () => {
    const res = await meGet(meRequest(token))
    const body = await parse<Record<string, unknown>>(res)
    expect(body.ok).toBe(true)
    if (body.ok) expect(body.data['refreshed']).toBeUndefined()
  })

  it('accepts the cookie transport (HttpOnly web path)', async () => {
    const req = new Request('http://localhost:3000/api/v1/auth/me', {
      headers: { cookie: `wl_session=${token}`, 'x-forwarded-for': nextIp() },
    })
    expect((await meGet(req)).status).toBe(200)
  })

  it('scenario 7 — garbage / foreign-secret / unknown tokens → 401', async () => {
    // Garbage string
    const garbage = await meGet(meRequest('wla_totally_made_up'))
    expect(garbage.status).toBe(401)

    // Structurally valid JWT signed by an attacker with the wrong secret
    const { SignJWT } = await import('jose')
    const forged = await new SignJWT({ sid: '00000000-0000-0000-0000-000000000000', role: 'USER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_forged')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setIssuer('warlords')
      .setAudience('warlords-mini-app')
      .sign(new TextEncoder().encode('attacker-secret-0123456789abcdef0123456789abcdef'))
    const forgedRes = await meGet(meRequest(forged))
    expect(forgedRes.status).toBe(401)
  })

  it('scenario 7 — logout revokes the session; token dies server-side', async () => {
    const tgId = nextTgId()
    const body = await parse<ExchangePayload>(
      await telegramPost(telegramRequest(buildInitData(tgId))),
    )
    if (!body.ok) throw new Error('setup exchange failed')
    const victim = body.data.token

    const logoutRes = await logoutPost(
      new Request('http://localhost:3000/api/v1/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${victim}` },
      }),
    )
    expect(logoutRes.status).toBe(200)
    // Cookie cleared for web clients on the successful logout response.
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')

    const after = await meGet(meRequest(victim))
    expect(after.status).toBe(401)
    const errBody = await parse(after)
    if (!errBody.ok) expect(errBody.error.code).toBe('SESSION_REVOKED')
  })
})

describe('ban enforcement', () => {
  it('blocks exchange and /me for banned users (403 BANNED, tx rolls back)', async () => {
    const tgId = nextTgId()
    const body = await parse<ExchangePayload>(
      await telegramPost(telegramRequest(buildInitData(tgId))),
    )
    if (!body.ok) throw new Error('setup exchange failed')

    const user = await db.user.findUniqueOrThrow({ where: { telegramId: tgId } })
    await db.user.update({
      where: { id: user.id },
      data: { isBanned: true, banReason: 'integration test' },
    })

    // Exchange with fresh initData → rejected, no session row persisted.
    const sessionsBefore = await db.authSession.count({ where: { userId: user.id } })
    const rejected = await parse(
      await telegramPost(
        telegramRequest(buildInitData(tgId, { authDate: Math.floor(Date.now() / 1000) })),
      ),
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.code).toBe('BANNED')
      expect(rejected.error.details?.['reason']).toBe('integration test')
    }
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(sessionsBefore)

    // Existing session → middleware rejects on every request.
    const meRes = await meGet(meRequest(body.data.token))
    expect(meRes.status).toBe(403)

    // Unban → access restored.
    await db.user.update({ where: { id: user.id }, data: { isBanned: false } })
    expect((await meGet(meRequest(body.data.token))).status).toBe(200)
  })
})

describe('POST /api/v1/auth/dev-impersonate (Flow B guards)', () => {
  const impTgId = '9100000001'

  function impRequest(body: Record<string, string>): Request {
    return new Request('http://localhost:3000/api/v1/auth/dev-impersonate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify(body),
    })
  }

  it('rejects a wrong secret (401) — constant-time comparison', async () => {
    const res = await devImpersonatePost(
      impRequest({ telegramId: impTgId, secret: 'wrong-secret-value' }),
    )
    expect(res.status).toBe(401)
    const body = await parse(res)
    if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a non-allowlisted telegram id (403)', async () => {
    if (!ADMIN_SECRET) return // ADMIN_SECRET unset → allowlist test not runnable
    const res = await devImpersonatePost(
      impRequest({ telegramId: '9999999999', secret: ADMIN_SECRET }),
    )
    expect(res.status).toBe(403)
  })

  it('issues an allowlisted session, audits it, and replays to the same session', async () => {
    if (!ADMIN_SECRET) return
    const first = await parse<ExchangePayload>(
      await devImpersonatePost(impRequest({ telegramId: impTgId, secret: ADMIN_SECRET })),
    )
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.data.player).not.toBeNull()

    const second = await parse<ExchangePayload>(
      await devImpersonatePost(impRequest({ telegramId: impTgId, secret: ADMIN_SECRET })),
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.data.session.id).toBe(first.data.session.id)

    const audits = await db.auditLog.findMany({
      where: { action: 'DEV_IMPERSONATE', actor: { telegramId: impTgId } },
    })
    expect(audits.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Cleanup ──────────────────────────────────────────────────────────────────

afterAll(async () => {
  // Audit rows (Restrict FK) must go before users; sessions cascade.
  // Bulk user deleteMany can transiently violate FK ordering under the
  // SQLite foreign-key emulation when several users are removed in one
  // statement — delete per row (cheap at test scale, fully reliable).
  const testUsers = await db.user.findMany({
    where: { telegramId: { startsWith: '910000' } },
    select: { id: true },
  })
  const ids = testUsers.map((u) => u.id)
  if (ids.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: ids } } })
    for (const id of ids) {
      await db.user.delete({ where: { id } }).catch(() => undefined)
    }
  }
  await db.$disconnect()
})
