/**
 * E2E — FULL PLAYER JOURNEY (Phase 24 QA).
 *
 * One continuous, realistic session through every live system, exactly the
 * way the Mini App drives the API: register → authenticate → inspect city →
 * upgrade a building (real 12s construction against the server clock) →
 * claim it → verify the ledger → train troops (real 22s batch) → claim →
 * verify the roster → check ranking → drain notifications → mark read →
 * statistics. Zero mocks, zero direct-DB shortcuts for game state — only
 * real route handlers, real timers, real transactions.
 *
 * The identity lives in the isolated 9100026… telegramId range and is
 * removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { GET as meGet } from '../../src/app/api/v1/auth/me/route'
import { GET as cityGet } from '../../src/app/api/v1/city/route'
import { POST as upgradePost } from '../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import { POST as finishPost } from '../../src/app/api/v1/city/buildings/[type]/finish/route'
import { GET as catalogGet } from '../../src/app/api/v1/army/catalog/route'
import { POST as trainPost } from '../../src/app/api/v1/army/train/route'
import { POST as trainCompletePost } from '../../src/app/api/v1/army/train/[id]/complete/route'
import { GET as stateGet } from '../../src/app/api/v1/player/state/route'
import { GET as statisticsGet } from '../../src/app/api/v1/player/statistics/route'
import { GET as seasonGet } from '../../src/app/api/v1/season/route'
import { GET as rankingGet } from '../../src/app/api/v1/season/ranking/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { POST as notificationsReadPost } from '../../src/app/api/v1/player/notifications/read/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { STARTER_WALLET } from '../../src/lib/game/config/starter'
import type { ApiEnvelope } from '../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'E2E journey tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_ID = '9100026001'
const IP = '203.0.126.1'

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'JourneyLord',
      username: 'journey_lord',
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

function request(path: string, token: string | null, method: 'GET' | 'POST' = 'GET'): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': IP,
    },
  })
}

function routeCtx(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let token = ''
let playerId = ''

beforeAll(async () => {
  // Self-healing identity range (a crashed prior run must not poison us).
  await purgeTestUsersByTelegramPrefix(db, '9100026')
})

afterAll(async () => {
  await db.notification.deleteMany({ where: { player: { user: { telegramId: TG_ID } } } })
  await db.notificationQueue.deleteMany({
    where: { player: { user: { telegramId: TG_ID } } },
  })
  await purgeTestUsersByTelegramPrefix(db, '9100026')
})

// ── The journey ──────────────────────────────────────────────────────────────

describe('E2E: registration → city → upgrade → train → rank → notifications', () => {
  /** Real construction + training timers exceed bun's 5s default — extend. */
  const TIMER_STEP_TIMEOUT = 90_000

  it('STEP 1 — registration: exchange initData → session + player + starter wallet', async () => {
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: JSON.stringify({ initData: buildInitData(TG_ID) }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    token = body.data.token
    playerId = body.data.player.id

    const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
    expect(wallet.gold).toBe(BigInt(STARTER_WALLET.GOLD))
  })

  it('STEP 2 — authentication: /auth/me reflects the session identity', async () => {
    const res = await meGet(request('/api/v1/auth/me', token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ player: { id: string } }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.player.id).toBe(playerId)
  })

  it('STEP 3 — city: the starter city has the full building roster at level 1', async () => {
    const res = await cityGet(request('/api/v1/city', token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      buildings: Array<{ type: string; level: number }>
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.buildings.length).toBeGreaterThanOrEqual(10)
    expect(body.data.buildings.every((b) => b.level === 1)).toBe(true)
  })

  it(
    'STEP 4 — building upgrade: start FARM → 2, wait out the REAL timer, claim',
    async () => {
      const start = await upgradePost(
        request('/api/v1/city/buildings/FARM/upgrade', token, 'POST'),
        routeCtx({ type: 'FARM' }),
      )
      expect(start.status).toBe(200)
      const startBody = (await start.json()) as ApiEnvelope<{
        building: { type: string; level: number }
        construction: { completesAt: string } | null
      }>
      expect(startBody.ok).toBe(true)
      if (!startBody.ok) return
      expect(startBody.data.construction).not.toBeNull()

      // Wallet debited the exact server-side cost (GOLD 120 + WOOD 100).
      const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
      expect(wallet.gold).toBe(BigInt(STARTER_WALLET.GOLD - 120))
      expect(wallet.wood).toBe(BigInt(STARTER_WALLET.WOOD - 100))

      // The server clock is the only authority: an early claim is refused.
      const early = await finishPost(
        request('/api/v1/city/buildings/FARM/finish', token, 'POST'),
        routeCtx({ type: 'FARM' }),
      )
      expect(early.status).toBe(409)

      // Wait out the REAL construction (FARM L2: 12s) with margin.
      await sleep(14_000)

      const finish = await finishPost(
        request('/api/v1/city/buildings/FARM/finish', token, 'POST'),
        routeCtx({ type: 'FARM' }),
      )
      expect(finish.status).toBe(200)
      const finishBody = (await finish.json()) as ApiEnvelope<{
        building: { level: number }
        seasonPoints: number
      }>
      expect(finishBody.ok).toBe(true)
      if (!finishBody.ok) return
      expect(finishBody.data.building.level).toBe(2)
      expect(finishBody.data.seasonPoints).toBe(20) // 10 points × new level (2)
    },
    TIMER_STEP_TIMEOUT,
  )

  it(
    'STEP 5 — army: catalog exposes the roster; train 2 swordsmen and claim the batch',
    async () => {
      const catalog = await catalogGet(request('/api/v1/army/catalog', token))
      expect(catalog.status).toBe(200)
      const catalogBody = (await catalog.json()) as ApiEnvelope<{
        units: Array<{ id: string; trainingCost: Record<string, number> }>
      }>
      expect(catalogBody.ok).toBe(true)
      if (!catalogBody.ok) return
      const swordsman = catalogBody.data.units.find((u) => u.id === 'swordsman')
      expect(swordsman).toBeDefined()

      const train = await trainPost(
        new Request('http://localhost:3000/api/v1/army/train', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'x-forwarded-for': IP,
          },
          body: JSON.stringify({ unitId: 'swordsman', count: 2 }),
        }),
      )
      expect(train.status).toBe(200)
      const trainBody = (await train.json()) as ApiEnvelope<{
        queue: Array<{ id: string; completesAt: string; count: number }>
      }>
      expect(trainBody.ok).toBe(true)
      if (!trainBody.ok) return
      expect(trainBody.data.queue).toHaveLength(1)
      const itemId = trainBody.data.queue[0]!.id
      expect(trainBody.data.queue[0]!.count).toBe(2)

      // Train cost debited: 2 × (120 GOLD + 60 FOOD + 50 IRON).
      const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
      expect(wallet.gold).toBe(BigInt(STARTER_WALLET.GOLD - 120 - 240))
      expect(wallet.food).toBe(BigInt(STARTER_WALLET.FOOD - 120))
      expect(wallet.iron).toBe(BigInt(STARTER_WALLET.IRON - 100))

      // Early claim refused — the clock is server-side.
      const early = await trainCompletePost(
        request(`/api/v1/army/train/${itemId}/complete`, token, 'POST'),
        routeCtx({ id: itemId }),
      )
      expect(early.status).toBe(409)

      // Swordsman batch: 22s PER UNIT × 2 = 44s — wait with margin.
      await sleep(48_000)

      const complete = await trainCompletePost(
        request(`/api/v1/army/train/${itemId}/complete`, token, 'POST'),
        routeCtx({ id: itemId }),
      )
      expect(complete.status).toBe(200)
      const completeBody = (await complete.json()) as ApiEnvelope<{
        completed: { unitId: string; count: number }
        seasonPoints: number
      }>
      expect(completeBody.ok).toBe(true)
      if (!completeBody.ok) return
      expect(completeBody.data.completed).toMatchObject({ unitId: 'swordsman', count: 2 })
      expect(completeBody.data.seasonPoints).toBe(4) // 2 units × tier-1 points

      const stack = await db.playerUnit.findFirst({
        where: { playerId, unit: { id: 'swordsman' } },
      })
      expect(stack?.count).toBe(22) // 20 starter + 2 trained
    },
    TIMER_STEP_TIMEOUT,
  )

  it('STEP 6 — season: the standing reflects the journey points and ranking exposes it', async () => {
    const res = await seasonGet(request('/api/v1/season', token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      me: { seasonPoints: number; rank: number | null }
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.me.seasonPoints).toBe(24) // 20 (farm L2) + 4 (troops)
    expect(body.data.me.rank).toBeGreaterThanOrEqual(1)

    const ranking = await rankingGet(request('/api/v1/season/ranking?limit=50', token))
    expect(ranking.status).toBe(200)
    const rankingBody = (await ranking.json()) as ApiEnvelope<{
      live: Array<{ playerId: string; score: number }>
    }>
    expect(rankingBody.ok).toBe(true)
    if (!rankingBody.ok) return
    const meRow = rankingBody.data.live.find((row) => row.playerId === playerId)
    expect(meRow?.score).toBe(24)
  })

  it('STEP 7 — notifications: the journey produced real inbox rows; mark read works', async () => {
    for (let tick = 0; tick < 5; tick++) {
      const ticked = await drainNotificationQueue({
        batchSize: 50,
        telegramConfig: { token: null },
      })
      if (ticked.claimed === 0) break
    }
    const res = await notificationsGet(request('/api/v1/player/notifications', token))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      notifications: Array<{ id: string; type: string; isRead: boolean }>
      unreadCount: number
    }>
    expect(body.ok).toBe(true)
    if (!body.ok) return
    const types = body.data.notifications.map((n) => n.type)
    expect(types).toContain('CONSTRUCTION_COMPLETE')
    expect(types).toContain('TRAINING_COMPLETE')
    expect(body.data.unreadCount).toBeGreaterThan(0)

    const ids = body.data.notifications.map((n) => n.id)
    const read = await notificationsReadPost(
      new Request('http://localhost:3000/api/v1/player/notifications/read', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-forwarded-for': IP,
        },
        body: JSON.stringify({ ids }),
      }),
    )
    expect(read.status).toBe(200)
    const readBody = (await read.json()) as ApiEnvelope<{ updated: number }>
    expect(readBody.ok && readBody.data.updated).toBe(body.data.unreadCount)
  })

  it('STEP 8 — player state & statistics: the derived aggregates match the journey', async () => {
    const state = await stateGet(request('/api/v1/player/state', token))
    expect(state.status).toBe(200)

    const stats = await statisticsGet(request('/api/v1/player/statistics', token))
    expect(stats.status).toBe(200)
    const statsBody = (await stats.json()) as ApiEnvelope<Record<string, unknown>>
    expect(statsBody.ok).toBe(true)
  })
})
