/**
 * Integration tests — World Load (Phase 32): REAL measurements, no claims
 * without numbers.
 *
 * Surfaces measured:
 *  - PURE GENERATOR at 100 / 1,000 / 10,000 cells (deterministic generation cost)
 *  - MAP API at 100 / 400 / 441 cells (the policy viewport cap is 441 — the
 *    API refuses larger viewports by design; the full-grid cost is measured
 *    at the DB query level below)
 *  - FULL-GRID DB range scan (1,681 rows — the whole world) with N+1 inspection
 *  - DETAIL API under parallel read load
 *  - ASSAULT PIPELINE latency over 20 sequential real assaults (lock + battle
 *    + capture + ledger + quest + notification per assault)
 *
 * The world is a shared sandbox fixture — every query here is read-only for
 * game state except the timed assaults, which use the suite's own players.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as mapGet } from '../../../src/app/api/v1/world/map/route'
import { GET as detailGet } from '../../../src/app/api/v1/world/territories/[id]/route'
import { POST as attackPost } from '../../../src/app/api/v1/world/territories/[id]/attack/route'
import { generateWorld, adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { WORLD_ATTACK } from '../../../src/lib/game/config/world'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'World load tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100035'
const IP = '203.0.136.'
let ipCounter = 1
const nextIp = (): string => `${IP}${ipCounter++}`
let tgCounter = 9100035001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAELD0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `LoadLord${telegramId.slice(-3)}`,
      username: `load_lord_${telegramId.slice(-4)}`,
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
      'x-forwarded-for': nextIp(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
  territoryId?: string,
): Promise<{ status: number; body: ApiEnvelope<T>; ms: number }> {
  const started = performance.now()
  const res = await handler(
    authed(path, token, method, payload),
    territoryId ? { params: Promise.resolve({ id: territoryId }) } : undefined,
  )
  const ms = performance.now() - started
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T>, ms }
}

async function register(): Promise<{ token: string; playerId: string; tgId: string }> {
  const tgId = nextTgId()
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`load registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
}

async function grantVeteranArmy(playerId: string): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: 200 },
    update: { count: { increment: 200 } },
  })
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
        lastCapturedAt: null,
        productionCollectedAt: null,
      },
    })
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('World load (generator · map API · full-grid · parallel reads · assault latency)', () => {
  let lord: { token: string; playerId: string }

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('world-load', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    lord = await register()
    await grantVeteranArmy(lord.playerId)
  })

  afterAll(purge)

  it('1 — PURE GENERATOR: 100 / 1,000 / 10,000 cells with timings', () => {
    const sizes: Array<[number, number, number]> = [
      [10, 10, 100],
      [32, 32, 1_024],
      [100, 100, 10_000],
    ]
    for (const [sizeX, sizeY, cells] of sizes) {
      const started = performance.now()
      const world = generateWorld({ sizeX, sizeY, regionSize: 7 })
      const ms = performance.now() - started
      expect(world.territories).toHaveLength(cells)
      // Generation is O(cells) and fast — 10k cells must stay in the ms range.
      expect(ms).toBeLessThan(2_000)
      console.log(
        `[load] generateWorld ${cells} cells → ${ms.toFixed(1)} ms (${((ms / cells) * 1000).toFixed(1)} µs/cell)`,
      )
    }
  })

  it('2 — MAP API: 100 / 400 / 441-cell viewports with latency assertions', async () => {
    const viewports: Array<[string, number]> = [
      ['minX=0&maxX=9&minY=0&maxY=9', 100],
      ['minX=0&maxX=19&minY=0&maxY=19', 400],
      ['minX=0&maxX=20&minY=0&maxY=20', 441],
    ]
    for (const [query, cells] of viewports) {
      const { status, body, ms } = await call<{ total: number }>(
        mapGet,
        lord.token,
        `/api/v1/world/map?${query}`,
      )
      expect(status).toBe(200)
      expect(body.data!.total).toBe(cells)
      expect(ms).toBeLessThan(1_000) // generous CI bound; measured value logged
      console.log(`[load] map ${cells} cells → ${ms.toFixed(1)} ms`)
    }
  })

  it('3 — FULL-GRID DB range scan: 1,681 rows in bounded queries (no N+1)', async () => {
    // A dedicated client captures the query stream for the N+1 probe.
    const probe = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })
    const queries: string[] = []
    probe.$on('query', (event: unknown) => {
      queries.push((event as { query?: string }).query ?? '')
    })
    const started = performance.now()
    const rows = await probe.territory.findMany({
      where: { x: { gte: 0, lte: 40 }, y: { gte: 0, lte: 40 } },
      include: { ownerPlayer: { select: { name: true } } },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
    })
    const ms = performance.now() - started
    await probe.$disconnect()
    expect(rows).toHaveLength(1_681)
    // N+1 probe: the probe client runs EXACTLY ONE findMany — its whole query
    // stream must be a handful of statements (main scan + batched owner lookup),
    // never one statement per row (SQLite names are schema-qualified).
    const selects = queries.filter((q) => /SELECT/i.test(q))
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.length).toBeLessThanOrEqual(4)
    expect(selects.length).toBeLessThanOrEqual(4)
    console.log(
      `[load] full-grid scan 1,681 rows → ${ms.toFixed(1)} ms, ${queries.length} SQL statements`,
    )
    expect(ms).toBeLessThan(1_000)
  })

  it('4 — DETAIL API: 25 parallel reads stay bounded', async () => {
    const cells = await db.territory.findMany({
      where: { x: { gte: 10, lte: 14 }, y: { gte: 10, lte: 14 } },
      select: { id: true },
      take: 25,
    })
    const started = performance.now()
    const results = await Promise.all(
      cells.map((cell) =>
        call(detailGet, lord.token, '/api/v1/world/territories/x', 'GET', undefined, cell.id),
      ),
    )
    const ms = performance.now() - started
    for (const res of results) expect(res.status).toBe(200)
    expect(ms).toBeLessThan(5_000)
    console.log(
      `[load] 25 parallel details → ${ms.toFixed(1)} ms total, ${(ms / 25).toFixed(1)} ms avg`,
    )
  })

  it('5 — ASSAULT PIPELINE: 20 sequential real assaults with per-assault latency', async () => {
    // Build an expansion corridor: capture + expand until 20 assaults done.
    const latencies: number[] = []
    let captures = 0
    for (let round = 0; round < 20; round++) {
      const owned = await db.territory.findMany({
        where: { ownerPlayerId: lord.playerId },
        select: { x: true, y: true },
      })
      const coords = new Set<string>()
      for (const cell of owned) {
        for (const adj of adjacentCoords(cell.x, cell.y)) coords.add(`${adj.x},${adj.y}`)
      }
      const list = [...coords].map((key) => key.split(',').map(Number) as [number, number])
      const next = await db.territory.findFirst({
        where: { status: 'UNCLAIMED', isCapital: false, OR: list.map(([x, y]) => ({ x, y })) },
        orderBy: [{ y: 'asc' }, { x: 'asc' }],
        select: { id: true },
      })
      if (!next) break // sandbox frontier exhausted — the measurement stands
      // Elapse the shared cooldown (server-clock backdating) + refill energy.
      await db.battle.updateMany({
        where: {
          attackerPlayerId: lord.playerId,
          type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] },
        },
        data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
      })
      await db.player.update({ where: { id: lord.playerId }, data: { energy: 100 } })

      const { status, ms } = await call(
        attackPost,
        lord.token,
        '/api/v1/world/territories/x/attack',
        'POST',
        { idempotencyKey: `load-${lord.tgId}-${round}` },
        next.id,
      )
      expect(status).toBe(200)
      latencies.push(ms)
      captures += 1
    }
    expect(captures).toBe(20)
    const total = latencies.reduce((a, b) => a + b, 0)
    const avg = total / latencies.length
    const max = Math.max(...latencies)
    console.log(
      `[load] 20 real assaults → avg ${avg.toFixed(1)} ms · max ${max.toFixed(1)} ms · total ${total.toFixed(1)} ms`,
    )
    // The full pipeline (lock + simulate + capture + ledger + quests + achievements
    // + notifications) must stay well under interactive bounds.
    expect(avg).toBeLessThan(2_500)
    expect(max).toBeLessThan(10_000)
    expect(WORLD_ATTACK.energyCost).toBeGreaterThan(0) // sanity: config untouched
  })
})
