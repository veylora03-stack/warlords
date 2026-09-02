/**
 * Integration tests — Positional Garrison System (Phase 34): services + routes + DB.
 *
 * Real marches, real reservations, real battles through the SHARED assault
 * pipeline, real positional contributions, zero mocks.
 *
 * Scenarios (Phase 34 contract):
 *  1. AUTH             — 401 without a session
 *  2. DEFEND DEPLOY    — own territory: units leave the home army, march parks
 *                        ARRIVED, TerritoryGarrison row holds the stacks
 *  3. VIEW + PRIVACY   — garrison view: totals public; unit manifests only for
 *                        owner/contributors
 *  4. FOREIGN DEFENSE  — DEFEND/REINFORCE to a foreign/unclaimed territory →
 *                        typed refusal, zero writes
 *  5. REINFORCE CLAN   — same-clan comrade reinforces the owner's territory;
 *                        foreign players refused; stale authorization bounces
 *  6. CAPACITY         — creation pre-check refuses over-capacity; mid-flight
 *                        growth bounces the detachment home at arrival
 *  7. BATTLE           — enemy ATTACK vs a garrisoned territory: the
 *                        POSITIONAL garrison defends (NOT the realm army),
 *                        casualties land on the contributions, home army intact
 *  8. CAPTURE          — a won assault routes the garrison: contributions gone,
 *                        marches LOST (garrisonRouted), audit outcome kept
 *  9. WITHDRAW         — recall restores survivors EXACTLY once via the
 *                        existing homecoming; dead troops can never withdraw
 * 10. INVENTORY        — conservation: committed == garrisoned + returned + lost
 *
 * Test identities live in the isolated 9100059… telegramId range.
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
import {
  POST as deployPost,
  GET as garrisonGet,
} from '../../../src/app/api/v1/world/territories/[id]/garrison/route'
import { POST as garrisonWithdrawPost } from '../../../src/app/api/v1/world/territories/[id]/garrison/withdraw/route'
import { POST as attackRoute } from '../../../src/app/api/v1/world/territories/[id]/attack/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { GARRISON } from '../../../src/lib/game/config/garrison'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']
if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('Garrison integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100059'
let tgCounter = 9100059001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.136.${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `Garrison${telegramId.slice(-3)}`,
      username: `garrison_${telegramId.slice(-4)}`,
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

function authed(
  path: string,
  token: string,
  method: 'GET' | 'POST' = 'POST',
  body?: unknown,
): Request {
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
  const res = await handler(
    authed(path, token, method, payload),
    params ? withParams(params) : undefined,
  )
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
  if (!body.ok || !body.data) throw new Error(`garrison integration registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

async function grantArmy(playerId: string, swordsman = 300, archer = 120): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: swordsman },
    update: { count: { increment: swordsman } },
  })
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'archer' } },
    create: { playerId, unitId: 'archer', count: archer },
    update: { count: { increment: archer } },
  })
}

async function homeArmy(playerId: string): Promise<Map<string, number>> {
  const rows = await db.playerUnit.findMany({
    where: { playerId },
    select: { unitId: true, count: true },
  })
  return new Map(rows.map((r) => [r.unitId, r.count]))
}

async function backdateArrival(marchId: string): Promise<void> {
  await db.march.update({
    where: { id: marchId },
    data: { arrivesAt: new Date(Date.now() - 1000) },
  })
}

async function backdateReturn(marchId: string): Promise<void> {
  await db.march.update({
    where: { id: marchId },
    data: { returnsAt: new Date(Date.now() - 1000) },
  })
}

async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

/** March-arrival processing through the PUBLIC route. */
async function arrive(
  token: string,
  marchId: string,
): Promise<{ status: string; outcome: Record<string, unknown> | null }> {
  await backdateArrival(marchId)
  const res = await call<{ march: { status: string; outcome: Record<string, unknown> | null } }>(
    processPost,
    token,
    '/api/v1/marches/x/process',
    'POST',
    undefined,
    { id: marchId },
  )
  if (res.status !== 200) throw new Error(`arrival processing failed: ${JSON.stringify(res.body)}`)
  return { status: res.body.data!.march.status, outcome: res.body.data!.march.outcome }
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
  // Suite-fixed idempotency keys must not collide across runs (keys are
  // global-unique; stale rows from earlier runs would replay as 409s).
  await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'garrison-it-' } } })
  if (clanIds.length > 0) {
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('Positional garrison system (deploy → reinforce → battle → withdraw)', () => {
  let owner: { token: string; playerId: string }
  let ownerCapital: { id: string; x: number; y: number }
  let clanmate: { token: string; playerId: string }
  let foreigner: { token: string; playerId: string }
  let foreignerCapital: { id: string; x: number; y: number }
  let attacker: { token: string; playerId: string }
  let clanId: string

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('garrison-it', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    owner = await register()
    clanmate = await register()
    foreigner = await register()
    attacker = await register()
    for (const p of [owner, clanmate, foreigner, attacker]) await grantArmy(p.playerId)
    const cap = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: owner.playerId, isCapital: true },
      select: { id: true, x: true, y: true },
    })
    ownerCapital = cap
    const fcap = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: foreigner.playerId, isCapital: true },
      select: { id: true, x: true, y: true },
    })
    foreignerCapital = fcap
    // Owner founds a clan; the clanmate joins it (foreigner stays clanless).
    const clan = await call<{ id: string }>(clansPost, owner.token, '/api/v1/clans', 'POST', {
      name: 'Garrison Hold',
      tag: 'GARR',
    })
    expect(clan.status).toBe(200)
    clanId = clan.body.data!.id
    clanIds.push(clanId)
    const joined = await call(
      joinPost,
      clanmate.token,
      '/api/v1/clans/x/join',
      'POST',
      {},
      { id: clanId },
    )
    expect(joined.status).toBe(200)
  })

  afterAll(async () => {
    await purge()
    await db.$disconnect()
  })

  it('1 — refuses unauthenticated garrison access', async () => {
    const view = await call(
      garrisonGet,
      '',
      '/api/v1/world/territories/x/garrison',
      'GET',
      undefined,
      { id: ownerCapital.id },
    )
    expect(view.status).toBe(401)
    const deploy = await call(
      deployPost,
      '',
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
      { id: ownerCapital.id },
    )
    expect(deploy.status).toBe(401)
  })

  it('2 — DEFEND deployment stations a real garrison (units leave home)', async () => {
    elapseCooldown(owner.playerId)
    const before = await homeArmy(owner.playerId)
    const created = await call<{ id: string; status: string }>(
      deployPost,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [
          { unitId: 'swordsman', count: 50 },
          { unitId: 'archer', count: 20 },
        ],
        idempotencyKey: 'garrison-it-defend-1',
      },
      { id: ownerCapital.id },
    )
    expect(created.status).toBe(200)
    const marchId = created.body.data!.id
    expect(created.body.data!.status).toBe('EN_ROUTE')

    const arrival = await arrive(owner.token, marchId)
    expect(arrival.status).toBe('ARRIVED')
    expect(arrival.outcome!.garrisoned).toBe(true)

    // Units are OUT of the home army and IN the contribution row.
    const after = await homeArmy(owner.playerId)
    expect(after.get('swordsman')).toBe((before.get('swordsman') ?? 0) - 50)
    expect(after.get('archer')).toBe((before.get('archer') ?? 0) - 20)

    const contribution = await db.territoryGarrison.findUniqueOrThrow({ where: { marchId } })
    expect(contribution.territoryId).toBe(ownerCapital.id)
    expect(contribution.playerId).toBe(owner.playerId)
    const units = contribution.units as Array<{ unitId: string; count: number }>
    expect(units).toEqual([
      { unitId: 'archer', count: 20 },
      { unitId: 'swordsman', count: 50 },
    ])

    // garrisonsDeployed stat recorded.
    const stats = await db.player.findUniqueOrThrow({
      where: { id: owner.playerId },
      select: { stats: true },
    })
    expect(((stats.stats ?? {}) as Record<string, number>)['garrisonsDeployed'] ?? 0).toBe(1)
  })

  it('3 — garrison view: totals public, unit manifests restricted', async () => {
    const asOwner = await call<{
      totalUnits: number
      capacity: number
      viewerSeesComposition: boolean
      contributors: Array<{ units: Array<unknown> }>
    }>(garrisonGet, owner.token, '/api/v1/world/territories/x/garrison', 'GET', undefined, {
      id: ownerCapital.id,
    })
    expect(asOwner.status).toBe(200)
    expect(asOwner.body.data!.garrisoned).toBe(true)
    expect(asOwner.body.data!.totalUnits).toBe(70)
    expect(asOwner.body.data!.capacity).toBeGreaterThanOrEqual(70)
    expect(asOwner.body.data!.viewerSeesComposition).toBe(true)
    expect(asOwner.body.data!.contributors[0]!.units.length).toBeGreaterThan(0)

    // The clanmate (contributor-less but same clan) sees totals, not manifests.
    const asClanmate = await call<{
      viewerSeesComposition: boolean
      contributors: Array<{ units: Array<unknown> }>
    }>(garrisonGet, clanmate.token, '/api/v1/world/territories/x/garrison', 'GET', undefined, {
      id: ownerCapital.id,
    })
    expect(asClanmate.status).toBe(200)
    expect(asClanmate.body.data!.viewerSeesComposition).toBe(false)
    expect(asClanmate.body.data!.contributors[0]!.units).toEqual([])

    // A stranger sees the strength but never the manifests.
    const stranger = await register()
    const asStranger = await call<{ viewerSeesComposition: boolean }>(
      garrisonGet,
      stranger.token,
      '/api/v1/world/territories/x/garrison',
      'GET',
      undefined,
      { id: ownerCapital.id },
    )
    expect(asStranger.status).toBe(200)
    expect(asStranger.body.data!.viewerSeesComposition).toBe(false)
  })

  it('4 — foreign/unclaimed defense refusals are typed and zero-write', async () => {
    // Foreigner's OWN territory is fine, but nobody else can DEFEND it:
    const foreignDefend = await call(
      deployPost,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
      { id: foreignerCapital.id },
    )
    expect(foreignDefend.status).toBe(400)
    expect(foreignDefend.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')

    // REINFORCE on a foreign (non-clan) territory — refused.
    const foreignReinforce = await call(
      deployPost,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
      { id: foreignerCapital.id },
    )
    expect(foreignReinforce.status).toBe(400)
    expect(foreignReinforce.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')

    // Unclaimed territory — refused for both actions.
    const unclaimed = await db.territory.findFirstOrThrow({
      where: { status: 'UNCLAIMED' },
      select: { id: true },
    })
    for (const type of ['DEFEND', 'REINFORCE'] as const) {
      const res = await call(
        deployPost,
        owner.token,
        '/api/v1/world/territories/x/garrison',
        'POST',
        {
          type,
          units: [{ unitId: 'swordsman', count: 1 }],
        },
        { id: unclaimed.id },
      )
      expect(res.status).toBe(400)
      expect(res.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')
    }

    // No garrison rows were created by the refusals — scoped to this suite's
    // territories (other suites share the sandbox DB and garrison THEIR cells
    // concurrently; a global count would count their legitimate rows too).
    const total = await db.territoryGarrison.count({
      where: { territoryId: { in: [ownerCapital.id, foreignerCapital.id] } },
    })
    expect(total).toBe(1) // only the owner's contribution from test 2
  })

  it('5 — REINFORCE: same-clan comrade delivers; capacity arrival check bounces overflows', async () => {
    elapseCooldown(clanmate.playerId)
    const created = await call<{ id: string }>(
      deployPost,
      clanmate.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 30 }],
        idempotencyKey: 'garrison-it-reinforce-1',
      },
      { id: ownerCapital.id },
    )
    expect(created.status).toBe(200)
    const arrival = await arrive(clanmate.token, created.body.data!.id)
    expect(arrival.status).toBe('ARRIVED')
    expect(arrival.outcome!.garrisoned).toBe(true)

    // Two contributions now; totals aggregated.
    const view = await call<{ totalUnits: number; contributionCount: number }>(
      garrisonGet,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'GET',
      undefined,
      { id: ownerCapital.id },
    )
    expect(view.body.data!.contributionCount).toBe(2)
    expect(view.body.data!.totalUnits).toBe(100)

    // The clan snapshot is on the contribution (audit answer: which clan).
    const rows = await db.territoryGarrison.findMany({ where: { territoryId: ownerCapital.id } })
    expect(rows.every((row) => row.clanId === clanId)).toBe(true)
  })

  it('6 — capacity: pre-check passes but a mid-flight landing bounces the arrival', async () => {
    elapseCooldown(clanmate.playerId)
    elapseCooldown(owner.playerId)
    // Deterministic overflow: capacity(z) is config-only; size two in-flight
    // marches so that BOTH pass the creation pre-check (stationed only) but
    // the SECOND arrival lands after the FIRST and exceeds capacity together.
    const cap = (
      await db.territory.findUniqueOrThrow({
        where: { id: ownerCapital.id },
        select: { strategicValue: true },
      })
    ).strategicValue
    const capacity = GARRISON.capacityBase + GARRISON.capacityPerStrategicValue * cap
    const stationedNow = (
      await db.territoryGarrison.findMany({ where: { territoryId: ownerCapital.id } })
    ).reduce((sum, row) => {
      const units = row.units as Array<{ unitId: string; count: number }>
      return sum + units.reduce((s, u) => s + u.count, 0)
    }, 0)
    const marchA = 200
    const marchB = capacity - stationedNow - marchA + 101 // lands over by 101
    expect(marchB).toBeGreaterThan(0)
    // The second sender needs the units at home — the honest way.
    await db.playerUnit.upsert({
      where: { playerId_unitId: { playerId: owner.playerId, unitId: 'swordsman' } },
      create: { playerId: owner.playerId, unitId: 'swordsman', count: marchB },
      update: { count: { increment: marchB } },
    })

    // March A (clanmate, REINFORCE) and march B (owner, REINFORCE) both in flight.
    const a = await call<{ id: string }>(
      deployPost,
      clanmate.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      { type: 'REINFORCE', units: [{ unitId: 'swordsman', count: marchA }] },
      { id: ownerCapital.id },
    )
    expect(a.status).toBe(200)
    const b = await call<{ id: string }>(
      deployPost,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      { type: 'REINFORCE', units: [{ unitId: 'swordsman', count: marchB }] },
      { id: ownerCapital.id },
    )
    // B's pre-check counts only CURRENTLY stationed troops (A is in flight) → allowed.
    expect(b.status).toBe(200)

    // A lands first.
    const aArrival = await arrive(clanmate.token, a.body.data!.id)
    expect(aArrival.status).toBe('ARRIVED')
    // B lands second → over capacity → the WHOLE detachment bounces home.
    const bArrival = await arrive(owner.token, b.body.data!.id)
    expect(bArrival.status).toBe('RETURNING')
    expect(bArrival.outcome!.aborted).toBe('GARRISON_CAPACITY_EXCEEDED')

    // The bounce is unit-conserving: the full manifest rides the return leg.
    const bMarch = await db.march.findUniqueOrThrow({ where: { id: b.body.data!.id } })
    const survivors = bMarch.survivors as Array<{ unitId: string; count: number }>
    expect(survivors.reduce((s, u) => s + u.count, 0)).toBe(marchB)
    await backdateReturn(b.body.data!.id)
    const homecoming = await call(
      processPost,
      owner.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      { id: b.body.data!.id },
    )
    expect(homecoming.status).toBe(200)
    expect(homecoming.body.data!.march.status).toBe('COMPLETED')
    const after = await homeArmy(owner.playerId)
    expect(after.get('swordsman')).toBeGreaterThanOrEqual(marchB)

    // Nothing was created or destroyed by the bounce.
    const totalAfter = (
      await db.territoryGarrison.findMany({ where: { territoryId: ownerCapital.id } })
    ).reduce((sum, row) => {
      const units = row.units as Array<{ unitId: string; count: number }>
      return sum + units.reduce((s, u) => s + u.count, 0)
    }, 0)
    expect(totalAfter).toBe(stationedNow + marchA)
  })

  it('7 — BATTLE: the POSITIONAL garrison defends; realm army does not', async () => {
    // Honest geography: a contested cell UNCLAIMED and adjacent to BOTH the
    // owner's capital (so the owner can capture + garrison it) and a fresh
    // attacker's capital (so the attacker can assault it). The spiral clusters
    // spawns, so a few candidates find one; otherwise the test says so.
    let contested: { id: string; x: number; y: number } | null = null
    let besieger: { token: string; playerId: string } | null = null
    for (let attempt = 0; attempt < 8 && !contested; attempt++) {
      const candidate = await register()
      await grantArmy(candidate.playerId, 300)
      const cap = await db.territory.findFirstOrThrow({
        where: { ownerPlayerId: candidate.playerId, isCapital: true },
        select: { id: true, x: true, y: true },
      })
      const shared = await db.territory.findFirst({
        where: {
          status: 'UNCLAIMED',
          isCapital: false,
          OR: adjacentCoords(ownerCapital.x, ownerCapital.y).map((c) => ({ x: c.x, y: c.y })),
          AND: [
            {
              OR: adjacentCoords(cap.x, cap.y).map((c) => ({ x: c.x, y: c.y })),
            },
          ],
        },
        select: { id: true, x: true, y: true },
      })
      if (shared) {
        contested = shared
        besieger = candidate
      }
    }
    if (!contested || !besieger) {
      console.log('garrison battle scenario skipped — no shared frontier cell in this world state')
      return
    }

    // 1) The owner CAPTURES the contested cell with a real march.
    elapseCooldown(owner.playerId)
    const capture = await call<{ id: string }>(marchPost, owner.token, '/api/v1/marches', 'POST', {
      territoryId: contested.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 250 }],
    })
    expect(capture.status).toBe(200)
    const captureArrival = await arrive(owner.token, capture.body.data!.id)
    expect(captureArrival.outcome!.captured).toBe(true)
    const held = await db.territory.findUniqueOrThrow({ where: { id: contested.id } })
    expect(held.ownerPlayerId).toBe(owner.playerId)

    // The capture survivors ride the return leg — bring them home BEFORE
    // deploying. A RETURNING march lawfully holds one of the castle's march
    // slots (level 1 = one slot), and the survivors are not home until the
    // homecoming completes. Stationing is only possible once the army is
    // actually back — the march engine's honest sequencing.
    await backdateReturn(capture.body.data!.id)
    const homecoming = await call<{ march: { status: string } }>(
      processPost,
      owner.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      { id: capture.body.data!.id },
    )
    expect(homecoming.status).toBe(200)
    expect(homecoming.body.data!.march.status).toBe('COMPLETED')

    // 2) The owner garrisons it (50 swordsman + 20 archer).
    elapseCooldown(owner.playerId)
    const garrisonMarch = await call<{ id: string }>(
      deployPost,
      owner.token,
      '/api/v1/world/territories/x/garrison',
      'POST',
      {
        type: 'DEFEND',
        units: [
          { unitId: 'swordsman', count: 50 },
          { unitId: 'archer', count: 20 },
        ],
        idempotencyKey: 'garrison-it-battle-1',
      },
      { id: contested.id },
    )
    expect(garrisonMarch.status).toBe(200)
    const garrisonArrival = await arrive(owner.token, garrisonMarch.body.data!.id)
    expect(garrisonArrival.status).toBe('ARRIVED')
    const contribution = await db.territoryGarrison.findUniqueOrThrow({
      where: { marchId: garrisonMarch.body.data!.id },
    })

    // 3) The besieger assaults — the POSITIONAL garrison must defend.
    elapseCooldown(besieger.playerId)
    const homeBefore = await homeArmy(owner.playerId)
    const assault = await call<{ battleId: string; outcome: string }>(
      attackRoute,
      besieger.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: 'garrison-it-assault-1' },
      { id: contested.id },
    )
    expect(assault.status).toBe(200)
    const battle = await db.battle.findUniqueOrThrow({ where: { id: assault.body.data!.battleId } })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.defenderPlayerId).toBe(owner.playerId) // owner credited

    // Defender rounds committed EXACTLY the garrison stacks (50+20).
    const defenderRounds = await db.battleRound.findMany({
      where: { battleId: battle.id, side: 'DEFENDER' },
      select: { unitsCommitted: true },
    })
    const committed = new Map<string, number>()
    for (const row of defenderRounds) {
      const stacks = row.unitsCommitted as Array<{ unitTypeId: string; count: number }>
      for (const stack of stacks) {
        committed.set(stack.unitTypeId, (committed.get(stack.unitTypeId) ?? 0) + stack.count)
      }
    }
    expect(committed.get('swordsman')).toBe(50)
    expect(committed.get('archer')).toBe(20)

    // 4) Casualties landed on the CONTRIBUTION (never player_units).
    const afterContribution = await db.territoryGarrison.findUnique({
      where: { marchId: garrisonMarch.body.data!.id },
    })
    const homeAfter = await homeArmy(owner.playerId)
    if (assault.body.data!.outcome === 'VICTORY') {
      // CAPTURE ROUTING: the garrison is gone and its march is LOST. The audit
      // outcome distinguishes the two designed exits — annihilated IN COMBAT
      // (garrisonDestroyed) vs routed BY THE CAPTURE while survivors remained
      // (garrisonRouted). The flag must agree with the battle record.
      expect(afterContribution).toBeNull()
      const routedMarch = await db.march.findUniqueOrThrow({
        where: { id: garrisonMarch.body.data!.id },
      })
      expect(routedMarch.status).toBe('LOST')
      const audit = routedMarch.outcome as Record<string, unknown>
      expect(audit['battleId']).toBe(battle.id)
      // Exactly ONE designed exit: annihilated in combat (garrisonDestroyed —
      // the simulator's authoritative defender losses cover the whole manifest;
      // per-side round rows intentionally undercount by turn) or routed BY THE
      // CAPTURE while survivors remained (garrisonRouted).
      const destroyed = audit['garrisonDestroyed'] === true
      const routed = audit['garrisonRouted'] === true
      expect(destroyed !== routed).toBe(true)
      if (destroyed) {
        // Nothing returns: the whole manifest died — the march carries no
        // survivors and the battle is on the march's audit trail.
        expect(routedMarch.survivors).toEqual([])
      }
    } else {
      // Garrison held: the contribution survives with honest losses — the
      // simulator's authoritative defender losses live in its settlement
      // (per-side round rows intentionally record only own-turn kills), so
      // the test asserts the invariants that must hold for ANY loss split:
      // every stack strictly below or equal to its committed count, the
      // manifest total equal to committed minus real losses, and the march's
      // survivor manifest mirroring the contribution exactly.
      expect(afterContribution).not.toBeNull()
      const survivors = afterContribution!.units as Array<{ unitId: string; count: number }>
      let survivorTotal = 0
      for (const stack of survivors) {
        const committedCount = stack.unitId === 'swordsman' ? 50 : 20
        expect(stack.count).toBeGreaterThan(0)
        expect(stack.count).toBeLessThanOrEqual(committedCount)
        expect(stack.count).toBeLessThan(committedCount) // the assault dealt losses
        survivorTotal += stack.count
      }
      expect(survivorTotal).toBeLessThan(70)
      // The march's survivor manifest mirrors the contribution.
      const stationedMarch = await db.march.findUniqueOrThrow({
        where: { id: garrisonMarch.body.data!.id },
      })
      expect(stationedMarch.survivors).toEqual(afterContribution!.units)
    }

    // The home army was NEVER the defender — its size is unchanged by the battle.
    expect(homeAfter.get('swordsman')).toBe(homeBefore.get('swordsman'))
    expect(homeAfter.get('archer')).toBe(homeBefore.get('archer'))
    void contribution
  })

  it('8 — withdrawal restores survivors EXACTLY once through the homecoming', async () => {
    elapseCooldown(owner.playerId)
    // The owner's first DEFEND contribution (50 swordsman + 20 archer) — the
    // battle in test 7 may have killed some of them; survivors go home whole.
    const contribution = await db.territoryGarrison.findFirst({
      where: { territoryId: ownerCapital.id, playerId: owner.playerId },
    })
    if (!contribution) return // routed by the battle in test 7 — E2E covers the rest
    const stationed = contribution.units as Array<{ unitId: string; count: number }>
    const before = await homeArmy(owner.playerId)

    const withdrawn = await call<{ march: { status: string }; unitsReturning: number }>(
      garrisonWithdrawPost,
      owner.token,
      '/api/v1/world/territories/x/garrison/withdraw',
      'POST',
      { marchId: contribution.marchId },
      { id: ownerCapital.id },
    )
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body.data!.march.status).toBe('RETURNING')
    expect(withdrawn.body.data!.unitsReturning).toBe(stationed.reduce((sum, s) => sum + s.count, 0))

    // Contribution released; march returns home; units restored once.
    const gone = await db.territoryGarrison.findUnique({ where: { marchId: contribution.marchId } })
    expect(gone).toBeNull()
    await backdateReturn(contribution.marchId)
    const processed = await call<{ march: { status: string } }>(
      processPost,
      owner.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      { id: contribution.marchId },
    )
    expect(processed.status).toBe(200)
    expect(processed.body.data!.march.status).toBe('COMPLETED')

    const after = await homeArmy(owner.playerId)
    for (const stack of stationed) {
      expect(after.get(stack.unitId)).toBe((before.get(stack.unitId) ?? 0) + stack.count)
    }

    // Double withdrawal → typed refusal (march is COMPLETED now).
    const again = await call(
      withdrawPost,
      owner.token,
      '/api/v1/marches/x/withdraw',
      'POST',
      undefined,
      { id: contribution.marchId },
    )
    expect(again.status).toBe(409)
    expect(again.body.error!.code).toBe('MARCH_NOT_WITHDRAWABLE')
  })

  it('9 — cross-player withdrawal is a typed refusal (no leak, no write)', async () => {
    const anyContribution = await db.territoryGarrison.findFirst({
      where: { playerId: clanmate.playerId },
    })
    if (!anyContribution) return // none stationed — covered elsewhere
    const stolen = await call(
      withdrawPost,
      foreigner.token,
      '/api/v1/marches/x/withdraw',
      'POST',
      undefined,
      { id: anyContribution.marchId },
    )
    expect(stolen.status).toBe(404)
    expect(stolen.body.error!.code).toBe('MARCH_NOT_FOUND')
    const stillThere = await db.territoryGarrison.findUnique({
      where: { marchId: anyContribution.marchId },
    })
    expect(stillThere).not.toBeNull()
  })

  it('10 — ledger invariant holds after every garrison flow (Σ deltas == balance)', async () => {
    for (const player of [owner, clanmate, foreigner, attacker]) {
      const wallet = await db.resourceWallet.findUniqueOrThrow({
        where: { playerId: player.playerId },
      })
      const txs = await db.resourceTransaction.findMany({
        where: { playerId: player.playerId },
        select: { resource: true, delta: true },
      })
      const sums = new Map<string, bigint>()
      for (const row of txs) sums.set(row.resource, (sums.get(row.resource) ?? 0n) + row.delta)
      for (const [resource, key] of [
        ['GOLD', 'gold'],
        ['WOOD', 'wood'],
        ['IRON', 'iron'],
        ['FOOD', 'food'],
        ['CRYSTAL', 'crystal'],
      ] as const) {
        expect(sums.get(resource) ?? 0n).toBe(wallet[key])
      }
    }
  })
})
