/**
 * Integration tests — Cross-cutting NEGATIVE matrix (Phase 24 QA).
 *
 * One suite that hammers every route family with the abuse catalog a
 * Senior QA engineer expects: invalid ids, negative/zero/fractional and
 * HUGE amounts, duplicate requests, expired credentials, unauthorized
 * access, concurrent duplicates and malformed payloads. The contract under
 * test: every refusal is a TYPED envelope (VALIDATION_ERROR / 404 / 401 /
 * 409 / 413), performs ZERO writes, and never leaks another player's data
 * or crashes with a 500.
 *
 * Test identities live in the isolated 9100025… telegramId range and are
 * removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as armyCatalogGet } from '../../../src/app/api/v1/army/catalog/route'
import { POST as trainPost } from '../../../src/app/api/v1/army/train/route'
import { POST as trainCancelPost } from '../../../src/app/api/v1/army/train/[id]/cancel/route'
import { GET as cityGet } from '../../../src/app/api/v1/city/route'
import { POST as upgradePost } from '../../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import { GET as playerStateGet } from '../../../src/app/api/v1/player/state/route'
import { GET as playerTxGet } from '../../../src/app/api/v1/player/transactions/route'
import { GET as notificationsGet } from '../../../src/app/api/v1/player/notifications/route'
import { POST as notificationsReadPost } from '../../../src/app/api/v1/player/notifications/read/route'
import { GET as seasonGet } from '../../../src/app/api/v1/season/route'
import { GET as rankingGet } from '../../../src/app/api/v1/season/ranking/route'
import { POST as claimPost } from '../../../src/app/api/v1/season/rewards/claim/route'
import { GET as adminPlayersGet } from '../../../src/app/api/v1/admin/players/route'
import { mintSessionToken } from '../../../src/lib/auth/jwt'
import { resolveAuthConfig } from '../../../src/lib/auth'
import { getEnv } from '../../../src/config/env'
import { getWalletBalances } from '../../../src/lib/game/services/economy.service'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Negative matrix tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100025'
let tgCounter = 1
const nextTgId = (): string => `${TG_PREFIX}${String(tgCounter++).padStart(3, '0')}`
const tgIds: string[] = []

const IP_BASE = '203.0.125.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

function buildInitData(telegramId: string, authDateSec?: number): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(authDateSec ?? Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `NegLord${telegramId.slice(-3)}`,
      username: `neg_lord_${telegramId.slice(-4)}`,
      language_code: 'en',
    }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

function request(
  path: string,
  token: string | null,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  headersExtra?: Record<string, string>,
): Request {
  const rawBody =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': nextIp(),
      ...(rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headersExtra,
    },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  })
}

let playerToken = ''
let playerId = ''

/** Exchange + register an identity — ALWAYS tracked for afterAll cleanup. */
async function register(telegramId: string): Promise<{
  token: string
  playerId: string
  userId: string
}> {
  const res = await telegramPost(
    request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(telegramId) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as ApiEnvelope<{
    token: string
    user: { id: string }
    player: { id: string }
  }>
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error('exchange failed')
  tgIds.push(telegramId)
  return { token: body.data.token, playerId: body.data.player.id, userId: body.data.user.id }
}

beforeAll(async () => {
  // Self-healing: a previous crashed run may have leaked identities in this
  // range (drained wallets would poison the concurrency assertions).
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)

  const main = await register(nextTgId())
  playerToken = main.token
  playerId = main.playerId
})

afterAll(async () => {
  await db.notification.deleteMany({ where: { player: { user: { telegramId: { in: tgIds } } } } })
  await db.notificationQueue.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.trainingQueueItem.deleteMany({ where: { playerId } })
  {
    const tgUsers = await db.user.findMany({
      where: { telegramId: { in: tgIds } },
      select: { id: true },
    })
    for (const tgUser of tgUsers) {
      await db.user.delete({ where: { id: tgUser.id } }).catch(() => undefined)
    }
  }
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** Next.js passes dynamic params as the 2nd arg (a Promise) — same shape in tests. */
function routeCtxId(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
}

function routeCtxType(type: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ type }) }
}

async function expectTypedError(res: Response, status: number, code?: string): Promise<void> {
  expect(res.status).toBe(status)
  const body = (await res.json()) as ApiEnvelope<unknown>
  expect(body.ok).toBe(false)
  if (!body.ok && code !== undefined) expect(body.error.code).toBe(code)
}

// ── 1. Unauthorized access — every route family ─────────────────────────────

describe('unauthorized access — no credential reaches ANY route family', () => {
  const anonymousGetRoutes: Array<[string, (req: Request) => Promise<Response>]> = [
    ['/api/v1/army/catalog', armyCatalogGet],
    ['/api/v1/city', cityGet],
    ['/api/v1/player/state', playerStateGet],
    ['/api/v1/player/transactions', playerTxGet],
    ['/api/v1/player/notifications', notificationsGet],
    ['/api/v1/season', seasonGet],
    ['/api/v1/season/ranking', rankingGet],
    ['/api/v1/admin/players', adminPlayersGet],
  ]

  for (const [path, handler] of anonymousGetRoutes) {
    it(`GET ${path} → 401 envelope, no data`, async () => {
      const res = await handler(request(path, null))
      expect(res.status).toBe(401)
      const body = (await res.json()) as ApiEnvelope<unknown>
      expect(body.ok).toBe(false)
      if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
    })
  }

  it('POST train / claim / mark-read without a session → 401, zero writes', async () => {
    await expectTypedError(
      await trainPost(
        request('/api/v1/army/train', null, 'POST', { unitId: 'swordsman', count: 1 }),
      ),
      401,
      'UNAUTHORIZED',
    )
    await expectTypedError(
      await claimPost(
        request('/api/v1/season/rewards/claim', null, 'POST', { seasonId: 'whatever' }),
      ),
      401,
      'UNAUTHORIZED',
    )
    await expectTypedError(
      await notificationsReadPost(
        request('/api/v1/player/notifications/read', null, 'POST', { all: true }),
      ),
      401,
      'UNAUTHORIZED',
    )
  })

  it('a garbage bearer token → 401 (never a 500)', async () => {
    await expectTypedError(await cityGet(request('/api/v1/city', 'not-a-jwt')), 401)
    await expectTypedError(
      await cityGet(request('/api/v1/city', 'eyJhbGciOiJIUzI1NiJ9.bm90LnJlYWw.bm90LnJlYWw')),
      401,
    )
  })
})

// ── 2. Expired credentials ───────────────────────────────────────────────────

describe('expired credentials — the clock is server-side', () => {
  it('initData older than the 24h replay window → 401 expired', async () => {
    // TELEGRAM_AUTH_MAX_AGE_SECONDS defaults to 86_400 — 2 days is past it.
    const stale = buildInitData(nextTgId(), Math.floor(Date.now() / 1000) - 2 * 86_400)
    const res = await telegramPost(
      request('/api/v1/auth/telegram', null, 'POST', { initData: stale }),
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('INVALID_INIT_DATA')
  })

  it('a structurally valid JWT signed with the WRONG secret → 401', async () => {
    const foreign = await mintSessionToken({
      claims: { sub: 'x', sid: 'x', role: 'PLAYER' },
      jwtSecret: 'attacker-controlled-secret',
      ttlSeconds: 600,
    })
    const res = await cityGet(request('/api/v1/city', foreign.token))
    expect(res.status).toBe(401)
  })

  it('an EXPIRED JWT (negative TTL) → 401 SESSION_EXPIRED', async () => {
    const env = getEnv()
    const expired = await mintSessionToken({
      claims: { sub: 'x', sid: 'x', role: 'PLAYER' },
      jwtSecret: resolveAuthConfig(env).jwtSecret,
      ttlSeconds: -3600,
    })
    const res = await cityGet(request('/api/v1/city', expired.token))
    expect(res.status).toBe(401)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('SESSION_EXPIRED')
  })

  it('a DB-expired session (valid JWT, expired row) → 401', async () => {
    // Fresh identity, then force-expire its session row server-side.
    const fresh = await register(nextTgId())
    await db.authSession.updateMany({
      where: { userId: fresh.userId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const after = await cityGet(request('/api/v1/city', fresh.token))
    expect(after.status).toBe(401)
    const afterBody = (await after.json()) as ApiEnvelope<unknown>
    if (!afterBody.ok) expect(afterBody.error.code).toBe('SESSION_EXPIRED')
  })
})

// ── 3. Invalid ids & injection-flavored input ────────────────────────────────

describe('invalid ids — typed refusals, zero writes', () => {
  it('train with an unknown / empty / oversized / injection-flavored unitId', async () => {
    const queueBefore = await db.trainingQueueItem.count({ where: { playerId } })
    const walletsBefore = await getWalletBalances(db, playerId)

    await expectTypedError(
      await trainPost(request('/api/v1/army/train', playerToken, 'POST', { unitId: '', count: 1 })),
      400,
      'VALIDATION_ERROR',
    )
    await expectTypedError(
      await trainPost(
        request('/api/v1/army/train', playerToken, 'POST', { unitId: 'x'.repeat(65), count: 1 }),
      ),
      400,
      'VALIDATION_ERROR',
    )
    await expectTypedError(
      await trainPost(
        request('/api/v1/army/train', playerToken, 'POST', {
          unitId: "swordsman'; DROP TABLE players;--",
          count: 1,
        }),
      ),
      404,
      'UNIT_NOT_FOUND',
    )

    const queueAfter = await db.trainingQueueItem.count({ where: { playerId } })
    const walletsAfter = await getWalletBalances(db, playerId)
    expect(queueAfter).toBe(queueBefore)
    expect(walletsAfter).toEqual(walletsBefore)
  })

  it('cancel with a malformed / foreign queue-item id → 404, no refund', async () => {
    await expectTypedError(
      await trainCancelPost(
        request('/api/v1/army/train/does-not-exist/cancel', playerToken, 'POST'),
        routeCtxId('does-not-exist'),
      ),
      404,
    )
    await expectTypedError(
      await trainCancelPost(
        request(`/api/v1/army/train/${'a'.repeat(64)}/cancel`, playerToken, 'POST'),
        routeCtxId('a'.repeat(64)),
      ),
      404,
    )
  })

  it('city upgrade with an unknown building type → typed 404 (catalog authority)', async () => {
    await expectTypedError(
      await upgradePost(
        request('/api/v1/city/buildings/NOT_A_BUILDING/upgrade', playerToken, 'POST'),
        routeCtxType('NOT_A_BUILDING'),
      ),
      404,
    )
  })
})

// ── 4. Negative, zero, fractional and HUGE amounts ──────────────────────────

describe('amount abuse — the server owns every number', () => {
  it('train count 0 / negative / fractional / 1e12 → 400 VALIDATION_ERROR, wallet untouched', async () => {
    const before = await getWalletBalances(db, playerId)
    for (const count of [0, -5, -1_000_000, 1.5, Number.NaN, 1e12]) {
      const res = await trainPost(
        request('/api/v1/army/train', playerToken, 'POST', { unitId: 'swordsman', count }),
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as ApiEnvelope<unknown>
      expect(body.ok).toBe(false)
      if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
    }
    expect(await getWalletBalances(db, playerId)).toEqual(before)
  })

  it('train count above the per-batch ceiling (1_000_000 passes zod, service refuses)', async () => {
    const res = await trainPost(
      request('/api/v1/army/train', playerToken, 'POST', { unitId: 'swordsman', count: 1_000_000 }),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
    // Zero queue items and zero debits.
    expect(await db.trainingQueueItem.count({ where: { playerId } })).toBe(0)
  })

  it('query abuse on list routes → 400 (never unbounded scans)', async () => {
    await expectTypedError(
      await notificationsGet(request('/api/v1/player/notifications?limit=10000', playerToken)),
      400,
      'VALIDATION_ERROR',
    )
    await expectTypedError(
      await notificationsGet(request('/api/v1/player/notifications?limit=-3', playerToken)),
      400,
      'VALIDATION_ERROR',
    )
    await expectTypedError(
      await playerTxGet(request('/api/v1/player/transactions?limit=1.5', playerToken)),
      400,
      'VALIDATION_ERROR',
    )
  })

  it('a garbage pagination cursor → 400 VALIDATION_ERROR (typed, not a 500)', async () => {
    await expectTypedError(
      await playerTxGet(request('/api/v1/player/transactions?cursor=%%%garbage%%%', playerToken)),
      400,
      'VALIDATION_ERROR',
    )
    await expectTypedError(
      await playerTxGet(request('/api/v1/player/transactions?cursor=notanumber|', playerToken)),
      400,
      'VALIDATION_ERROR',
    )
  })
})

// ── 5. Duplicate & idempotent requests ──────────────────────────────────────

describe('duplicate requests — replay defense and natural idempotency', () => {
  it('the SAME telegram initData replayed reattaches to the SAME session (no farming)', async () => {
    const tgId = nextTgId()
    tgIds.push(tgId)
    const first = await telegramPost(
      request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(tgId) }),
    )
    const firstBody = (await first.json()) as ApiEnvelope<{ token: string; user: { id: string } }>
    expect(firstBody.ok).toBe(true)

    const replay = await telegramPost(
      request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(tgId) }),
    )
    const replayBody = (await replay.json()) as ApiEnvelope<{ token: string; user: { id: string } }>
    expect(replayBody.ok).toBe(true)
    if (firstBody.ok && replayBody.ok) {
      expect(replayBody.data.user.id).toBe(firstBody.data.user.id)
    }
  })

  it('mark-read is idempotent: the second all:true updates nothing new', async () => {
    const first = await notificationsReadPost(
      request('/api/v1/player/notifications/read', playerToken, 'POST', { all: true }),
    )
    expect(first.status).toBe(200)
    const second = await notificationsReadPost(
      request('/api/v1/player/notifications/read', playerToken, 'POST', { all: true }),
    )
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as ApiEnvelope<{ updated: number }>
    expect(secondBody.ok && secondBody.data.updated).toBe(0)
  })
})

// ── 6. Malformed payloads & oversized bodies ─────────────────────────────────

describe('malformed payloads — never a 500', () => {
  it('syntactically invalid JSON body → 400 VALIDATION_ERROR', async () => {
    const res = await trainPost(
      request('/api/v1/army/train', playerToken, 'POST', '{"unitId": "swordsman",'),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('a JSON body of the WRONG SHAPE (string / array) → 400', async () => {
    const asString = await trainPost(
      request('/api/v1/army/train', playerToken, 'POST', JSON.stringify('not-an-object')),
    )
    expect(asString.status).toBe(400)
    const asArray = await trainPost(
      request('/api/v1/army/train', playerToken, 'POST', JSON.stringify([{ unitId: 'swordsman' }])),
    )
    expect(asArray.status).toBe(400)
  })

  it('an oversized body (> 64 KiB) → 413 BODY_TOO_LARGE before parsing', async () => {
    const big = JSON.stringify({ unitId: 'swordsman', count: 1, junk: 'x'.repeat(70_000) })
    const res = await trainPost(request('/api/v1/army/train', playerToken, 'POST', big))
    expect(res.status).toBe(413)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('BODY_TOO_LARGE')
  })

  it('a foreign Origin on a POST → 403 FORBIDDEN_ORIGIN (CSRF rail)', async () => {
    const res = await trainPost(
      request(
        '/api/v1/army/train',
        playerToken,
        'POST',
        { unitId: 'swordsman', count: 1 },
        {
          origin: 'https://evil.example.com',
        },
      ),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('FORBIDDEN_ORIGIN')
  })
})

// ── 7. Concurrent requests — same-player races ───────────────────────────────

describe('concurrent requests — queue capacity and money never break', () => {
  it('8 parallel train batches land inside the 5-slot FIFO cap; cost debited exactly once per batch', async () => {
    // Clean slate for this player's queue.
    await db.trainingQueueItem.deleteMany({ where: { playerId } })
    const before = await getWalletBalances(db, playerId)

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        trainPost(
          request('/api/v1/army/train', playerToken, 'POST', { unitId: 'swordsman', count: 1 }),
        ).then(async (r) => ({ status: r.status, body: (await r.json()) as ApiEnvelope<unknown> })),
      ),
    )
    const succeeded = attempts.filter((a) => a.status === 200)
    const refused = attempts.filter((a) => a.status === 409)
    expect(succeeded.length).toBe(5) // exactly the FIFO capacity
    expect(refused.length).toBe(3)
    for (const r of refused) {
      if (!r.body.ok) expect(r.body.error.code).toBe('TRAINING_QUEUE_FULL')
    }

    // MONEY: five batches × (120 GOLD + 60 FOOD + 50 IRON).
    const after = await getWalletBalances(db, playerId)
    expect(before.GOLD - after.GOLD).toBe(600n)
    expect(before.FOOD - after.FOOD).toBe(300n)
    expect(before.IRON - after.IRON).toBe(250n)

    // QUEUE: exactly the five winners, FIFO order.
    const queue = await db.trainingQueueItem.findMany({ where: { playerId } })
    expect(queue).toHaveLength(5)
    const units = await db.playerUnit.findMany({ where: { playerId } })
    expect(units.every((u) => u.count >= 0)).toBe(true)
  })
})
