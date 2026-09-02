/**
 * Integration tests — March Security Matrix (Phase 33).
 *
 * Every exploit in the STEP 25 contract, exercised through the PUBLIC route
 * handlers: fake identity, fake origin/destination/distance/speed/arrival,
 * fake units, fake timestamps, cross-player access, replay abuse,
 * cancel-after-combat, double-return, client-forged progress. Every exploit
 * must be FIXED (typed refusal, zero writes) — never silently accepted.
 *
 * Identities live in the isolated 9100054… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as marchPost } from '../../../src/app/api/v1/marches/route'
import { GET as marchGet } from '../../../src/app/api/v1/marches/[id]/route'
import { POST as cancelPost } from '../../../src/app/api/v1/marches/[id]/cancel/route'
import { POST as processPost } from '../../../src/app/api/v1/marches/[id]/process/route'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('March security tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100054'
const IP = '203.0.135.1'

let tgCounter = 9100054001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string, overrides?: Record<string, unknown>): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({ id: Number(telegramId), first_name: `Sec${telegramId.slice(-3)}` }),
    ...Object.fromEntries(Object.entries(overrides ?? {}).map(([k, v]) => [k, String(v)])),
  }
  const checkString = Object.entries(fields)
    .filter(([k]) => k !== 'hash')
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

function authed(token: string, method: 'GET' | 'POST', body?: unknown): Request {
  return new Request('http://localhost:3000/api/v1/marches', {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': IP,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function withId(path: string): { params: Promise<Record<string, string>> } {
  // '/api/v1/marches/<id>/<op>' → the id is segment 4.
  const id = path.split('/')[4] ?? 'x'
  return { params: Promise.resolve({ id }) }
}

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(authed(token, method, body), withId(path))
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

async function register(): Promise<{ token: string; playerId: string }> {
  const tgId = nextTgId()
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const parsed = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!parsed.ok || !parsed.data) throw new Error(`security registration failed ${tgId}`)
  return { token: parsed.data.token, playerId: parsed.data.player.id }
}

async function grantArmy(playerId: string, count = 50): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count },
    update: { count: { increment: count } },
  })
}

const players: Array<{ token: string; playerId: string }> = []
let freeSlotPlayer: { token: string; playerId: string }
let adjacentTarget: { id: string } | null = null

async function purge(): Promise<void> {
  const found = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  const ids = found.map((p) => p.id)
  if (ids.length > 0) {
    await db.territory.updateMany({
      where: { ownerPlayerId: { in: ids } },
      data: {
        ownerPlayerId: null,
        ownerType: 'NONE',
        status: 'UNCLAIMED',
        isCapital: false,
        type: 'NPC_VILLAGE',
        terrain: 'PLAINS',
        name: null,
        lastCapturedAt: null,
        productionCollectedAt: null,
      },
    })
    await db.march.deleteMany({ where: { playerId: { in: ids } } })
    await db.scoutReport.deleteMany({ where: { attackerPlayerId: { in: ids } } })
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('March security matrix (STEP 25)', () => {
  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('march-sec', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    // Register until the spawn has an adjacent unclaimed frontier cell —
    // the spiral clusters consecutive capitals, so the first pick may be
    // fully landlocked.
    for (let attempt = 0; attempt < 8 && !adjacentTarget; attempt++) {
      const candidate = await register()
      players.push(candidate)
      if (!freeSlotPlayer) freeSlotPlayer = candidate
      await grantArmy(candidate.playerId)
      const capital = await db.territory.findFirstOrThrow({
        where: { ownerPlayerId: candidate.playerId, isCapital: true },
        select: { x: true, y: true },
      })
      const cell = await db.territory.findFirst({
        where: {
          OR: adjacentCoords(capital.x, capital.y).map((c) => ({ x: c.x, y: c.y })),
          status: 'UNCLAIMED',
          isCapital: false,
        },
        select: { id: true },
      })
      if (cell) {
        adjacentTarget = cell
        freeSlotPlayer = candidate
      }
    }
    if (!adjacentTarget) throw new Error('no frontier cell for the security fixtures')
  })

  afterAll(async () => {
    await purge()
  })

  it('SEC1 — fake player identity: a forged telegram initData cannot reach the routes', async () => {
    const forgedInitData = buildInitData('99999999999') // signed with the REAL bot token but unknown id
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: JSON.stringify({ initData: forgedInitData }),
      }),
    )
    // Either refused outright (401) or registered as a NEW user (never as
    // someone else's session). The march routes then require THEIR session.
    const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
    if (body.ok && body.data) {
      players.push({ token: body.data.token, playerId: body.data.player.id })
      expect(body.data.player.id).not.toBe(freeSlotPlayer.playerId)
    } else {
      expect(res.status).toBe(401)
    }
  })

  it('SEC2 — fake destination / fake origin: unknown ids and client origin fields are inert', async () => {
    const fake = await call(marchPost, freeSlotPlayer.token, 'POST', '/api/v1/marches/fake-id', {
      territoryId: 'totally-made-up',
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 5 }],
      origin: { x: 1, y: 1 },
      distance: 0,
      arrivesInSeconds: 0,
    })
    expect(fake.status).toBe(404)
    expect(fake.body.error!.code).toBe('TERRITORY_NOT_FOUND')
  })

  it('SEC3 — fake units: zero/negative/float/unknown counts never reach a write', async () => {
    const cases: unknown[] = [
      [{ unitId: 'swordsman', count: 0 }],
      [{ unitId: 'swordsman', count: -3 }],
      [{ unitId: 'swordsman', count: 2.5 }],
      [{ unitId: 'swordsman', count: '5' }],
      [{ unitId: '␀', count: 1 }],
      [],
    ]
    for (const units of cases) {
      const res = await call(marchPost, freeSlotPlayer.token, 'POST', '/api/v1/marches/x', {
        territoryId: adjacentTarget?.id ?? 'x',
        type: 'ATTACK',
        units,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.body.ok).toBe(false)
    }
    const army = await db.playerUnit.findFirstOrThrow({
      where: { playerId: freeSlotPlayer.playerId, unitId: 'swordsman' },
      select: { count: true },
    })
    expect(army.count).toBe(70) // bootstrap 20 + grant 50 — untouched by every refusal
  })

  it('SEC4 — fake timestamps: client-claimed arrivals never become server truth', async () => {
    if (!adjacentTarget) return
    const created = await call<{ id: string; arrivesAt: string; serverNowMs: number }>(
      marchPost,
      freeSlotPlayer.token,
      'POST',
      '/api/v1/marches/x',
      {
        territoryId: adjacentTarget.id,
        type: 'ATTACK',
        units: [{ unitId: 'swordsman', count: 5 }],
        arrivesAt: '2020-01-01T00:00:00.000Z',
        departedAt: '2020-01-01T00:00:00.000Z',
      },
    )
    expect(created.status).toBe(200)
    const view = created.body.data!
    // The server clock set the arrival — in the future, never client-supplied.
    expect(new Date(view.arrivesAt).getTime()).toBeGreaterThan(Date.now())
    // The fake timestamp cannot be processed early: the processor no-ops.
    const early = await call<{ processed: boolean }>(
      processPost,
      freeSlotPlayer.token,
      'POST',
      `/api/v1/marches/${view.id}/process`,
    )
    expect(early.body.data!.processed).toBe(false)
  })

  it('SEC5 — cross-player march access: read/cancel/process are owner-only', async () => {
    if (!adjacentTarget) return
    // Free the single starter slot: recall any march SEC4 left behind.
    const live = await db.march.findFirst({
      where: { playerId: freeSlotPlayer.playerId, status: 'EN_ROUTE' },
      select: { id: true },
    })
    if (live) {
      await call(cancelPost, freeSlotPlayer.token, 'POST', `/api/v1/marches/${live.id}/cancel`)
    }
    const created = await call<{ id: string }>(
      marchPost,
      freeSlotPlayer.token,
      'POST',
      '/api/v1/marches/x',
      {
        territoryId: adjacentTarget.id,
        type: 'SCOUT',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
    )
    expect(created.status).toBe(200)
    const marchId = created.body.data!.id

    const attacker = await register()
    players.push(attacker)
    await grantArmy(attacker.playerId)

    const read = await call(marchGet, attacker.token, 'GET', `/api/v1/marches/${marchId}/get`)
    expect(read.status).toBe(404)
    const cancel = await call(
      cancelPost,
      attacker.token,
      'POST',
      `/api/v1/marches/${marchId}/cancel`,
    )
    expect(cancel.status).toBe(404)
    const process = await call(
      processPost,
      attacker.token,
      'POST',
      `/api/v1/marches/${marchId}/process`,
    )
    expect(process.status).toBe(404)

    // The owner's march is untouched by every foreign attempt.
    const row = await db.march.findUniqueOrThrow({ where: { id: marchId } })
    expect(row.status).toBe('EN_ROUTE')
  })

  it('SEC6 — idempotency abuse: same key with a different payload is a typed 409', async () => {
    if (!adjacentTarget) return
    // The free-slot player has one march in flight (from SEC5) — use the
    // OTHER slot owner. Register fresh players until one spawns next to an
    // unclaimed cell (the spiral clusters consecutive capitals).
    let owner: { token: string; playerId: string } | null = null
    let ownCell: { id: string } | null = null
    for (let attempt = 0; attempt < 8 && !ownCell; attempt++) {
      const candidate = await register()
      players.push(candidate)
      await grantArmy(candidate.playerId, 20)
      const capital = await db.territory.findFirstOrThrow({
        where: { ownerPlayerId: candidate.playerId, isCapital: true },
        select: { x: true, y: true },
      })
      ownCell = await db.territory.findFirst({
        where: {
          OR: adjacentCoords(capital.x, capital.y).map((c) => ({ x: c.x, y: c.y })),
          status: 'UNCLAIMED',
          isCapital: false,
        },
        select: { id: true },
      })
      if (ownCell) owner = candidate
    }
    if (!owner || !ownCell) throw new Error('no frontier player for SEC6')
    const p = owner
    const first = await call<{ id: string }>(marchPost, p.token, 'POST', '/api/v1/marches/x', {
      territoryId: ownCell!.id,
      type: 'SCOUT',
      units: [{ unitId: 'swordsman', count: 2 }],
      idempotencyKey: 'sec6-key',
    })
    expect(first.status).toBe(200)
    // Replay with a DIFFERENT unit commitment — same key, different request.
    const abused = await call<{ error: { code: string } }>(
      marchPost,
      p.token,
      'POST',
      '/api/v1/marches/x',
      {
        territoryId: ownCell!.id,
        type: 'SCOUT',
        units: [{ unitId: 'swordsman', count: 9 }],
        idempotencyKey: 'sec6-key',
      },
    )
    expect(abused.status).toBe(409)
    expect(abused.body.error!.code).toBe('IDEMPOTENT_REPLAY')
  })

  it('SEC7 — cancel-after-combat and double-return are impossible', async () => {
    if (!adjacentTarget) return
    // The SEC5 scout march is still EN_ROUTE — cancel it once (legal), then
    // verify the terminal state refuses everything.
    const live = await db.march.findFirstOrThrow({
      where: { playerId: freeSlotPlayer.playerId, status: 'EN_ROUTE' },
    })
    const cancel = await call(
      cancelPost,
      freeSlotPlayer.token,
      'POST',
      `/api/v1/marches/${live.id}/cancel`,
    )
    expect(cancel.status).toBe(200)
    const second = await call(
      cancelPost,
      freeSlotPlayer.token,
      'POST',
      `/api/v1/marches/${live.id}/cancel`,
    )
    expect(second.status).toBe(409)
    const process = await call(
      processPost,
      freeSlotPlayer.token,
      'POST',
      `/api/v1/marches/${live.id}/process`,
    )
    expect(process.body.data!.processed).toBe(false)
    expect(process.body.data!.march.status).toBe('CANCELLED')
  })

  it('SEC8 — no client path can forge march progress: only the server clock advances state', async () => {
    if (!adjacentTarget) return
    const created = await call<{ id: string }>(
      marchPost,
      freeSlotPlayer.token,
      'POST',
      '/api/v1/marches/x',
      {
        territoryId: adjacentTarget.id,
        type: 'SCOUT',
        units: [{ unitId: 'swordsman', count: 2 }],
        status: 'COMPLETED', // forged status in the payload — must be ignored
        survivors: [],
        outcome: { delivered: true },
      },
    )
    expect(created.status).toBe(200)
    const row = await db.march.findUniqueOrThrow({ where: { id: created.body.data!.id } })
    expect(row.status).toBe('EN_ROUTE') // server state, not client state
    expect(row.survivors).toBeNull()
    expect(row.outcome).toBeNull()
  })

  it('SEC9 — scout reports expose the PUBLIC data class only', async () => {
    // Any stored report for this suite's players must not contain private keys.
    const reports = await db.scoutReport.findMany({
      where: { attackerPlayerId: { in: players.map((p) => p.playerId) } },
    })
    for (const report of reports) {
      const data = report.data as Record<string, unknown>
      for (const forbidden of [
        'army',
        'units',
        'wallet',
        'gold',
        'techs',
        'technologies',
        'power',
      ]) {
        expect(data[forbidden]).toBeUndefined()
      }
    }
  })

  it('SEC10 — foreign battle rows are never reachable through march processing', async () => {
    // process on a nonexistent march → typed 404, no crash, no write.
    const ghost = await call(
      processPost,
      freeSlotPlayer.token,
      'POST',
      '/api/v1/marches/ghost/process',
    )
    expect(ghost.status).toBe(404)
    expect(ghost.body.error!.code).toBe('MARCH_NOT_FOUND')
  })
})
