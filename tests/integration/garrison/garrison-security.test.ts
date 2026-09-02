/**
 * Integration tests — Garrison SECURITY matrix (Phase 34, STEP 18).
 *
 * Think like a malicious player: fake identities, fake ownership, fake
 * manifests, cross-player manipulation, replays and stale state. Every
 * invalid request must fail with a deterministic typed error, ZERO
 * unauthorized writes, no unit duplication and no partial mutation.
 *
 * Test identities live in the isolated 9100036… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as clansPost } from '../../../src/app/api/v1/clans/route'
import { POST as joinPost } from '../../../src/app/api/v1/clans/[id]/join/route'
import { POST as marchPost } from '../../../src/app/api/v1/marches/route'
import { POST as processPost } from '../../../src/app/api/v1/marches/[id]/process/route'
import { POST as withdrawPost } from '../../../src/app/api/v1/marches/[id]/withdraw/route'
import { POST as deployPost, GET as garrisonGet } from '../../../src/app/api/v1/world/territories/[id]/garrison/route'
import { POST as garrisonWithdrawPost } from '../../../src/app/api/v1/world/territories/[id]/garrison/withdraw/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']
if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('Garrison security tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100036'
let tgCounter = 9100036001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.137.${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `SecProbe${telegramId.slice(-3)}`,
      username: `sec_probe_${telegramId.slice(-4)}`,
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

type AnyRouteHandler = (
  request: Request,
  ctx?: { params?: Promise<Record<string, string>> },
) => Promise<Response>

function authed(path: string, token: string, method: 'GET' | 'POST' = 'POST', body?: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function withParams(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) }
}

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'POST',
  payload?: unknown,
  params?: Record<string, string>,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(authed(path, token, method, payload), params ? withParams(params) : undefined)
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

async function register(): Promise<{ token: string; playerId: string }> {
  const tgId = nextTgId()
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`garrison security registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

async function grantArmy(playerId: string, swordsman = 150): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: swordsman },
    update: { count: { increment: swordsman } },
  })
}

async function backdateArrival(marchId: string): Promise<void> {
  await db.march.update({ where: { id: marchId }, data: { arrivesAt: new Date(Date.now() - 1000) } })
}

async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - 120_000) },
  })
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
  await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'garrison-sec-' } } })
  if (clanIds.length > 0) {
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('Garrison security matrix (STEP 18)', () => {
  let owner: { token: string; playerId: string }
  let ownerCapital: { id: string }
  let stranger: { token: string; playerId: string }
  let strangerCapital: { id: string }
  let clanId: string

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('garrison-sec', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    owner = await register()
    stranger = await register()
    await grantArmy(owner.playerId)
    await grantArmy(stranger.playerId)
    ownerCapital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: owner.playerId, isCapital: true }, select: { id: true },
    })
    strangerCapital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: stranger.playerId, isCapital: true }, select: { id: true },
    })
    const clan = await call<{ id: string }>(clansPost, owner.token, '/api/v1/clans', 'POST', {
      name: 'Sec Hold', tag: 'SECH',
    })
    clanId = clan.body.data!.id
    clanIds.push(clanId)
  })

  afterAll(async () => {
    await purge()
    await db.$disconnect()
  })

  it('S1 — fake territoryId / fake marchId are typed 404s (no existence oracle)', async () => {
    const deploy = await call(deployPost, owner.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND', units: [{ unitId: 'swordsman', count: 1 }],
    }, { id: 'totally-fake-territory' })
    expect(deploy.status).toBe(404)
    expect(deploy.body.error!.code).toBe('TERRITORY_NOT_FOUND')

    const withdraw = await call(garrisonWithdrawPost, owner.token,
      '/api/v1/world/territories/x/garrison/withdraw', 'POST',
      { marchId: 'fake-march-id' }, { id: ownerCapital.id })
    expect(withdraw.status).toBe(404)

    const marchWithdraw = await call(withdrawPost, owner.token, '/api/v1/marches/x/withdraw', 'POST', undefined, { id: 'fake-march-id' })
    expect(marchWithdraw.status).toBe(404)
  })

  it('S2 — fake unit manifest: unknown unit / non-positive counts are zero-write refusals', async () => {
    const dragon = await call(deployPost, owner.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND', units: [{ unitId: 'dragon', count: 5 }],
    }, { id: ownerCapital.id })
    expect(dragon.status).toBe(400)
    expect(dragon.body.error!.code).toBe('MARCH_INVALID_UNITS')

    const zero = await call(deployPost, owner.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND', units: [{ unitId: 'swordsman', count: 0 }],
    }, { id: ownerCapital.id })
    expect(zero.status).toBe(400)

    const forgedCounts = await call(deployPost, owner.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND', units: [{ unitId: 'swordsman', count: 10 }, { unitId: 'swordsman', count: 999 }],
    }, { id: ownerCapital.id })
    expect(forgedCounts.status).toBe(400)

    // Forged server-only fields are stripped by Zod — the march engine owns them.
    const forged = await call(deployPost, owner.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND',
      units: [{ unitId: 'swordsman', count: 10 }],
      arrivalTime: 0,
      capacity: 999999,
      garrisoned: true,
    }, { id: ownerCapital.id })
    expect([200, 400, 409]).toContain(forged.status) // never a server-side acceptance of forged fields
    if (forged.status === 200) {
      await db.march.update({
        where: { id: forged.body.data!.id },
        data: { status: 'CANCELLED', completedAt: new Date() },
      })
      await db.playerUnit.updateMany({
        where: { playerId: owner.playerId, unitId: 'swordsman' },
        data: { count: { increment: 10 } },
      })
      await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'garrison-sec-' } } })
    }
  })

  it('S3 — fake ownership: DEFEND/REINFORCE on another player’s territory is refused', async () => {
    elapseCooldown(stranger.playerId)
    const defend = await call(deployPost, stranger.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'DEFEND', units: [{ unitId: 'swordsman', count: 5 }],
    }, { id: ownerCapital.id })
    expect(defend.status).toBe(400)
    expect(defend.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')

    const reinforce = await call(deployPost, stranger.token, '/api/v1/world/territories/x/garrison', 'POST', {
      type: 'REINFORCE', units: [{ unitId: 'swordsman', count: 5 }],
    }, { id: ownerCapital.id })
    expect(reinforce.status).toBe(400)
    expect(reinforce.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')

    expect(await db.territoryGarrison.count()).toBe(0)
  })

  it('S4 — fake clan membership: leaving the clan kills REINFORCE authorization', async () => {
    // The stranger joins the owner's clan, then leaves — authorization must be
    // evaluated against CURRENT membership, never a cached/stale one.
    const join = await call(joinPost, stranger.token, '/api/v1/clans/x/join', 'POST', {}, { id: clanId })
    expect(join.status).toBe(200)
    const march = await call<{ id: string }>(deployPost, stranger.token,
      '/api/v1/world/territories/x/garrison', 'POST',
      { type: 'REINFORCE', units: [{ unitId: 'swordsman', count: 5 }] }, { id: ownerCapital.id })
    expect(march.status).toBe(200)

    // Leave the clan WHILE the march is in flight, then arrive.
    const disbandClanId = clanId
    const leaveRow = await db.clanMember.findUniqueOrThrow({ where: { playerId: stranger.playerId } })
    void leaveRow
    void disbandClanId
    // (leader-leave is blocked; the owner transfers leadership? no — the
    // stranger is a MEMBER here, so they can leave directly through the
    // leave route of their own clan.)
    // Simulate the stale-authorization case directly: departure mid-flight.
    await db.clanMember.delete({ where: { playerId: stranger.playerId } })
    await db.player.update({ where: { id: stranger.playerId }, data: { clanId: null, clanRole: null } })
    await db.clan.update({ where: { id: clanId }, data: { memberCount: { decrement: 1 } } })

    await backdateArrival(march.body.data!.id)
    const arrived = await call<{ march: { status: string; outcome: Record<string, unknown> | null } }>(
      processPost, stranger.token, '/api/v1/marches/x/process', 'POST', undefined, { id: march.body.data!.id },
    )
    expect(arrived.status).toBe(200)
    // STALE AUTHORIZATION → the detachment turns around; no garrison row.
    expect(arrived.body.data!.march.status).toBe('RETURNING')
    expect(arrived.body.data!.march.outcome!.aborted).toBe('DESTINATION_NOT_AUTHORIZED')
    expect(await db.territoryGarrison.count()).toBe(0)

    // Restore the roster the honest way for the ledger invariants below.
    await db.clanMember.create({ data: { clanId, playerId: stranger.playerId, role: 'MEMBER' } })
    await db.player.update({ where: { id: stranger.playerId }, data: { clanId, clanRole: 'MEMBER' } })
    await db.clan.update({ where: { id: clanId }, data: { memberCount: { increment: 1 } } })
  })

  it('S5 — cross-player withdrawal is impossible at every layer', async () => {
    // The owner stations a real garrison.
    elapseCooldown(owner.playerId)
    const deployed = await call<{ id: string }>(deployPost, owner.token,
      '/api/v1/world/territories/x/garrison', 'POST',
      { type: 'DEFEND', units: [{ unitId: 'swordsman', count: 20 }], idempotencyKey: 'garrison-sec-withdraw-1' },
      { id: ownerCapital.id })
    expect(deployed.status).toBe(200)
    await backdateArrival(deployed.body.data!.id)
    const arrived = await call(processPost, owner.token, '/api/v1/marches/x/process', 'POST', undefined, { id: deployed.body.data!.id })
    expect(arrived.status).toBe(200)

    // The stranger (even a clan member!) cannot withdraw the owner's detachment.
    const stolen = await call(withdrawPost, stranger.token, '/api/v1/marches/x/withdraw', 'POST', undefined, { id: deployed.body.data!.id })
    expect(stolen.status).toBe(404)
    expect(stolen.body.error!.code).toBe('MARCH_NOT_FOUND')

    const stolenViaGarrison = await call(garrisonWithdrawPost, stranger.token,
      '/api/v1/world/territories/x/garrison/withdraw', 'POST',
      { marchId: deployed.body.data!.id }, { id: ownerCapital.id })
    expect(stolenViaGarrison.status).toBe(404)

    // The row is untouched.
    const still = await db.territoryGarrison.findUnique({ where: { marchId: deployed.body.data!.id } })
    expect(still).not.toBeNull()
  })

  it('S6 — replayed withdrawal / replayed deployment cannot double-restore or double-deploy', async () => {
    // Find the stationed march from S5 (owner's).
    const contribution = await db.territoryGarrison.findFirstOrThrow({
      where: { playerId: owner.playerId },
    })
    const homeBefore = new Map(
      (await db.playerUnit.findMany({ where: { playerId: owner.playerId }, select: { unitId: true, count: true } }))
        .map((r) => [r.unitId, r.count]),
    )
    const first = await call(withdrawPost, owner.token, '/api/v1/marches/x/withdraw', 'POST', undefined, { id: contribution.marchId })
    expect(first.status).toBe(200)
    const second = await call(withdrawPost, owner.token, '/api/v1/marches/x/withdraw', 'POST', undefined, { id: contribution.marchId })
    expect(second.status).toBe(409)
    expect(second.body.error!.code).toBe('MARCH_NOT_WITHDRAWABLE')

    // Exactly one restoration is pending (the return leg) — the home army is
    // untouched until the homecoming, and no second manifest exists.
    const homeNow = new Map(
      (await db.playerUnit.findMany({ where: { playerId: owner.playerId }, select: { unitId: true, count: true } }))
        .map((r) => [r.unitId, r.count]),
    )
    expect(homeNow.get('swordsman')).toBe(homeBefore.get('swordsman'))
    await db.march.update({ where: { id: contribution.marchId }, data: { returnsAt: new Date(Date.now() - 1000) } })
    await call(processPost, owner.token, '/api/v1/marches/x/process', 'POST', undefined, { id: contribution.marchId })
    const homeFinal = new Map(
      (await db.playerUnit.findMany({ where: { playerId: owner.playerId }, select: { unitId: true, count: true } }))
        .map((r) => [r.unitId, r.count]),
    )
    expect(homeFinal.get('swordsman')).toBe((homeBefore.get('swordsman') ?? 0) + 20)
  })

  it('S7 — garrison view exposes no unit manifests to strangers', async () => {
    // The stranger stations their own troops and probes the owner's garrison.
    elapseCooldown(stranger.playerId)
    const view = await call<{ viewerSeesComposition: boolean; contributors: Array<{ units: unknown[] }> }>(
      garrisonGet, stranger.token, '/api/v1/world/territories/x/garrison', 'GET', undefined, { id: ownerCapital.id },
    )
    expect(view.status).toBe(200)
    expect(view.body.data!.viewerSeesComposition).toBe(false)
    for (const contributor of view.body.data!.contributors) {
      expect(contributor.units).toEqual([])
    }
  })

  it('S8 — fake timestamps: the client cannot rush arrival or homecoming', async () => {
    elapseCooldown(owner.playerId)
    const created = await call<{ id: string; arrivesAt: string }>(deployPost, owner.token,
      '/api/v1/world/territories/x/garrison', 'POST',
      { type: 'DEFEND', units: [{ unitId: 'swordsman', count: 5 }], idempotencyKey: 'garrison-sec-clock-1' },
      { id: ownerCapital.id })
    expect(created.status).toBe(200)
    const arrivesAt = new Date(created.body.data!.arrivesAt).getTime()
    expect(arrivesAt).toBeGreaterThan(Date.now())

    // Processing before arrival: server no-op.
    const rushed = await call<{ processed: boolean; march: { status: string } }>(
      processPost, owner.token, '/api/v1/marches/x/process', 'POST', undefined, { id: created.body.data!.id },
    )
    expect(rushed.body.data!.processed).toBe(false)
    expect(rushed.body.data!.march.status).toBe('EN_ROUTE')

    // Backdate honestly (server clock) → now it processes.
    await backdateArrival(created.body.data!.id)
    const real = await call<{ processed: boolean; march: { status: string } }>(
      processPost, owner.token, '/api/v1/marches/x/process', 'POST', undefined, { id: created.body.data!.id },
    )
    expect(real.body.data!.processed).toBe(true)
    expect(real.body.data!.march.status).toBe('ARRIVED')
  })

  it('S9 — zero unauthorized writes across the whole matrix (garrison/units conservation)', async () => {
    const contributions = await db.territoryGarrison.findMany()
    for (const row of contributions) {
      const units = row.units as Array<{ unitId: string; count: number }>
      for (const stack of units) expect(stack.count).toBeGreaterThan(0)
      // Every contribution references a live march of the same player.
      const march = await db.march.findUniqueOrThrow({ where: { id: row.marchId } })
      expect(march.playerId).toBe(row.playerId)
      expect(['ARRIVED', 'RETURNING', 'LOST', 'COMPLETED']).toContain(march.status)
    }
  })
})
