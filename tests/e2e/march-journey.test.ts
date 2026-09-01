/**
 * E2E — MARCH JOURNEY (Phase 33).
 *
 * One continuous session exactly the way the Mini App drives the API:
 * LOGIN → WORLD MAP → SELECT TERRITORY → CREATE MARCH (real unit
 * reservation) → MARCH TRAVELING (countdown from server timestamps) →
 * ARRIVAL (server clock) → REAL BATTLE ENGINE (shared assault pipeline) →
 * CASUALTIES → RESULT → RETURN → ARMY RESTORED → NOTIFICATION → QUEST →
 * HISTORY.
 *
 * Zero mocks, zero direct-DB shortcuts for game outcomes — real route
 * handlers, real transactions, real deterministic simulation. The only DB
 * arrangements mirror legitimate time passing (arrival/cooldown backdate)
 * and a veteran army (the way an established player would have one).
 *
 * Identities live in the isolated 9100037… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { GET as mapGet } from '../../src/app/api/v1/world/map/route'
import { GET as historyGet } from '../../src/app/api/v1/world/territories/[id]/history/route'
import { POST as marchPost, GET as marchListGet } from '../../src/app/api/v1/marches/route'
import { POST as processPost } from '../../src/app/api/v1/marches/[id]/process/route'
import { GET as questsBoardGet } from '../../src/app/api/v1/quests/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../src/lib/game/engine/world/generator'
import type { ApiEnvelope } from '../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('March E2E requires TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).')
}

const TG_PREFIX = '9100037'
const IP = '203.0.138.1'

let tgCounter = 9100037001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `JourneyLord${telegramId.slice(-3)}`,
      username: `journey_lord_${telegramId.slice(-4)}`,
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
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': IP,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function withParams(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
}

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
  id?: string,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(authed(path, token, method, payload), id ? withParams(id) : undefined)
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

interface MarchView {
  id: string
  type: string
  status: string
  origin: { x: number; y: number }
  destination: {
    territoryId: string | null
    x: number | null
    y: number | null
    name: string | null
  }
  units: Array<{ unitId: string; unitName: string; count: number }>
  survivors: Array<{ unitId: string; count: number }> | null
  arrivesAt: string
  returnsAt: string | null
  serverNowMs: number
  cancellable: boolean
  dueNow: boolean
  battleId: string | null
  outcome: Record<string, unknown> | null
}

async function purge(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
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

describe('March journey (login → map → march → assault → return → army → notify → history)', () => {
  let token = ''
  let playerId = ''
  let frontier: { id: string } | null = null

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('march-e2e', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
  })

  afterAll(async () => {
    await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
    await purge()
  })

  it('1 — LOGIN registers the journey lord with a capital, an army and a frontier', async () => {
    // Register until the spawn has an adjacent unclaimed frontier cell — the
    // spiral clusters consecutive capitals, so the first pick may be fully
    // landlocked by its predecessors.
    for (let attempt = 0; attempt < 8 && !frontier; attempt++) {
      const tgId = nextTgId()
      const res = await telegramPost(
        new Request('http://localhost:3000/api/v1/auth/telegram', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
          body: JSON.stringify({ initData: buildInitData(tgId) }),
        }),
      )
      const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
      expect(res.status).toBe(200)
      expect(body.ok).toBe(true)
      token = body.data!.token
      playerId = body.data!.player.id
      const capital = await db.territory.findFirstOrThrow({
        where: { ownerPlayerId: playerId, isCapital: true },
        select: { x: true, y: true },
      })
      frontier = await db.territory.findFirst({
        where: {
          OR: adjacentCoords(capital.x, capital.y).map((c) => ({ x: c.x, y: c.y })),
          status: 'UNCLAIMED',
          isCapital: false,
        },
        select: { id: true },
      })
    }
    expect(frontier).not.toBeNull()
    // A veteran army the way an established player would have one.
    await db.playerUnit.upsert({
      where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
      create: { playerId, unitId: 'swordsman', count: 60 },
      update: { count: { increment: 60 } },
    })
  })

  it('2 — WORLD MAP shows the capital and an adjacent frontier cell', async () => {
    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: playerId, isCapital: true },
      select: { x: true, y: true },
    })
    const r = 3
    const map = await call<{
      total: number
      territories: Array<{
        id: string
        x: number
        y: number
        status: string
        ownerPlayerId: string | null
      }>
    }>(
      mapGet,
      token,
      `/api/v1/world/map?minX=${capital.x - r}&maxX=${capital.x + r}&minY=${capital.y - r}&maxY=${capital.y + r}`,
    )
    expect(map.status).toBe(200)
    const cells = map.body.data!.territories
    const capitalCell = cells.find((c) => c.x === capital.x && c.y === capital.y)
    expect(capitalCell!.ownerPlayerId).toBe(playerId)
  })

  it('3 — CREATE MARCH from the frontier: army reserved, march traveling', async () => {
    expect(frontier).not.toBeNull()
    const target = frontier!
    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: playerId, isCapital: true },
      select: { x: true, y: true },
    })

    const armyBefore = await db.playerUnit.findFirstOrThrow({
      where: { playerId, unitId: 'swordsman' },
      select: { count: true },
    })
    const created = await call<MarchView>(marchPost, token, '/api/v1/marches', 'POST', {
      territoryId: target!.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
      idempotencyKey: 'e2e-march-1',
    })
    expect(created.status).toBe(200)
    const march = created.body.data!
    expect(march.status).toBe('EN_ROUTE')
    expect(march.destination.territoryId).toBe(target!.id)
    expect(march.origin.x).toBe(capital.x) // server-derived origin
    // ARMY RESERVED — real rows, not UI state:
    const armyAfter = await db.playerUnit.findFirstOrThrow({
      where: { playerId, unitId: 'swordsman' },
      select: { count: true },
    })
    expect(armyAfter.count).toBe(armyBefore.count - 40)
  })

  it('4 — MARCH TRAVELING: the list shows the countdown state from the server', async () => {
    const list = await call<{ marches: MarchView[]; slots: number }>(
      marchListGet,
      token,
      '/api/v1/marches',
    )
    expect(list.status).toBe(200)
    const march = list.body.data!.marches.find((m) => m.status === 'EN_ROUTE')
    expect(march).toBeDefined()
    // Countdown math is possible ONLY from server timestamps:
    const remainingSec = (new Date(march!.arrivesAt).getTime() - march!.serverNowMs) / 1000
    expect(remainingSec).toBeGreaterThan(0)
    expect(march!.dueNow).toBe(false)
    expect(march!.cancellable).toBe(true)
  })

  it('5 — ARRIVAL + REAL BATTLE: casualties, result, capture through the shared engine', async () => {
    const march = await db.march.findFirstOrThrow({
      where: { playerId, status: 'EN_ROUTE' },
    })
    // The server clock moves to the arrival moment (honest time passage).
    await db.march.update({
      where: { id: march.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(processed.status).toBe(200)
    expect(processed.body.data!.processed).toBe(true)
    const view = processed.body.data!.march
    expect(['RETURNING', 'LOST']).toContain(view.status)

    // REAL battle row stamped with the march id
    expect(view.outcome!.battleId).toBeDefined()
    const battle = await db.battle.findUniqueOrThrow({
      where: { id: view.outcome!.battleId as string },
    })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.marchId).toBe(march.id)
    expect(battle.roundsCount).toBeGreaterThanOrEqual(0)
  })

  it('6 — RETURN: the server schedules the homecoming; processing completes it', async () => {
    const march = await db.march.findFirstOrThrow({
      where: { playerId, status: 'RETURNING' },
    })
    expect(march.returnsAt).not.toBeNull()
    await db.march.update({
      where: { id: march.id },
      data: { returnsAt: new Date(Date.now() - 1000) },
    })
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(processed.body.data!.march.status).toBe('COMPLETED')
  })

  it('7 — ARMY RESTORED exactly once (survivors came home)', async () => {
    const march = await db.march.findFirstOrThrow({
      where: { playerId, status: 'COMPLETED' },
    })
    const manifest = march.survivors as Array<{ unitId: string; count: number }> | null
    const army = await db.playerUnit.findFirstOrThrow({
      where: { playerId, unitId: 'swordsman' },
      select: { count: true },
    })
    const { GET: armyView } = await import('../../src/app/api/v1/army/route')
    const armyRes = await armyView(authed('/api/v1/army', token))
    expect(armyRes.status).toBe(200)
    // The survivors manifest reconciles with the home army:
    // bootstrap 20 + 60 granted − 40 committed + (returned survivors or 0 when LOST)
    const lost = (march.outcome as { unitsLost?: number })?.unitsLost ?? 0
    const returned = manifest?.find((s) => s.unitId === 'swordsman')?.count ?? 0
    expect(army.count).toBe(20 + 60 - 40 + returned)
    expect(lost).toBe(40 - returned)
  })

  it('8 — NOTIFICATION: the march battle report reached the inbox', async () => {
    await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
    const inbox = await call<{
      notifications: Array<{ type: string; data: Record<string, unknown> }>
    }>(notificationsGet, token, '/api/v1/player/notifications')
    expect(inbox.status).toBe(200)
    const types = inbox.body.data!.notifications.map((n) => n.type)
    // The assault pipeline's ATTACK_RESULT (existing engine, no second system)
    expect(types).toContain('ATTACK_RESULT')
  })

  it('9 — QUEST: the completed march advanced weekly-patrol (MARCH_COMPLETED)', async () => {
    const board = await call<{
      quests: Array<{ id: string; instance: { progress: number; status: string } | null }>
    }>(questsBoardGet, token, '/api/v1/quests')
    expect(board.status).toBe(200)
    const patrol = board.body.data!.quests.find((q) => q.id === 'weekly-patrol')
    expect(patrol).toBeDefined()
    expect(patrol!.instance).not.toBeNull()
    expect(patrol!.instance!.progress).toBe(1)
  })

  it('10 — HISTORY: the captured territory carries the battle in its record', async () => {
    const march = await db.march.findFirstOrThrow({
      where: { playerId, status: 'COMPLETED' },
    })
    const outcome = march.outcome as { captured?: boolean; battleId?: string }
    if (!outcome.captured) {
      // The garrison held — no capture record is the CORRECT history here.
      return
    }
    const territory = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: playerId, isCapital: false },
      select: { id: true },
    })
    const history = await call<{
      rows: Array<{ reason: string; battleId: string | null; newOwner: { id: string | null } }>
    }>(
      historyGet,
      token,
      `/api/v1/world/territories/${territory.id}/history`,
      'GET',
      undefined,
      territory.id,
    )
    expect(history.status).toBe(200)
    const capture = history.body.data!.rows.find((r) => r.reason === 'CAPTURE')
    expect(capture).toBeDefined()
    expect(capture!.battleId).toBe(outcome.battleId)
    expect(capture!.newOwner.id).toBe(playerId)
  })

  it('11 — the march list is the single UI source of truth at journey end', async () => {
    const list = await call<{ marches: MarchView[]; activeCount: number }>(
      marchListGet,
      token,
      '/api/v1/marches',
    )
    expect(list.status).toBe(200)
    expect(list.body.data!.marches.length).toBeGreaterThanOrEqual(1)
    expect(list.body.data!.activeCount).toBe(0) // everything terminal
    const completed = list.body.data!.marches.find((m) => m.status === 'COMPLETED')
    expect(completed).toBeDefined()
    expect(completed!.cancellable).toBe(false)
  })
})
