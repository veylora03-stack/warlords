/**
 * Integration tests — Admin Panel (Phase 21): RBAC + services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → RBAC scope resolution → services → transactions
 * → envelope). Mutations run through the PUBLIC service paths inside real
 * transactions — real ledger rows, real audit rows, real SQLite, zero mocks.
 *
 * Required scenarios (user contract):
 *  1. RBAC ENFORCEMENT   — anonymous 401 · regular player 403 ADMIN_REQUIRED
 *                          · moderator 403 ADMIN_FORBIDDEN on admin-only
 *                          scopes · admin allowed end-to-end
 *  2. BAN/UNBAN          — ban blocks EVERY authenticated request for the
 *                          victim (BANNED 403 via the session service),
 *                          double-ban refused, unban restores, both audited
 *  3. RESOURCE ADJUST    — ADMIN-only, ledger path (ADMIN_ADJUSTMENT),
 *                          before/after audit row in the same tx,
 *                          insufficient debit → typed 409 with zero writes
 *  4. SEARCH + DETAILS   — server-side search by name/telegram + full
 *                          inspection aggregates (audited views)
 *  5. EVENTS             — admin spawns/finishes/cancels (conditional
 *                          status claims), moderator spawn refused
 *  6. CLANS              — typed-confirmation disband clears members +
 *                          denormalized fields, wrong phrase refused
 *  7. ANNOUNCEMENTS      — moderator creates, admin broadcasts (notification
 *                          fan-out), inactive broadcast refused
 *  8. STAFF (RBAC plane) — grant moderator by telegram id → the new
 *                          moderator can act within scope; revoke → 403
 *                          again; self-deactivation refused
 *
 * Test identities live in the isolated 9100021… telegramId range and are
 * removed in afterAll (audit/announcement Restrict rows deleted explicitly,
 * everything else cascades).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as profileGet } from '../../../src/app/api/v1/player/profile/route'
import { GET as adminMeGet } from '../../../src/app/api/v1/admin/me/route'
import { GET as adminPlayersGet } from '../../../src/app/api/v1/admin/players/route'
import { GET as adminPlayerDetailsGet } from '../../../src/app/api/v1/admin/players/[id]/route'
import { POST as adminBanPost } from '../../../src/app/api/v1/admin/players/[id]/ban/route'
import { POST as adminUnbanPost } from '../../../src/app/api/v1/admin/players/[id]/unban/route'
import { POST as adminAdjustPost } from '../../../src/app/api/v1/admin/players/[id]/resources/route'
import { GET as adminBattlesGet } from '../../../src/app/api/v1/admin/battles/route'
import { GET as adminEconomyGet } from '../../../src/app/api/v1/admin/economy/route'
import { POST as adminEventsPost } from '../../../src/app/api/v1/admin/events/route'
import { POST as adminEventFinishPost } from '../../../src/app/api/v1/admin/events/[id]/finish/route'
import { GET as adminClansGet } from '../../../src/app/api/v1/admin/clans/route'
import { POST as adminDisbandPost } from '../../../src/app/api/v1/admin/clans/[id]/disband/route'
import { POST as adminAnnouncementsPost } from '../../../src/app/api/v1/admin/announcements/route'
import { POST as adminBroadcastPost } from '../../../src/app/api/v1/admin/announcements/[id]/broadcast/route'
import { POST as adminActivePost } from '../../../src/app/api/v1/admin/announcements/[id]/active/route'
import { GET as adminAuditGet } from '../../../src/app/api/v1/admin/audit-logs/route'
import {
  GET as adminStaffGet,
  POST as adminStaffPost,
} from '../../../src/app/api/v1/admin/staff/route'
import { POST as adminDeactivatePost } from '../../../src/app/api/v1/admin/staff/[id]/deactivate/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Admin integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_BASE = '9100021'
let tgCounter = 1
const nextTgId = (): string => `${TG_BASE}${String(tgCounter++).padStart(3, '0')}`
const tgIds: string[] = []

const IP_BASE = '203.0.149.' // unique per file: shared pools trip AUTH_RATE_LIMIT across parallel suites
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `AdminLord${telegramId.slice(-3)}`,
      username: `admin_lord_${telegramId.slice(-4)}`,
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
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function idCtx(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
}

async function exchange(
  route: (req: Request) => Promise<Response>,
  telegramId: string,
): Promise<{ token: string; userId: string; playerId: string }> {
  const res = await route(
    request('/api/v1/auth/telegram', null, 'POST', { initData: buildInitData(telegramId) }),
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as ApiEnvelope<{
    token: string
    user: { id: string; telegramId: string }
    player: { id: string }
  }>
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error('exchange failed')
  tgIds.push(telegramId)
  return { token: body.data.token, userId: body.data.user.id, playerId: body.data.player.id }
}

let adminToken = ''
let adminUserId = ''
let adminPlayerId = ''
let moderatorToken = ''
let moderatorPlayerId = ''
let victimToken = ''
let victimPlayerId = ''
let plainToken = ''
let plainPlayerId = ''
let plainUserId = ''

beforeAll(async () => {
  // Identities in the isolated range: admin, moderator, victim, plain player.
  const admin = await exchange(telegramPost, nextTgId())
  adminToken = admin.token
  adminUserId = admin.userId
  adminPlayerId = admin.playerId
  const moderator = await exchange(telegramPost, nextTgId())
  moderatorToken = moderator.token
  moderatorPlayerId = moderator.playerId
  const victim = await exchange(telegramPost, nextTgId())
  victimToken = victim.token
  victimPlayerId = victim.playerId
  const plain = await exchange(telegramPost, nextTgId())
  plainToken = plain.token
  plainPlayerId = plain.playerId
  plainUserId = plain.userId

  // RBAC fixtures: the DB-backed AdminUser rows ARE the authorization.
  await db.adminUser.create({ data: { userId: adminUserId, role: 'ADMIN', isActive: true } })
  await db.adminUser.create({
    data: { userId: moderator.userId, role: 'MODERATOR', isActive: true },
  })
})

afterAll(async () => {
  // Restrict-protected rows first, then the identity range (everything
  // else — players, wallets, ledger, sessions, admin rows — cascades).
  const users = await db.user.findMany({
    where: { telegramId: { in: tgIds } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  await db.auditLog.deleteMany({
    where: {
      targetId: {
        in: [adminPlayerId, moderatorPlayerId, victimPlayerId, plainPlayerId].filter(Boolean),
      },
    },
  })
  await db.announcement.deleteMany({ where: { createdById: { in: userIds } } })
  await db.notification.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.notificationQueue.deleteMany({
    where: { player: { user: { telegramId: { in: tgIds } } } },
  })
  await db.clan.deleteMany({
    where: {
      leaderPlayerId: { in: [adminPlayerId, moderatorPlayerId, victimPlayerId, plainPlayerId] },
    },
  })
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

// ── 1. RBAC enforcement ──────────────────────────────────────────────────────

describe('RBAC enforcement (server-side, never a hidden button)', () => {
  it('anonymous request → 401 UNAUTHORIZED', async () => {
    const res = await adminPlayersGet(request('/api/v1/admin/players?q=x', null))
    expect(res.status).toBe(401)
    const body = (await res.json()) as ApiEnvelope<unknown>
    expect(body.ok).toBe(false)
    if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('regular player session → 403 ADMIN_REQUIRED', async () => {
    const res = await adminPlayersGet(request('/api/v1/admin/players?q=x', plainToken))
    expect(res.status).toBe(403)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('ADMIN_REQUIRED')
  })

  it('moderator CAN search players and view economy (in scope)', async () => {
    const search = await adminPlayersGet(request('/api/v1/admin/players', moderatorToken))
    expect(search.status).toBe(200)
    const economy = await adminEconomyGet(request('/api/v1/admin/economy', moderatorToken))
    expect(economy.status).toBe(200)
  })

  it('moderator CANNOT adjust resources / spawn events / manage staff → 403 ADMIN_FORBIDDEN', async () => {
    const adjust = await adminAdjustPost(
      request(`/api/v1/admin/players/${victimPlayerId}/resources`, moderatorToken, 'POST', {
        resource: 'GOLD',
        delta: 100,
        note: 'moderator must fail',
      }),
      idCtx(victimPlayerId),
    )
    expect(adjust.status).toBe(403)
    const body = (await adjust.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('ADMIN_FORBIDDEN')

    const spawn = await adminEventsPost(
      request('/api/v1/admin/events', moderatorToken, 'POST', {
        type: 'GOLD_RUSH',
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )
    expect(spawn.status).toBe(403)

    const staff = await adminStaffGet(request('/api/v1/admin/staff', moderatorToken))
    expect(staff.status).toBe(403)
  })

  it('/admin/me reflects the DB-backed role and scopes; non-staff isStaff=false', async () => {
    const moderatorMe = await adminMeGet(request('/api/v1/admin/me', moderatorToken))
    expect(moderatorMe.status).toBe(200)
    const moderatorBody = (await moderatorMe.json()) as ApiEnvelope<{
      isStaff: boolean
      adminRole?: string
      scopes?: string[]
    }>
    expect(moderatorBody.ok).toBe(true)
    if (moderatorBody.ok) {
      expect(moderatorBody.data.isStaff).toBe(true)
      expect(moderatorBody.data.adminRole).toBe('MODERATOR')
      expect(moderatorBody.data.scopes).toContain('players.ban')
      expect(moderatorBody.data.scopes).not.toContain('players.adjust_resources')
    }

    const plainMe = await adminMeGet(request('/api/v1/admin/me', plainToken))
    const plainBody = (await plainMe.json()) as ApiEnvelope<{ isStaff: boolean }>
    expect(plainBody.ok).toBe(true)
    if (plainBody.ok) expect(plainBody.data.isStaff).toBe(false)
  })
})

// ── 2. Ban / Unban ───────────────────────────────────────────────────────────

describe('ban / unban flow (session-level enforcement + audit)', () => {
  it('ban refuses a short reason (validation)', async () => {
    const res = await adminBanPost(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken, 'POST', { reason: 'no' }),
      idCtx(victimPlayerId),
    )
    expect(res.status).toBe(400)
  })

  it('ban blocks the victim on EVERY route (BANNED 403) — double ban refused', async () => {
    const before = await profileGet(request('/api/v1/player/profile', victimToken))
    expect(before.status).toBe(200)

    const ban = await adminBanPost(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken, 'POST', {
        reason: 'exploit investigation phase 21 test',
      }),
      idCtx(victimPlayerId),
    )
    expect(ban.status).toBe(200)

    const blockedProfile = await profileGet(request('/api/v1/player/profile', victimToken))
    expect(blockedProfile.status).toBe(403)
    const blockedBody = (await blockedProfile.json()) as ApiEnvelope<unknown>
    if (!blockedBody.ok) expect(blockedBody.error.code).toBe('BANNED')

    const blockedAdmin = await adminPlayersGet(request('/api/v1/admin/players?q=x', victimToken))
    expect(blockedAdmin.status).toBe(403)

    const double = await adminBanPost(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken, 'POST', {
        reason: 'double ban must fail',
      }),
      idCtx(victimPlayerId),
    )
    expect(double.status).toBe(409)
    const doubleBody = (await double.json()) as ApiEnvelope<unknown>
    if (!doubleBody.ok) expect(doubleBody.error.code).toBe('PLAYER_ALREADY_BANNED')
  })

  it('unban restores access; unban of a non-banned player is refused; both audited', async () => {
    const unban = await adminUnbanPost(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken, 'POST', { note: 'cleared' }),
      idCtx(victimPlayerId),
    )
    expect(unban.status).toBe(200)

    const restored = await profileGet(request('/api/v1/player/profile', victimToken))
    expect(restored.status).toBe(200)

    const again = await adminUnbanPost(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken, 'POST', {}),
      idCtx(victimPlayerId),
    )
    expect(again.status).toBe(409)
    const againBody = (await again.json()) as ApiEnvelope<unknown>
    if (!againBody.ok) expect(againBody.error.code).toBe('PLAYER_NOT_BANNED')

    const [banAudit, unbanAudit] = await Promise.all([
      db.auditLog.findFirst({ where: { action: 'BAN', targetId: victimPlayerId } }),
      db.auditLog.findFirst({ where: { action: 'UNBAN', targetId: victimPlayerId } }),
    ])
    expect(banAudit).not.toBeNull()
    expect(unbanAudit).not.toBeNull()
    if (banAudit) {
      expect((banAudit.after as Record<string, unknown>)['isBanned']).toBe(true)
      expect(banAudit.reason).toContain('exploit investigation')
    }
  })
})

// ── 3. Resource adjustment ───────────────────────────────────────────────────

describe('resource adjustment (ADMIN only, ledger path, audited in-tx)', () => {
  it('credits through the ledger with an audit row (before/after)', async () => {
    const walletBefore = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: victimPlayerId },
    })
    const ledgerBefore = await db.resourceTransaction.count({
      where: { playerId: victimPlayerId },
    })

    const res = await adminAdjustPost(
      request(`/api/v1/admin/players/${victimPlayerId}/resources`, adminToken, 'POST', {
        resource: 'GOLD',
        delta: 1234,
        note: 'phase 21 support grant',
      }),
      idCtx(victimPlayerId),
    )
    expect(res.status).toBe(200)

    const walletAfter = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: victimPlayerId },
    })
    expect(walletAfter.gold).toBe(walletBefore.gold + 1234n)
    expect(await db.resourceTransaction.count({ where: { playerId: victimPlayerId } })).toBe(
      ledgerBefore + 1,
    )

    const audit = await db.auditLog.findFirst({
      where: { action: 'ADJUST_RESOURCES', targetId: victimPlayerId },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
    if (audit) {
      expect(audit.actorUserId).toBe(adminUserId)
      const after = audit.after as Record<string, string>
      expect(BigInt(after['GOLD']!)).toBe(walletBefore.gold + 1234n)
    }
  })

  it('overdraft debit → typed INSUFFICIENT_GOLD 409, zero writes', async () => {
    const walletBefore = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: victimPlayerId },
    })
    const rowsBefore = await db.resourceTransaction.count({
      where: { playerId: victimPlayerId },
    })

    const res = await adminAdjustPost(
      request(`/api/v1/admin/players/${victimPlayerId}/resources`, adminToken, 'POST', {
        resource: 'GOLD',
        delta: -10_000_000_000_000,
        note: 'overdraft must fail',
      }),
      idCtx(victimPlayerId),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('INSUFFICIENT_GOLD')

    const walletAfter = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: victimPlayerId },
    })
    expect(walletAfter.gold).toBe(walletBefore.gold)
    expect(await db.resourceTransaction.count({ where: { playerId: victimPlayerId } })).toBe(
      rowsBefore,
    )
  })
})

// ── 4. Search + details ──────────────────────────────────────────────────────

describe('player search + full inspection (audited views)', () => {
  it('search finds by name fragment and reports ban state', async () => {
    const victim = await db.player.findUniqueOrThrow({ where: { id: victimPlayerId } })
    const res = await adminPlayersGet(
      request(`/api/v1/admin/players?q=${encodeURIComponent(victim.name.slice(0, 6))}`, adminToken),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      total: number
      rows: Array<{ id: string; user: { isBanned: boolean } }>
    }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.total).toBeGreaterThanOrEqual(1)
      expect(body.data.rows.some((row) => row.id === victimPlayerId)).toBe(true)
    }
  })

  it('search by exact telegramId resolves the player', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: adminUserId } })
    const res = await adminPlayersGet(
      request(`/api/v1/admin/players?q=${user.telegramId}`, adminToken),
    )
    const body = (await res.json()) as ApiEnvelope<{ rows: Array<{ id: string }> }>
    expect(body.ok).toBe(true)
    if (body.ok) expect(body.data.rows.some((row) => row.id === adminPlayerId)).toBe(true)
  })

  it('details returns wallet/city/army aggregates + tails and writes a VIEW audit row', async () => {
    const res = await adminPlayerDetailsGet(
      request(`/api/v1/admin/players/${victimPlayerId}`, adminToken),
      idCtx(victimPlayerId),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      id: string
      wallet: Record<string, string>
      city: { townHallLevel: number | null } | null
      army: { unitCount: number }
      ledgerTail: unknown[]
      user: { isBanned: boolean }
    }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.id).toBe(victimPlayerId)
      expect(body.data.wallet['GOLD']).toBeDefined()
      expect(body.data.city?.townHallLevel).toBe(1)
      expect(body.data.army.unitCount).toBeGreaterThan(0)
      expect(body.data.user.isBanned).toBe(false)
    }
    const view = await db.auditLog.findFirst({
      where: { action: 'VIEW_PLAYER_DETAILS', targetId: victimPlayerId },
    })
    expect(view).not.toBeNull()
  })

  it('battles + economy inspections respond with real aggregates', async () => {
    const battles = await adminBattlesGet(request('/api/v1/admin/battles', adminToken))
    expect(battles.status).toBe(200)
    const economy = await adminEconomyGet(request('/api/v1/admin/economy', adminToken))
    const economyBody = (await economy.json()) as ApiEnvelope<{
      supply: Record<string, string>
      flowByReason: Array<{ reason: string }>
    }>
    expect(economyBody.ok).toBe(true)
    if (economyBody.ok) {
      expect(Number(economyBody.data.supply['GOLD'])).toBeGreaterThan(0)
      expect(economyBody.data.flowByReason.some((flow) => flow.reason === 'ADMIN_ADJUSTMENT')).toBe(
        true,
      )
    }
  })
})

// ── 5. Events ────────────────────────────────────────────────────────────────

describe('event management (conditional transitions, audited)', () => {
  let eventId = ''

  it('admin spawns an event; moderator is forbidden (covered above)', async () => {
    const res = await adminEventsPost(
      request('/api/v1/admin/events', adminToken, 'POST', {
        type: 'GOLD_RUSH',
        title: 'Phase 21 admin event',
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ id: string; status: string }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      eventId = body.data.id
      expect(['ACTIVE', 'SCHEDULED']).toContain(body.data.status)
    }
  })

  it('ending in the past is a 400 (window validation)', async () => {
    const res = await adminEventsPost(
      request('/api/v1/admin/events', adminToken, 'POST', {
        type: 'PLAGUE',
        endsAt: new Date(Date.now() - 3600_000).toISOString(),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('finish → FINISHED; second finish refused (EVENT_NOT_ACTIVE); audited', async () => {
    const finish = await adminEventFinishPost(
      request(`/api/v1/admin/events/${eventId}`, adminToken, 'POST', {}),
      idCtx(eventId),
    )
    expect(finish.status).toBe(200)

    const again = await adminEventFinishPost(
      request(`/api/v1/admin/events/${eventId}`, adminToken, 'POST', {}),
      idCtx(eventId),
    )
    expect(again.status).toBe(409)
    const againBody = (await again.json()) as ApiEnvelope<unknown>
    if (!againBody.ok) expect(againBody.error.code).toBe('EVENT_NOT_ACTIVE')

    const audit = await db.auditLog.findFirst({
      where: { action: 'EVENT_FINISH', targetId: eventId },
    })
    expect(audit).not.toBeNull()
  })

  it('unknown event → 404', async () => {
    const res = await adminEventFinishPost(
      request('/api/v1/admin/events/nonexistent123', adminToken, 'POST', {}),
      idCtx('nonexistent123'),
    )
    expect(res.status).toBe(404)
  })
})

// ── 6. Clans ─────────────────────────────────────────────────────────────────

describe('clan management (typed confirmation disband)', () => {
  let clanId = ''

  beforeAll(async () => {
    // Fixture: a real clan with the victim as leader + one member row.
    const clan = await db.clan.create({
      data: {
        name: `Phase21Clan${Date.now() % 100000}`,
        tag: 'P21T',
        leaderPlayerId: victimPlayerId,
        memberCount: 1,
      },
    })
    clanId = clan.id
    await db.clanMember.create({
      data: { clanId: clan.id, playerId: victimPlayerId, role: 'LEADER' },
    })
    await db.player.update({
      where: { id: victimPlayerId },
      data: { clanId: clan.id, clanRole: 'LEADER' },
    })
  })

  it('wrong confirmation phrase → CONFIRMATION_REQUIRED 400, clan intact', async () => {
    const res = await adminDisbandPost(
      request(`/api/v1/admin/clans/${clanId}/disband`, adminToken, 'POST', {
        confirm: 'disband it',
        reason: 'phase 21 disband test',
      }),
      idCtx(clanId),
    )
    expect(res.status).toBe(400)
    expect(await db.clan.findUnique({ where: { id: clanId } })).not.toBeNull()
  })

  it('correct phrase disbands: members removed, denormalized fields cleared, audited', async () => {
    const res = await adminDisbandPost(
      request(`/api/v1/admin/clans/${clanId}/disband`, adminToken, 'POST', {
        confirm: 'DISBAND',
        reason: 'phase 21 disband test',
      }),
      idCtx(clanId),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ membersRemoved: number }>
    if (body.ok) expect(body.data.membersRemoved).toBe(1)

    expect(await db.clan.findUnique({ where: { id: clanId } })).toBeNull()
    expect(await db.clanMember.findFirst({ where: { clanId } })).toBeNull()
    const victim = await db.player.findUniqueOrThrow({ where: { id: victimPlayerId } })
    expect(victim.clanId).toBeNull()
    expect(victim.clanRole).toBeNull()

    const audit = await db.auditLog.findFirst({
      where: { action: 'CLAN_DISBAND', targetId: clanId },
    })
    expect(audit).not.toBeNull()
  })

  it('clan list endpoint works for moderators and admins', async () => {
    const res = await adminClansGet(request('/api/v1/admin/clans', moderatorToken))
    expect(res.status).toBe(200)
  })
})

// ── 7. Announcements ─────────────────────────────────────────────────────────

describe('announcements (create → broadcast fan-out, audited)', () => {
  let announcementId = ''

  it('moderator creates an announcement (in scope)', async () => {
    const res = await adminAnnouncementsPost(
      request('/api/v1/admin/announcements', moderatorToken, 'POST', {
        title: 'Maintenance window tonight',
        body: 'Phase 21 integration broadcast — servers will blip.',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ id: string; isActive: boolean }>
    if (body.ok) {
      announcementId = body.data.id
      expect(body.data.isActive).toBe(true)
    }
  })

  it('broadcast fans notifications out to every player; audit records the count', async () => {
    const playersBefore = await db.player.count()
    const res = await adminBroadcastPost(
      request(`/api/v1/admin/announcements/${announcementId}/broadcast`, adminToken, 'POST'),
      idCtx(announcementId),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ notifiedPlayers: number }>
    if (body.ok) expect(body.data.notifiedPlayers).toBe(playersBefore)

    // The fan-out lands in the notification QUEUE (Phase 22 engine) —
    // deduped by (player, ANNOUNCEMENT, announcementId).
    const queued = await db.notificationQueue.findMany({
      where: { type: 'ANNOUNCEMENT', playerId: victimPlayerId },
    })
    expect(queued.length).toBe(1)

    // The worker renders + delivers the inbox rows. The queue may hold rows
    // from other suites in the shared sandbox DB — drain until it is EMPTY
    // (bounded), not just one 25-row batch.
    for (let tick = 0; tick < 50; tick++) {
      const result = await drainNotificationQueue({
        workerId: 'admin-test',
        telegramConfig: { token: null },
      })
      if (result.claimed === 0) break
    }
    const notifications = await db.notification.findMany({
      where: { type: 'ANNOUNCEMENT', playerId: victimPlayerId },
    })
    expect(notifications.length).toBe(1)

    const audit = await db.auditLog.findFirst({
      where: { action: 'ANNOUNCE_BROADCAST', targetId: announcementId },
    })
    expect(audit).not.toBeNull()
  })

  it('deactivate → broadcast refused (ANNOUNCEMENT_INACTIVE); toggle audited', async () => {
    const deactivate = await adminActivePost(
      request(`/api/v1/admin/announcements/${announcementId}/active`, adminToken, 'POST', {
        isActive: false,
      }),
      idCtx(announcementId),
    )
    expect(deactivate.status).toBe(200)

    const broadcast = await adminBroadcastPost(
      request(`/api/v1/admin/announcements/${announcementId}/broadcast`, adminToken, 'POST'),
      idCtx(announcementId),
    )
    expect(broadcast.status).toBe(409)
    const broadcastBody = (await broadcast.json()) as ApiEnvelope<unknown>
    if (!broadcastBody.ok) expect(broadcastBody.error.code).toBe('ANNOUNCEMENT_INACTIVE')

    const audit = await db.auditLog.findFirst({
      where: { action: 'ANNOUNCE_DEACTIVATE', targetId: announcementId },
    })
    expect(audit).not.toBeNull()
  })
})

// ── 8. Staff (the RBAC control plane) ────────────────────────────────────────

describe('staff management (grant → act → revoke lifecycle)', () => {
  let plainAdminRowId = ''
  let plainTelegramId = ''

  beforeAll(async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: plainUserId } })
    plainTelegramId = user.telegramId
  })

  it('admin grants MODERATOR to a regular player by telegram id', async () => {
    const res = await adminStaffPost(
      request('/api/v1/admin/staff', adminToken, 'POST', {
        telegramId: plainTelegramId,
        role: 'MODERATOR',
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{ adminUserId: string; role: string }>
    if (body.ok) {
      plainAdminRowId = body.data.adminUserId
      expect(body.data.role).toBe('MODERATOR')
    }
  })

  it('the promoted moderator acts within scope immediately (DB-backed)', async () => {
    const economy = await adminEconomyGet(request('/api/v1/admin/economy', plainToken))
    expect(economy.status).toBe(200)
    const denied = await adminAdjustPost(
      request(`/api/v1/admin/players/${victimPlayerId}/resources`, plainToken, 'POST', {
        resource: 'GOLD',
        delta: 5,
        note: 'must be forbidden',
      }),
      idCtx(victimPlayerId),
    )
    expect(denied.status).toBe(403)
  })

  it('re-granting the same active role is refused', async () => {
    const same = await adminStaffPost(
      request('/api/v1/admin/staff', adminToken, 'POST', {
        telegramId: plainTelegramId,
        role: 'MODERATOR',
      }),
    )
    expect(same.status).toBe(400)
  })

  it('self-deactivation is refused (SELF_TARGET)', async () => {
    const own = await db.adminUser.findUniqueOrThrow({ where: { userId: adminUserId } })
    const res = await adminDeactivatePost(
      request(`/api/v1/admin/staff/${own.id}/deactivate`, adminToken, 'POST'),
      idCtx(own.id),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as ApiEnvelope<unknown>
    if (!body.ok) expect(body.error.code).toBe('SELF_TARGET')
  })

  it('deactivation revokes access on the staff member’s NEXT request', async () => {
    const res = await adminDeactivatePost(
      request(`/api/v1/admin/staff/${plainAdminRowId}/deactivate`, adminToken, 'POST'),
      idCtx(plainAdminRowId),
    )
    expect(res.status).toBe(200)

    const revoked = await adminEconomyGet(request('/api/v1/admin/economy', plainToken))
    expect(revoked.status).toBe(403)
    const revokedBody = (await revoked.json()) as ApiEnvelope<unknown>
    if (!revokedBody.ok) expect(revokedBody.error.code).toBe('ADMIN_REQUIRED')
  })
})

// ── 9. Audit viewer ──────────────────────────────────────────────────────────

describe('audit log viewer', () => {
  it('returns the phase 21 actions with actor identity', async () => {
    const res = await adminAuditGet(request('/api/v1/admin/audit-logs?pageSize=50', adminToken))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiEnvelope<{
      rows: Array<{ action: string; actor: { telegramId: string } }>
    }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      const actions = body.data.rows.map((row) => row.action)
      for (const expected of [
        'BAN',
        'UNBAN',
        'ADJUST_RESOURCES',
        'EVENT_FINISH',
        'CLAN_DISBAND',
        'ANNOUNCE_BROADCAST',
      ]) {
        expect(actions).toContain(expected)
      }
    }
  })

  it('action filter narrows the result set', async () => {
    const res = await adminAuditGet(request('/api/v1/admin/audit-logs?action=BAN', adminToken))
    const body = (await res.json()) as ApiEnvelope<{
      rows: Array<{ action: string }>
      total: number
    }>
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.total).toBeGreaterThan(0)
      for (const row of body.data.rows) expect(row.action).toBe('BAN')
    }
  })
})
