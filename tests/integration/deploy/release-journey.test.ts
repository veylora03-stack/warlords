/**
 * Integration tests — RELEASE ACCEPTANCE: the critical user journey.
 *
 * Telegram → /start (bot webhook) → PLAY (web_app button) → Mini App →
 * Authentication → Create Player → City → Collect Resources → Upgrade
 * Building → Train Army → Attack Player (REAL route: the Phase 28 battle
 * engine answers with its typed protection rail; the full combat journey
 * lives in tests/integration/battle + tests/e2e/battle-journey) →
 * Ranking → Notifications → read state.
 *
 * Every step is the REAL stack: real initData HMAC exchange, real bootstrap
 * transaction, real construction/training timers (server clock is the only
 * authority), real ledger reconciliation, real ranking computation. The ONLY
 * injected boundary is the Telegram bot transport (the network is never
 * dialed — the same DI rule every suite follows), and the notification drain
 * runs with an explicit null-token config (channel SKIPPED, inbox rows real).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { STARTER_WALLET } from '../../../src/lib/game/config/starter'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as meGet } from '../../../src/app/api/v1/auth/me/route'
import { GET as cityGet } from '../../../src/app/api/v1/city/route'
import { POST as upgradePost } from '../../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import { POST as finishPost } from '../../../src/app/api/v1/city/buildings/[type]/finish/route'
import { GET as armyGet } from '../../../src/app/api/v1/army/route'
import { POST as trainPost } from '../../../src/app/api/v1/army/train/route'
import { POST as trainCompletePost } from '../../../src/app/api/v1/army/train/[id]/complete/route'
import { POST as attackPost } from '../../../src/app/api/v1/battles/attack/route'
import { GET as targetsGet } from '../../../src/app/api/v1/battles/targets/route'
import { GET as historyGet } from '../../../src/app/api/v1/battles/route'
import { GET as resourcesGet } from '../../../src/app/api/v1/player/resources/route'
import { GET as transactionsGet } from '../../../src/app/api/v1/player/transactions/route'
import { GET as seasonGet } from '../../../src/app/api/v1/season/route'
import { GET as rankingGet } from '../../../src/app/api/v1/season/ranking/route'
import { GET as notificationsGet } from '../../../src/app/api/v1/player/notifications/route'
import { GET as unreadGet } from '../../../src/app/api/v1/player/notifications/unread-count/route'
import { POST as readPost } from '../../../src/app/api/v1/player/notifications/read/route'
import { handleWebhookRequest, type WebhookDeps } from '../../../src/lib/telegram/webhook.service'
import { createBotRouter } from '../../../src/lib/telegram/bot'
import {
  loadPlayerSnapshotByTelegramId,
  loadRankingSnapshot,
  TELEGRAM_WEBHOOK_HEADER,
} from '../../../src/lib/telegram/webhook.service'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']
if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Release-journey tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_ID = '9100027701'
const IP_BASE = '198.51.102.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let token = ''
let playerId = ''

const sent: Array<{ chatId: string; text: string; replyMarkup?: Record<string, unknown> }> = []

function webhookDeps(): WebhookDeps {
  return {
    botToken: BOT_TOKEN!,
    webhookSecret: 'release-journey-webhook-secret',
    router: createBotRouter({
      appUrl: 'https://warlords.example.com',
      getSnapshotByTelegramId: loadPlayerSnapshotByTelegramId,
      getRankingSnapshot: loadRankingSnapshot,
    }),
    sendMessage: async (input) => {
      sent.push({ chatId: input.chatId, text: input.text, replyMarkup: input.replyMarkup })
    },
  }
}

function webhookRequest(update: unknown): Request {
  return new Request('https://warlords.example.com/api/v1/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_WEBHOOK_HEADER]: 'release-journey-webhook-secret',
    },
    body: JSON.stringify(update),
  })
}

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAF9tE0aAAAA${telegramId}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'Release',
      username: 'release_lord',
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

function request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-forwarded-for': nextIp(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function routeCtx(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) }
}

const parse = async (res: Response): Promise<ApiEnvelope<Record<string, unknown>>> =>
  (await res.json()) as ApiEnvelope<Record<string, unknown>>

beforeAll(async () => {
  await purgeTestUsersByTelegramPrefix(db, '9100027')
})

afterAll(async () => {
  await purgeTestUsersByTelegramPrefix(db, '9100027')
})

// ── The journey ──────────────────────────────────────────────────────────────

describe('RELEASE JOURNEY — the exact critical path from the Phase 27 contract', () => {
  it('STEP 1-2 — Telegram /start greets with a PLAY button, then initData exchange creates the player', async () => {
    // 1) The player types /start in the bot chat (webhook delivery).
    const bot = await handleWebhookRequest(
      webhookRequest({
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: Number(TG_ID), first_name: 'Release' },
          text: '/start',
        },
      }),
      webhookDeps(),
    )
    expect(bot.status).toBe(200)
    const reply = sent[0]
    expect(reply?.chatId).toBe(TG_ID)
    expect(reply?.text).toContain('Welcome to WARLORDS, Release!')
    // The PLAY button is the bridge into the Mini App.
    expect(reply?.replyMarkup?.inline_keyboard?.[0]?.[0]?.web_app?.url).toBe(
      'https://warlords.example.com',
    )

    // 2) The Mini App booted and exchanged initData (CREATE PLAYER).
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ initData: buildInitData(TG_ID) }),
      }),
    )
    expect(res.status).toBe(200)
    const body = await parse(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    token = body.data.token as string
    playerId = (body.data.player as { id: string }).id

    // Bootstrap is transactional and real: starter wallet + city exist.
    const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
    expect(wallet.gold).toBe(BigInt(STARTER_WALLET.GOLD))
    const city = await db.city.findUniqueOrThrow({ where: { playerId } })
    expect(city.playerId).toBe(playerId)
  }, 30_000)

  it('STEP 3 — authentication: /auth/me resolves the session identity server-side', async () => {
    const res = await meGet(request('/api/v1/auth/me'))
    expect(res.status).toBe(200)
    const body = await parse(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect((body.data.player as { id: string }).id).toBe(playerId)
  })

  it('STEP 4 — city: the starter city exposes the full building roster', async () => {
    const res = await cityGet(request('/api/v1/city'))
    expect(res.status).toBe(200)
    const body = await parse(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    const buildings = body.data.buildings as Array<{ type: string; level: number }>
    expect(buildings.length).toBeGreaterThanOrEqual(10)
    expect(buildings.every((b) => b.level === 1)).toBe(true)
  })

  it('STEP 5 — collect resources: wallet + ledger history are live', async () => {
    const res = await resourcesGet(request('/api/v1/player/resources'))
    expect(res.status).toBe(200)
    const body = await parse(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    const resources = body.data.resources as Array<{ key: string; balance: string }>
    for (const key of ['GOLD', 'WOOD', 'IRON', 'FOOD', 'CRYSTAL', 'GEMS']) {
      const entry = resources.find((r) => r.key === key)
      expect(entry).toBeDefined()
      expect(Number(entry!.balance)).toBeGreaterThanOrEqual(0)
      // Caps/headroom are server-computed — clients never do authority math.
      expect(entry!.cap).toBeDefined()
      expect(entry!.headroom).toBeDefined()
    }

    // Ledger-first economy: even the bootstrap faucet is a ledger row.
    const ledger = await parse(
      await transactionsGet(request('/api/v1/player/transactions?limit=5')),
    )
    expect(ledger.ok).toBe(true)
    if (!ledger.ok) return
    expect((ledger.data.entries as unknown[]).length).toBeGreaterThan(0)
  })

  it('STEP 6-7 — upgrade building + train army: real timers, exact debits, season points', async () => {
    // Start the FARM upgrade (server-side cost, server-side timer).
    const start = await upgradePost(
      request('/api/v1/city/buildings/FARM/upgrade', 'POST'),
      routeCtx({ type: 'FARM' }),
    )
    expect(start.status).toBe(200)
    const startBody = await parse(start)
    expect(startBody.ok).toBe(true)
    if (!startBody.ok) return
    expect(startBody.data.construction).not.toBeNull()
    const walletAfterUpgrade = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
    expect(walletAfterUpgrade.gold).toBe(BigInt(STARTER_WALLET.GOLD - 120))
    expect(walletAfterUpgrade.wood).toBe(BigInt(STARTER_WALLET.WOOD - 100))

    // Start training in the SAME window so both timers mature together
    // (swordsman: 22 s per unit — the training window exceeds construction).
    const train = await trainPost(
      request('/api/v1/army/train', 'POST', { unitId: 'swordsman', count: 1 }),
    )
    expect(train.status).toBe(200)
    const trainBody = await parse(train)
    expect(trainBody.ok).toBe(true)
    if (!trainBody.ok) return
    const queue = trainBody.data.queue as Array<{ id: string; count: number }>
    expect(queue).toHaveLength(1)
    expect(queue[0]!.count).toBe(1)
    const trainItemId = queue[0]!.id
    const walletAfterTrain = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
    expect(walletAfterTrain.gold).toBe(BigInt(STARTER_WALLET.GOLD - 120 - 120))
    expect(walletAfterTrain.food).toBe(BigInt(STARTER_WALLET.FOOD - 60))
    expect(walletAfterTrain.iron).toBe(BigInt(STARTER_WALLET.IRON - 50))

    // The server clock is the only authority — early claims are refused.
    const earlyFinish = await finishPost(
      request('/api/v1/city/buildings/FARM/finish', 'POST'),
      routeCtx({ type: 'FARM' }),
    )
    expect(earlyFinish.status).toBe(409)
    const earlyComplete = await trainCompletePost(
      request(`/api/v1/army/train/${trainItemId}/complete`, 'POST'),
      routeCtx({ id: trainItemId }),
    )
    expect(earlyComplete.status).toBe(409)

    // Wait out the REAL timers (construction 12 s, training 22 s) with margin.
    await new Promise((resolve) => setTimeout(resolve, 25_000))

    // Claim the building — exact season points (10 × new level 2).
    const finish = await finishPost(
      request('/api/v1/city/buildings/FARM/finish', 'POST'),
      routeCtx({ type: 'FARM' }),
    )
    expect(finish.status).toBe(200)
    const finishBody = await parse(finish)
    expect(finishBody.ok).toBe(true)
    if (!finishBody.ok) return
    expect((finishBody.data.building as { level: number }).level).toBe(2)
    expect(finishBody.data.seasonPoints).toBe(20)

    // Claim the army batch — roster grows by exactly 2.
    const complete = await trainCompletePost(
      request(`/api/v1/army/train/${trainItemId}/complete`, 'POST'),
      routeCtx({ id: trainItemId }),
    )
    expect(complete.status).toBe(200)
    const army = await parse(await armyGet(request('/api/v1/army')))
    expect(army.ok).toBe(true)
    if (!army.ok) return
    const stacks = army.data.units as Array<{ unitId: string; count: number }>
    const swordsman = stacks.find((s) => s.unitId === 'swordsman')
    // 20 from the starter kit (roster bootstrap) + 1 trained this journey.
    expect(swordsman?.count).toBe(21)
  }, 90_000)

  it('STEP 8 — attack player: the REAL battle route answers with its protection rail', async () => {
    // The Phase 28 battle engine is LIVE. The journey player attacks a
    // freshly-created second player: the server-authoritative protection
    // rules honestly refuse the raid (PROTECTED_TARGET 403) — a real route
    // round-trip that mutates NO progression, so the journey's exact season
    // arithmetic below stays intact. The complete combat journey
    // (attack → combat → casualties → rewards → ranking → notifications →
    // history) is verified end-to-end by tests/e2e/battle-journey.test.ts.
    const targetTgId = '9100027702'
    const targetRes = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ initData: buildInitData(targetTgId) }),
      }),
    )
    expect(targetRes.status).toBe(200)
    const targetBody = await parse(targetRes)
    expect(targetBody.ok).toBe(true)
    if (!targetBody.ok) return
    const targetToken = targetBody.data.token as string
    const targetPlayerId = (targetBody.data.player as { id: string }).id

    const attackRes = await attackPost(
      request('/api/v1/battles/attack', 'POST', { targetPlayerId }),
    )
    expect(attackRes.status).toBe(403)
    const attackBody = await parse(attackRes)
    expect(attackBody.ok).toBe(false)
    expect((attackBody.error as { code: string } | undefined)?.code).toBe('PROTECTED_TARGET')

    // The attack surfaces exist for the player and stay participant-scoped:
    // the target roster lists the fresh world WITHOUT any army payload.
    const targetsRes = await targetsGet(request('/api/v1/battles/targets'))
    expect(targetsRes.status).toBe(200)
    const targetsBody = await parse(targetsRes)
    expect(targetsBody.ok).toBe(true)
    expect(JSON.stringify(targetsBody.data)).not.toContain('unitTypeId')

    // The target's own history endpoint is live and empty.
    const historyRes = await historyGet(
      new Request('http://localhost:3000/api/v1/battles', {
        headers: { authorization: `Bearer ${targetToken}`, 'x-forwarded-for': nextIp() },
      }),
    )
    expect(historyRes.status).toBe(200)
    const historyBody = await parse(historyRes)
    expect((historyBody.data as { total: number }).total).toBe(0)
  })

  it('STEP 9 — ranking: the journey points place the player in the live season standing', async () => {
    const view = await parse(await seasonGet(request('/api/v1/season')))
    expect(view.ok).toBe(true)
    if (!view.ok) return
    const me = view.data.me as { seasonPoints: number; rank: number | null }
    expect(me.seasonPoints).toBe(22) // 20 (construction) + 2 (tier-1 unit trained)

    const ranking = await parse(await rankingGet(request('/api/v1/season/ranking?limit=10')))
    expect(ranking.ok).toBe(true)
    if (!ranking.ok) return
    const live = ranking.data.live as Array<{ playerId: string; score: number }>
    const meRow = live.find((row) => row.playerId === playerId)
    expect(meRow).toBeDefined()
    expect(meRow?.score).toBe(22)
  })

  it('STEP 10 — notifications: construction + training events delivered; mark-read idempotent', async () => {
    // Drain the queue the way the production worker re-ticks (null-token
    // channel: the network is never dialed; inbox rows are the real artifact).
    for (let tick = 0; tick < 10; tick++) {
      const ticked = await drainNotificationQueue({
        batchSize: 50,
        telegramConfig: { token: null },
      })
      if (ticked.claimed === 0) break
    }

    const inbox = await parse(
      await notificationsGet(request('/api/v1/player/notifications?limit=20')),
    )
    expect(inbox.ok).toBe(true)
    if (!inbox.ok) return
    const items = inbox.data.notifications as Array<{ type: string }>
    const types = new Set(items.map((n) => n.type))
    expect(types.has('CONSTRUCTION_COMPLETE')).toBe(true)
    expect(types.has('TRAINING_COMPLETE')).toBe(true)

    const unreadBefore = await parse(
      await unreadGet(request('/api/v1/player/notifications/unread-count')),
    )
    expect(unreadBefore.ok).toBe(true)
    if (!unreadBefore.ok) return
    const before = (unreadBefore.data as { unreadCount: number }).unreadCount
    expect(before).toBeGreaterThanOrEqual(2)

    const mark = await parse(
      await readPost(request('/api/v1/player/notifications/read', 'POST', { all: true })),
    )
    expect(mark.ok).toBe(true)
    const unreadAfter = await parse(
      await unreadGet(request('/api/v1/player/notifications/unread-count')),
    )
    if (!unreadAfter.ok) return
    expect((unreadAfter.data as { unreadCount: number }).unreadCount).toBe(0)

    // Replay is a no-op (idempotent mark-read).
    await readPost(request('/api/v1/player/notifications/read', 'POST', { all: true }))
    const unreadReplay = await parse(
      await unreadGet(request('/api/v1/player/notifications/unread-count')),
    )
    if (!unreadReplay.ok) return
    expect((unreadReplay.data as { unreadCount: number }).unreadCount).toBe(0)
  })
})
