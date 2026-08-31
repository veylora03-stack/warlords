/**
 * WARLORDS — Integration tests: notification system (Phase 22).
 *
 * Real routes, real DB, real engine — no mocks of the code under test.
 * The Telegram transport and capability state are INJECTED per drain
 * (fetchImpl + telegramConfig seams), so the suite exercises the real
 * delivery path — including retry classification and the honest
 * TELEGRAM_NOT_CONFIGURED skip — without ever touching the network.
 *
 *  1. PERMISSIONS     — inbox is session-scoped; ops endpoints are RBAC-gated
 *  2. DEDUPE          — (player,type,dedupeKey) unique · idempotent enqueue ·
 *                       event-identity keys · fail-closed guards
 *  3. QUEUEABLE       — PENDING → claim → render → inbox → SENT with
 *                       notificationId backlink; re-drain never re-delivers
 *  4. TELEGRAM        — configured+OK pushes (injected transport) ·
 *                       unconfigured → SKIPPED with explicit reason ·
 *                       retryable vs permanent failure classification
 *  5. RECOVERY        — stale PROCESSING rows are re-claimed and completed;
 *                       attempts bound poison rows to FAILED
 *  6. INBOX API       — list/unread-count/read mark only the caller's rows
 *  7. FAN-OUTS        — admin EVENT spawn (GLOBAL vs PLAYER scope) +
 *                       settlement-style RANK_CHANGE payloads through the engine
 *  8. RETENTION       — terminal queue rows + read inbox rows pruned
 *
 * Test identities live in the isolated 9100033… telegramId range and are
 * removed in afterAll (everything cascades; audit/event rows explicitly).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as notificationsGet } from '../../../src/app/api/v1/player/notifications/route'
import { GET as unreadCountGet } from '../../../src/app/api/v1/player/notifications/unread-count/route'
import { POST as markReadPost } from '../../../src/app/api/v1/player/notifications/read/route'
import { POST as adminTickPost } from '../../../src/app/api/v1/admin/notifications/worker/tick/route'
import { GET as adminQueueGet } from '../../../src/app/api/v1/admin/notifications/queue/route'
import { POST as adminEventsPost } from '../../../src/app/api/v1/admin/events/route'
import {
  drainNotificationQueue,
  enqueueNotificationFanOutInTx,
  enqueueNotificationInTx,
  markNotificationsRead,
  pruneNotificationStorage,
} from '../../../src/lib/game/services/notification.service'
import { notificationDedupeKeys } from '../../../src/lib/game/config/notifications'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Notification integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_BASE = '9100033'
let tgCounter = 1
const nextTgId = (): string => `${TG_BASE}${String(tgCounter++).padStart(3, '0')}`
const tgIds: string[] = []

const IP_BASE = '203.0.131.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `NotifLord${telegramId.slice(-3)}`,
      username: `notif_lord_${telegramId.slice(-4)}`,
      language_code: 'en',
    }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  // The WIRE format is urlencoded (checkString is only the HMAC input).
  return new URLSearchParams({ ...fields, hash }).toString()
}

function request(url: string, token: string | null, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function parse<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

/** Full login exchange (initData → session) for the given telegram id. */
async function exchange(
  telegramId: string,
): Promise<{ token: string; userId: string; playerId: string }> {
  const res = await telegramPost(
    request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(telegramId) }),
  )
  expect(res.status).toBe(200)
  const body = await parse<{
    token: string
    user: { id: string; telegramId: string }
    player: { id: string }
  }>(res)
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error('exchange failed')
  tgIds.push(telegramId)
  return { token: body.data.token, userId: body.data.user.id, playerId: body.data.player.id }
}

// ── Transport fixtures (injected — never the network) ───────────────────────

const TELEGRAM_OFF = { token: null }
const TELEGRAM_ON = { token: BOT_TOKEN }

/** Transport that reports a successful Telegram sendMessage. */
const telegramOkFetch: typeof fetch = async (_url, init) => {
  lastPush = JSON.parse(String(init?.body)) as { chat_id: string; text: string }
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}

/** Transport that reports a rate-limit (429) — retryable. */
const telegramThrottledFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), { status: 429 })

/** Transport that reports a permanent rejection (403 bot blocked). */
const telegramBlockedFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
    {
      status: 403,
    },
  )

let lastPush: { chat_id: string; text: string } | null = null

// ── State ────────────────────────────────────────────────────────────────────

let playerToken = ''
let playerId = ''
let otherPlayerId = ''
let adminToken = ''

beforeAll(async () => {
  const first = await exchange(nextTgId())
  playerToken = first.token
  playerId = first.playerId
  const second = await exchange(nextTgId())
  otherPlayerId = second.playerId
  const third = await exchange(nextTgId())
  adminToken = third.token
  await db.adminUser.create({
    data: { userId: third.userId, role: 'ADMIN', isActive: true },
  })
})

afterAll(async () => {
  const users = await db.user.findMany({
    where: { telegramId: { in: tgIds } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  const playerIds = [playerId, otherPlayerId].filter(Boolean)
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  await db.auditLog.deleteMany({ where: { targetId: { in: playerIds } } })
  await db.gameEvent.deleteMany({ where: { createdById: { in: userIds } } })
  await db.adminUser.deleteMany({ where: { userId: { in: userIds } } })
  await db.user.deleteMany({ where: { telegramId: { in: tgIds } } })
})

// ── 1. Permissions ───────────────────────────────────────────────────────────

describe('inbox + ops permissions (server-side, never a hidden button)', () => {
  it('anonymous inbox request → 401', async () => {
    const res = await notificationsGet(request('/api/v1/player/notifications', null))
    expect(res.status).toBe(401)
  })

  it('non-staff player on the worker tick → 403 ADMIN_REQUIRED', async () => {
    const res = await adminTickPost(
      request('/api/v1/admin/notifications/worker/tick', playerToken, 'POST'),
    )
    expect(res.status).toBe(403)
    const body = await parse<unknown>(res)
    if (!body.ok) expect(body.error.code).toBe('ADMIN_REQUIRED')
  })

  it('non-staff player on the queue ops view → 403 ADMIN_REQUIRED', async () => {
    const res = await adminQueueGet(request('/api/v1/admin/notifications/queue', playerToken))
    expect(res.status).toBe(403)
  })

  it('admin (DB-backed row + notifications.drain scope) can tick and view the queue', async () => {
    const tick = await adminTickPost(
      request('/api/v1/admin/notifications/worker/tick', adminToken, 'POST'),
    )
    expect(tick.status).toBe(200)
    const tickBody = await parse<{
      claimed: number
      sent: number
      skipped: number
      retried: number
      failed: number
      pruned: { queueDeleted: number; inboxDeleted: number }
    }>(tick)
    expect(tickBody.ok).toBe(true)

    const view = await adminQueueGet(request('/api/v1/admin/notifications/queue', adminToken))
    expect(view.status).toBe(200)
    const viewBody = await parse<{
      stats: Array<{ status: string; count: number }>
      rows: unknown[]
    }>(view)
    expect(viewBody.ok).toBe(true)
    expect(Array.isArray(viewBody.data!.rows)).toBe(true)
  })
})

// ── 2. Dedupe ────────────────────────────────────────────────────────────────

describe('dedupe — a retried action can never re-notify', () => {
  it('same (player, type, dedupeKey) twice enqueues exactly one row', async () => {
    const key = notificationDedupeKeys.training('dedupe-spec-1')
    const first = await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'TRAINING_COMPLETE',
        dedupeKey: key,
        payload: { unitId: 'SWORDSMAN', unitName: 'Swordsman', count: 3 },
      }),
    )
    const second = await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'TRAINING_COMPLETE',
        dedupeKey: key,
        payload: { unitId: 'SWORDSMAN', unitName: 'Swordsman', count: 3 },
      }),
    )
    expect(first.enqueued).toBe(true)
    expect(second.enqueued).toBe(false)

    const rows = await db.notificationQueue.findMany({
      where: { playerId, type: 'TRAINING_COMPLETE', dedupeKey: key },
    })
    expect(rows.length).toBe(1)
  })

  it('a NEW event of the same type (different key) enqueues separately', async () => {
    const keys = [
      notificationDedupeKeys.construction('dedupe-building', 2),
      notificationDedupeKeys.construction('dedupe-building', 3),
    ]
    for (const [i, key] of keys.entries()) {
      const result = await db.$transaction((tx) =>
        enqueueNotificationInTx(tx, {
          playerId,
          type: 'CONSTRUCTION_COMPLETE',
          dedupeKey: key,
          payload: { buildingType: 'FARM', buildingName: 'Farm', level: i + 2 },
        }),
      )
      expect(result.enqueued).toBe(true)
    }
    const rows = await db.notificationQueue.findMany({
      where: { playerId, type: 'CONSTRUCTION_COMPLETE', dedupeKey: { in: keys } },
    })
    expect(rows.length).toBe(2)
  })

  it('rejects invalid payloads and unblessed channels (fail-closed)', async () => {
    await expect(
      db.$transaction((tx) =>
        enqueueNotificationInTx(tx, {
          playerId,
          type: 'TRAINING_COMPLETE',
          dedupeKey: 'bad-payload-1',
          payload: { unitId: 'SWORDSMAN', unitName: 'Swordsman', count: -5 },
        }),
      ),
    ).rejects.toThrow()

    await expect(
      db.$transaction((tx) =>
        enqueueNotificationInTx(tx, {
          playerId,
          type: 'CONSTRUCTION_COMPLETE',
          dedupeKey: 'bad-channel-1',
          payload: { buildingType: 'FARM', buildingName: 'Farm', level: 2 },
          channels: ['TELEGRAM'], // not blessed for this type — config-bug guard
        }),
      ),
    ).rejects.toThrow(/not enabled/)
  })
})

// ── 3. Queueable end-to-end ──────────────────────────────────────────────────

describe('queueable pipeline — enqueue → claim → render → inbox → SENT', () => {
  it('delivers once with the server-rendered text and a backlink; re-drain is a no-op', async () => {
    const key = notificationDedupeKeys.quest(playerId, 'quest-e2e-1')
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'QUEST_COMPLETED',
        dedupeKey: key,
        payload: { questId: 'quest-e2e-1', questName: 'Provisions', rewardSummary: '150 gold.' },
      }),
    )

    const result = await drainNotificationQueue({
      workerId: 'notif-e2e',
      telegramConfig: TELEGRAM_OFF,
    })
    expect(result.claimed).toBeGreaterThanOrEqual(1)

    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'QUEST_COMPLETED', dedupeKey: key } },
    })
    expect(row!.status).toBe('SENT')
    expect(row!.notificationId).not.toBeNull()
    expect(row!.processedAt).not.toBeNull()

    const inbox = await db.notification.findUnique({ where: { id: row!.notificationId! } })
    expect(inbox).not.toBeNull()
    expect(inbox!.title).toBe('Quest complete — Provisions')
    expect(inbox!.body).toContain('150 gold')

    // Idempotent: a second tick re-delivers nothing.
    const inboxCountBefore = await db.notification.count({
      where: { playerId, type: 'QUEST_COMPLETED' },
    })
    await drainNotificationQueue({ workerId: 'notif-e2e-b', telegramConfig: TELEGRAM_OFF })
    const inboxCountAfter = await db.notification.count({
      where: { playerId, type: 'QUEST_COMPLETED' },
    })
    expect(inboxCountAfter).toBe(inboxCountBefore)
  })
})

// ── 4. Telegram channel ──────────────────────────────────────────────────────

describe('telegram channel — capability-honest delivery', () => {
  async function enqueueAttack(dedupeKey: string) {
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'ATTACK_INCOMING',
        dedupeKey,
        payload: {
          marchId: dedupeKey,
          attackerName: 'Raider',
          targetCoord: { x: 5, y: 6 },
          arrivesInSeconds: 90,
        },
      }),
    )
  }

  it('configured channel pushes through the transport and marks the row SENT', async () => {
    const dedupeKey = notificationDedupeKeys.attackIncoming('march-tg-2', 'def-tg-2')
    await enqueueAttack(dedupeKey)

    lastPush = null
    const result = await drainNotificationQueue({
      workerId: 'notif-tg',
      telegramConfig: TELEGRAM_ON,
      fetchImpl: telegramOkFetch,
    })
    expect(result.sent).toBeGreaterThanOrEqual(1)

    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
    })
    expect(row!.status).toBe('SENT')
    // The push carried the server-rendered text to the player's chat id.
    expect(lastPush).not.toBeNull()
    expect(lastPush!.chat_id).toBe(
      (await db.user.findFirst({ where: { player: { id: playerId } } }))!.telegramId,
    )
    expect(lastPush!.text).toContain('Attack incoming from Raider')
  })

  it('unconfigured channel → SKIPPED with an explicit reason; inbox still delivered', async () => {
    const dedupeKey = notificationDedupeKeys.attackIncoming('march-tg-1', 'def-tg-1')
    await enqueueAttack(dedupeKey)

    const result = await drainNotificationQueue({
      workerId: 'notif-tg-off',
      telegramConfig: TELEGRAM_OFF,
    })
    expect(result.skipped).toBeGreaterThanOrEqual(1)

    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
    })
    expect(row!.status).toBe('SKIPPED')
    expect(row!.lastError).toContain('TELEGRAM_NOT_CONFIGURED')
    // The inbox row exists — the push gap never swallowed the inbox.
    expect(row!.notificationId).not.toBeNull()
  })

  it('429 from the transport → retried with backoff (PENDING, future availableAt)', async () => {
    const dedupeKey = notificationDedupeKeys.attackIncoming('march-tg-3', 'def-tg-3')
    await enqueueAttack(dedupeKey)

    const result = await drainNotificationQueue({
      workerId: 'notif-tg-429',
      telegramConfig: TELEGRAM_ON,
      fetchImpl: telegramThrottledFetch,
    })
    expect(result.retried).toBeGreaterThanOrEqual(1)

    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
    })
    expect(row!.status).toBe('PENDING')
    expect(row!.attempts).toBe(1)
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now())
    // Inbox row was delivered BEFORE the push failed — crash-safe split.
    expect(row!.notificationId).not.toBeNull()
    expect(await db.notification.findUnique({ where: { id: row!.notificationId! } })).not.toBeNull()
  })

  it('403 (bot blocked) → terminal FAILED, no pointless retries', async () => {
    const dedupeKey = notificationDedupeKeys.attackIncoming('march-tg-4', 'def-tg-4')
    await enqueueAttack(dedupeKey)

    const result = await drainNotificationQueue({
      workerId: 'notif-tg-403',
      telegramConfig: TELEGRAM_ON,
      fetchImpl: telegramBlockedFetch,
    })
    expect(result.failed).toBeGreaterThanOrEqual(1)

    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
    })
    expect(row!.status).toBe('FAILED')
    expect(row!.lastError).toContain('blocked')
  })
})

// ── 5. Recovery ──────────────────────────────────────────────────────────────

describe('worker recovery — stale claims and poison rows', () => {
  it('a crashed worker’s stale PROCESSING row is re-claimed and delivered', async () => {
    const key = notificationDedupeKeys.training('stale-spec-1')
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'TRAINING_COMPLETE',
        dedupeKey: key,
        payload: { unitId: 'ARCHER', unitName: 'Archer', count: 1 },
      }),
    )
    const row = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'TRAINING_COMPLETE', dedupeKey: key } },
    })
    // Simulate a worker that claimed and died: PROCESSING with an old claim.
    await db.notificationQueue.update({
      where: { id: row!.id },
      data: {
        status: 'PROCESSING',
        claimedAt: new Date(Date.now() - 10 * 60_000),
        claimedBy: 'ghost-worker',
      },
    })

    const result = await drainNotificationQueue({
      workerId: 'notif-recovery',
      telegramConfig: TELEGRAM_OFF,
    })
    expect(result.claimed).toBeGreaterThanOrEqual(1)

    const after = await db.notificationQueue.findUnique({ where: { id: row!.id } })
    expect(after!.status).toBe('SENT')
  })

  it('attempts are bounded — a permanently failing row parks as FAILED', async () => {
    const dedupeKey = notificationDedupeKeys.attackIncoming('march-poison', 'def-poison')
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'ATTACK_INCOMING',
        dedupeKey,
        payload: {
          marchId: dedupeKey,
          attackerName: 'Raider',
          targetCoord: { x: 1, y: 2 },
          arrivesInSeconds: 60,
        },
      }),
    )

    // Drain repeatedly with an advanced clock so every backoff window passes.
    let now = Date.now()
    for (let i = 0; i < 12; i++) {
      await drainNotificationQueue({
        workerId: `notif-poison-${i}`,
        telegramConfig: TELEGRAM_ON,
        fetchImpl: telegramThrottledFetch,
        now: new Date(now),
      })
      const row = await db.notificationQueue.findUnique({
        where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
      })
      if (row!.status === 'FAILED') {
        expect(row!.attempts).toBe(5) // NOTIFICATION_POLICY.maxAttempts
        break
      }
      expect(row!.status).toBe('PENDING') // still cycling through retries
      now += 10 * 60_000
    }
    const finalRow = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'ATTACK_INCOMING', dedupeKey } },
    })
    expect(finalRow!.status).toBe('FAILED')
  })
})

// ── 6. Inbox API ─────────────────────────────────────────────────────────────

describe('inbox API — list, unread counter, mark read (own rows only)', () => {
  it('lists newest first; unreadOnly filters', async () => {
    const res = await notificationsGet(request('/api/v1/player/notifications', playerToken))
    expect(res.status).toBe(200)
    const body = await parse<{
      notifications: Array<{ id: string; type: string; isRead: boolean; createdAt: string }>
      unreadCount: number
    }>(res)
    expect(body.ok).toBe(true)
    expect(body.data!.notifications.length).toBeGreaterThan(0)
    const times = body.data!.notifications.map((n) => n.createdAt)
    expect([...times].sort().reverse()).toEqual(times)

    const unreadRes = await notificationsGet(
      request('/api/v1/player/notifications?unreadOnly=true', playerToken),
    )
    const unreadBody = await parse<{ notifications: Array<{ isRead: boolean }> }>(unreadRes)
    expect(unreadBody.ok).toBe(true)
    for (const item of unreadBody.data!.notifications) {
      expect(item.isRead).toBe(false)
    }
  })

  it('marking read updates only own rows; unread count follows', async () => {
    // The OTHER player gets a notification for themselves.
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId: otherPlayerId,
        type: 'REWARD',
        dedupeKey: notificationDedupeKeys.welcome(otherPlayerId),
        payload: { rewardTitle: 'Other player reward', rewardBody: 'Belongs to someone else.' },
      }),
    )
    await drainNotificationQueue({ workerId: 'notif-scope', telegramConfig: TELEGRAM_OFF })

    const before = await unreadCountGet(
      request('/api/v1/player/notifications/unread-count', playerToken),
    )
    const beforeBody = await parse<{ unreadCount: number }>(before)
    expect(beforeBody.data!.unreadCount).toBeGreaterThan(0)

    // Cross-player ids in the body CANNOT mark someone else's rows.
    const otherRows = await db.notification.findMany({
      where: { playerId: otherPlayerId },
      select: { id: true },
    })
    const ownRows = await db.notification.findMany({
      where: { playerId, isRead: false },
      select: { id: true },
      take: 2,
    })
    const markRes = await markReadPost(
      request('/api/v1/player/notifications/read', playerToken, 'POST', {
        ids: [...ownRows.map((r) => r.id), ...otherRows.map((r) => r.id)],
      }),
    )
    expect(markRes.status).toBe(200)
    const markBody = await parse<{ updated: number }>(markRes)
    expect(markBody.data!.updated).toBe(ownRows.length)

    const otherStillUnread = await db.notification.count({
      where: { playerId: otherPlayerId, isRead: false },
    })
    expect(otherStillUnread).toBe(1)
  })

  it('read all marks every own unread row in one call', async () => {
    const res = await markReadPost(
      request('/api/v1/player/notifications/read', playerToken, 'POST', { all: true }),
    )
    expect(res.status).toBe(200)
    const unread = await unreadCountGet(
      request('/api/v1/player/notifications/unread-count', playerToken),
    )
    const unreadBody = await parse<{ unreadCount: number }>(unread)
    expect(unreadBody.data!.unreadCount).toBe(0)
  })
})

// ── 7. Fan-outs ──────────────────────────────────────────────────────────────

describe('fan-outs through the engine', () => {
  it('admin EVENT spawn (GLOBAL) enqueues for every player; PLAYER scope targets one', async () => {
    const endsAt = new Date(Date.now() + 3600_000).toISOString()
    const res = await adminEventsPost(
      request('/api/v1/admin/events', adminToken, 'POST', {
        type: 'GOLD_RUSH',
        title: 'Gold Rush weekend',
        body: 'All gold production doubled while the event runs.',
        scope: 'GLOBAL',
        endsAt,
      }),
    )
    expect(res.status).toBe(200)
    const body = await parse<{ id: string }>(res)
    expect(body.ok).toBe(true)
    const eventId = body.data!.id

    const queued = await db.notificationQueue.findMany({
      where: { type: 'EVENT', dedupeKey: notificationDedupeKeys.event(eventId) },
    })
    // Every player in the world (the whole population may exceed this suite).
    expect(queued.length).toBeGreaterThanOrEqual(3)
    const queuedPlayerIds = new Set(queued.map((row) => row.playerId))
    expect(queuedPlayerIds).toContain(playerId)
    expect(queuedPlayerIds).toContain(otherPlayerId)

    await drainNotificationQueue({ workerId: 'notif-event', telegramConfig: TELEGRAM_OFF })
    const myRows = await db.notification.findMany({
      where: { playerId, type: 'EVENT' },
    })
    const mine = myRows.filter(
      (row) => (row.data as { eventId?: string } | null)?.eventId === eventId,
    )
    expect(mine.length).toBe(1)
    expect(mine[0]!.title).toBe('Gold Rush weekend')

    // PLAYER-scope event → exactly the target.
    const targetRes = await adminEventsPost(
      request('/api/v1/admin/events', adminToken, 'POST', {
        type: 'FIRE',
        title: 'Targeted drill inspection',
        body: 'A drill inspection was called at your keep.',
        scope: 'PLAYER',
        targetPlayerId: otherPlayerId,
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )
    expect(targetRes.status).toBe(200)
    const targetBody = await parse<{ id: string }>(targetRes)
    const targetQueued = await db.notificationQueue.findMany({
      where: { type: 'EVENT', dedupeKey: notificationDedupeKeys.event(targetBody.data!.id) },
    })
    expect(targetQueued.length).toBe(1)
    expect(targetQueued[0]!.playerId).toBe(otherPlayerId)
  })

  it('settlement-style RANK_CHANGE fan-out is deduped on replay', async () => {
    const seasonId = 'notif-season-spec'
    const payloadFor = (pid: string, rank: number) => ({
      kind: 'SEASON_RANK' as const,
      seasonNumber: 1,
      rank,
      tier: 'BRONZE',
      score: 100 - rank,
      rewardReady: true,
    })

    const first = await db.$transaction((tx) =>
      enqueueNotificationFanOutInTx(tx, [playerId, otherPlayerId], {
        type: 'RANK_CHANGE',
        dedupeKeyFor: (pid) => notificationDedupeKeys.seasonRank(seasonId, pid),
        payloadFor: (pid) => payloadFor(pid, pid === playerId ? 1 : 2),
      }),
    )
    expect(first).toBe(2)

    // Replay (the settlement is at-most-once, but the engine must not rely on it).
    const replay = await db.$transaction((tx) =>
      enqueueNotificationFanOutInTx(tx, [playerId, otherPlayerId], {
        type: 'RANK_CHANGE',
        dedupeKeyFor: (pid) => notificationDedupeKeys.seasonRank(seasonId, pid),
        payloadFor: (pid) => payloadFor(pid, pid === playerId ? 1 : 2),
      }),
    )
    expect(replay).toBe(0)

    await drainNotificationQueue({ workerId: 'notif-rank', telegramConfig: TELEGRAM_OFF })
    const myRows = await db.notification.findMany({
      where: { playerId, type: 'RANK_CHANGE' },
    })
    const seasonRows = myRows.filter(
      (row) => (row.data as { kind?: string } | null)?.kind === 'SEASON_RANK',
    )
    expect(seasonRows.length).toBe(1)
    expect(seasonRows[0]!.title).toContain('rank #1')
  })
})

// ── 8. Retention ─────────────────────────────────────────────────────────────

describe('retention pruning', () => {
  it('removes terminal queue rows + read inbox rows past the window; keeps unread', async () => {
    const key = notificationDedupeKeys.training('prune-spec-1')
    await db.$transaction((tx) =>
      enqueueNotificationInTx(tx, {
        playerId,
        type: 'TRAINING_COMPLETE',
        dedupeKey: key,
        payload: { unitId: 'SPEAR', unitName: 'Spearman', count: 1 },
      }),
    )
    await drainNotificationQueue({ workerId: 'notif-prune', telegramConfig: TELEGRAM_OFF })
    const queueRow = await db.notificationQueue.findUnique({
      where: { playerId_type_dedupeKey: { playerId, type: 'TRAINING_COMPLETE', dedupeKey: key } },
    })
    expect(queueRow).not.toBeNull()
    expect(queueRow!.notificationId).not.toBeNull()

    const inboxRow = await db.notification.findUnique({ where: { id: queueRow!.notificationId! } })
    expect(inboxRow).not.toBeNull()
    await markNotificationsRead(playerId, { ids: [inboxRow!.id] })

    // Backdate BOTH past the 30-day window.
    const ancient = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    await db.notificationQueue.update({
      where: { id: queueRow!.id },
      data: { processedAt: ancient },
    })
    await db.notification.update({ where: { id: inboxRow!.id }, data: { createdAt: ancient } })

    // An UNREAD old inbox row survives by design.
    const unreadOld = await db.notification.create({
      data: {
        playerId,
        type: 'EVENT',
        title: 'Old unread',
        body: 'Unread rows are never pruned.',
        createdAt: ancient,
      },
    })

    const pruned = await pruneNotificationStorage(new Date())
    expect(pruned.queueDeleted).toBeGreaterThanOrEqual(1)
    expect(pruned.inboxDeleted).toBeGreaterThanOrEqual(1)

    expect(await db.notificationQueue.findUnique({ where: { id: queueRow!.id } })).toBeNull()
    expect(await db.notification.findUnique({ where: { id: inboxRow!.id } })).toBeNull()
    expect(await db.notification.findUnique({ where: { id: unreadOld.id } })).not.toBeNull()
  })
})
