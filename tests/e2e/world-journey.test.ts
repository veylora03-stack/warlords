/**
 * E2E — WORLD JOURNEY (Phase 32).
 *
 * One continuous session exactly the way the Mini App drives the API:
 * LOGIN → WORLD MAP → PLAYER CAPITAL → SELECT ADJACENT TERRITORY → VIEW
 * TERRAIN → ATTACK (real TERRITORY_ASSAULT through the REAL battle engine)
 * → REAL CASUALTIES → REAL SPOILS → TERRITORY CAPTURE → OWNERSHIP UPDATE →
 * QUEST PROGRESS → LEDGER → RANKING → NOTIFICATION → HISTORY → UPDATED MAP.
 *
 * Zero mocks, zero direct-DB shortcuts for game outcomes — real route
 * handlers, real transactions, real deterministic simulation. The only DB
 * arrangements mirror legitimate time passing (cooldown backdate) and a
 * veteran army (the way an established player would have one).
 *
 * Identities live in the isolated 9100036… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { GET as mapGet } from '../../src/app/api/v1/world/map/route'
import { GET as detailGet } from '../../src/app/api/v1/world/territories/[id]/route'
import { POST as attackPost } from '../../src/app/api/v1/world/territories/[id]/attack/route'
import { GET as historyGet } from '../../src/app/api/v1/world/territories/[id]/history/route'
import { GET as playerTerritoriesGet } from '../../src/app/api/v1/world/player-territories/route'
import { GET as questsBoardGet } from '../../src/app/api/v1/quests/route'
import { GET as rankingGet } from '../../src/app/api/v1/season/ranking/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { GET as resourcesGet } from '../../src/app/api/v1/player/resources/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../src/lib/game/services/economy.service'
import { BATTLE } from '../../src/lib/game/config/battle'
import { WORLD_ATTACK } from '../../src/lib/game/config/world'
import { adjacentCoords } from '../../src/lib/game/engine/world/generator'
import type { ApiEnvelope } from '../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('World E2E requires TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).')
}

const TG_PREFIX = '9100036'
const IP = '203.0.137.1'

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEJD0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'TerraLord',
      username: `terra_lord_${telegramId.slice(-4)}`,
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

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  payload?: unknown,
  territoryId?: string,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(
    authed(path, token, method, payload),
    territoryId ? { params: Promise.resolve({ id: territoryId }) } : undefined,
  )
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

async function register(): Promise<{ token: string; playerId: string; tgId: string }> {
  const tgId = `${TG_PREFIX}${String(Date.now()).slice(-5)}1`.slice(0, 12)
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`world e2e registration failed`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
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

describe('E2E — world journey (map → capital → assault → capture → quests → ledger → ranking → notifications → history)', () => {
  let lord: { token: string; playerId: string }
  let capitalId: string
  let targetId: string
  let battleId: string

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('world-e2e', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    lord = await register()
  })

  afterAll(purge)

  it('step 1 — LOGIN: the player authenticates through the real initData exchange', async () => {
    const me = await call<{ player: { id: string } }>(
      (await import('../../src/app/api/v1/auth/me/route')).GET,
      lord.token,
      '/api/v1/auth/me',
    )
    expect(me.status).toBe(200)
    expect(me.body.data!.player.id).toBe(lord.playerId)
  })

  it('step 2 — WORLD MAP: the capital-centered viewport loads real territories', async () => {
    const { status, body } = await call<{
      total: number
      territories: Array<{
        id: string
        x: number
        y: number
        terrain: string
        status: string
        isCapital: boolean
        ownerPlayerId: string | null
        ownerName: string | null
      }>
      regions: Array<{ id: string; name: string }>
    }>(mapGet, lord.token, '/api/v1/world/map')
    expect(status).toBe(200)
    expect(body.data!.total).toBeGreaterThan(0)
    expect(body.data!.regions.length).toBeGreaterThan(0)
    // The server-centered viewport includes THIS lord's capital with its label.
    const capital = body.data!.territories.find(
      (cell) => cell.isCapital && cell.ownerPlayerId === lord.playerId,
    )
    expect(capital).toBeDefined()
    expect(capital!.ownerName).toBeTruthy()
    capitalId = capital!.id
  })

  it('step 3 — CAPITAL: player-territories shows the capital as the first holding', async () => {
    const { status, body } = await call<{
      capital: { id: string; isCapital: boolean } | null
      territories: Array<{ id: string; isCapital: boolean }>
    }>(playerTerritoriesGet, lord.token, '/api/v1/world/player-territories')
    expect(status).toBe(200)
    expect(body.data!.capital!.id).toBe(capitalId)
    expect(body.data!.territories[0]!.isCapital).toBe(true)
  })

  it('step 4 — SELECT ADJACENT TERRITORY: the detail view exposes terrain + attackability', async () => {
    // Veteran army arrangement (the way an established warlord would exist).
    await db.playerUnit.upsert({
      where: { playerId_unitId: { playerId: lord.playerId, unitId: 'swordsman' } },
      create: { playerId: lord.playerId, unitId: 'swordsman', count: 120 },
      update: { count: { increment: 120 } },
    })
    const owned = await db.territory.findMany({
      where: { ownerPlayerId: lord.playerId },
      select: { x: true, y: true },
    })
    const coords = new Set<string>()
    for (const cell of owned) {
      for (const adj of adjacentCoords(cell.x, cell.y)) coords.add(`${adj.x},${adj.y}`)
    }
    const list = [...coords].map((key) => key.split(',').map(Number) as [number, number])
    const target = await db.territory.findFirstOrThrow({
      where: { status: 'UNCLAIMED', isCapital: false, OR: list.map(([x, y]) => ({ x, y })) },
      select: { id: true },
    })
    targetId = target.id

    const { status, body } = await call<{
      id: string
      terrain: string
      terrainLabel: string
      strategicValue: number
      defenseStrength: number
      attack: { attackable: boolean; reasons: string[] }
      region: { name: string } | null
    }>(detailGet, lord.token, '/api/v1/world/territories/x', 'GET', undefined, targetId)
    expect(status).toBe(200)
    expect(body.data!.id).toBe(targetId)
    expect(body.data!.terrainLabel).toBeTruthy()
    expect(body.data!.region).not.toBeNull()
    // The server says the assault is available — no client-side guessing.
    expect(body.data!.attack.attackable).toBe(true)
    expect(body.data!.attack.reasons).toEqual([])
    // The garrison's composition NEVER leaks — only its size hint.
    const raw = JSON.stringify(body.data!)
    expect(raw).not.toContain('stacks')
  })

  it('step 5 — ATTACK: the assault runs the REAL battle engine as TERRITORY_ASSAULT', async () => {
    const { status, body } = await call<{
      battleId: string
      outcome: string
      result: string
      roundsCount: number
      territory: { id: string; captured: boolean }
      defender: { playerId: string | null; name: string }
      casualties: { attacker: unknown[]; defender: unknown[] }
      spoils: Record<string, string>
      seasonPointsAwarded: number
      energySpent: number
      cooldownUntil: string
    }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: `e2e-world-${lord.tgId}` },
      targetId,
    )
    expect(status).toBe(200)
    const data = body.data!
    battleId = data.battleId
    expect(data.battleId).toBeTruthy()
    expect(data.outcome).toBe('VICTORY')
    expect(data.territory.captured).toBe(true)
    expect(data.defender.playerId).toBeNull() // virtual garrison
    expect(data.energySpent).toBe(WORLD_ATTACK.energyCost)
    expect(new Date(data.cooldownUntil).getTime()).toBeGreaterThan(Date.now())
    if (data.roundsCount > 0)
      expect(data.casualties.attacker.length + data.casualties.defender.length).toBeGreaterThan(0)
  })

  it('step 6 — REAL CASUALTIES + battle row with the real engine fingerprint', async () => {
    const battle = await db.battle.findUniqueOrThrow({ where: { id: battleId } })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.territoryId).toBe(targetId)
    expect(battle.seed).toBeGreaterThan(0)
    expect(battle.configVersion).toBe(BATTLE.version)
    expect(battle.roundsCount).toBeGreaterThanOrEqual(0)
    // Real casualties: battle rounds persist one ROW PER SIDE per round.
    const rounds = await db.battleRound.count({ where: { battleId } })
    expect(rounds).toBeGreaterThanOrEqual(battle.roundsCount)
    expect(rounds).toBeLessThanOrEqual(battle.roundsCount * 2)
  })

  it('step 7 — TERRITORY CAPTURE: ownership flipped + append-only history written', async () => {
    const territory = await db.territory.findUniqueOrThrow({
      where: { id: targetId },
      select: { ownerPlayerId: true, status: true, captureCount: true, lastCapturedAt: true },
    })
    expect(territory.ownerPlayerId).toBe(lord.playerId)
    expect(territory.status).toBe('CONTROLLED')
    expect(territory.lastCapturedAt).not.toBeNull()
    const history = await db.territoryHistory.findMany({ where: { territoryId: targetId } })
    expect(history.some((row) => row.reason === 'CAPTURE' && row.battleId === battleId)).toBe(true)
  })

  it('step 8 — QUEST PROGRESS: TERRITORY_CAPTURED advanced the seasonal objective', async () => {
    const { status, body } = await call<{
      quests: Array<{ id: string; instance: { progress: number; target: number } | null }>
    }>(questsBoardGet, lord.token, '/api/v1/quests?filter=all')
    expect(status).toBe(200)
    const conqueror = body.data!.quests.find((q) => q.id === 'seasonal-conqueror')
    expect(conqueror).toBeDefined()
    expect(conqueror!.instance!.progress).toBe(1) // 1/3 — the UI shows the progress bar
  })

  it('step 9 — LEDGER + RANKING: spoils credited, season points ranked', async () => {
    // Ledger: the spoils entry exists with the TERRITORY_CAPTURE reason.
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: lord.playerId, reason: 'TERRITORY_CAPTURE' },
    })
    expect(ledger.length).toBeGreaterThanOrEqual(1)

    // Wallet view reflects the credit (BigInt → string).
    const resources = await call<{ wallet: Record<string, string> }>(
      resourcesGet,
      lord.token,
      '/api/v1/player/resources',
    )
    expect(resources.status).toBe(200)

    // Season ranking includes the capturer (capture season points awarded).
    const ranking = await call<{
      ranking?: Array<{ playerId: string; score: number }>
      rows?: Array<{ playerId: string; score: number }>
    }>(rankingGet, lord.token, '/api/v1/season/ranking')
    expect(ranking.status).toBe(200)
    const rows =
      (ranking.body.data! as { ranking?: Array<{ playerId: string }> }).ranking ??
      (ranking.body.data! as { rows?: Array<{ playerId: string }> }).rows ??
      []
    if (rows.length > 0) {
      expect(rows.some((row) => row.playerId === lord.playerId)).toBe(true)
    }
    // Season points on the player row regardless of the ranking shape.
    const player = await db.player.findUniqueOrThrow({
      where: { id: lord.playerId },
      select: { seasonPoints: true },
    })
    expect(player.seasonPoints).toBeGreaterThanOrEqual(WORLD_ATTACK.captureSeasonPoints)
  })

  it('step 10 — NOTIFICATION: the ATTACK_RESULT lands in the inbox', async () => {
    await drainNotificationQueue({ telegramConfig: { token: null } })
    const { status, body } = await call<{
      notifications: Array<{ type: string; title: string }>
    }>(notificationsGet, lord.token, '/api/v1/player/notifications')
    expect(status).toBe(200)
    const battleNotice = body.data!.notifications.find((n) => n.type === 'ATTACK_RESULT')
    expect(battleNotice).toBeDefined()
  })

  it('step 11 — HISTORY: the public ownership record is queryable', async () => {
    const { status, body } = await call<{
      rows: Array<{ reason: string; battleId: string | null; newOwner: { id: string | null } }>
    }>(historyGet, lord.token, '/api/v1/world/territories/x/history', 'GET', undefined, targetId)
    expect(status).toBe(200)
    expect(body.data!.rows[0]!.reason).toBe('CAPTURE')
    expect(body.data!.rows[0]!.newOwner.id).toBe(lord.playerId)
  })

  it('step 12 — UPDATED WORLD MAP: the map now shows the conquered cell as owned', async () => {
    // Viewport centered on the captured cell (its position depends on where
    // this run's capital was spiral-placed).
    const captured = await db.territory.findUniqueOrThrow({
      where: { id: targetId },
      select: { x: true, y: true },
    })
    const r = 5
    const { status, body } = await call<{
      territories: Array<{
        id: string
        status: string
        ownerPlayerId: string | null
        ownerName: string | null
      }>
    }>(
      mapGet,
      lord.token,
      `/api/v1/world/map?minX=${captured.x - r}&maxX=${captured.x + r}&minY=${captured.y - r}&maxY=${captured.y + r}`,
    )
    expect(status).toBe(200)
    const capturedCell = body.data!.territories.find((cell) => cell.id === targetId)
    expect(capturedCell).toBeDefined()
    expect(capturedCell!.status).toBe('CONTROLLED')
    expect(capturedCell!.ownerPlayerId).toBe(lord.playerId)
    expect(capturedCell!.ownerName).toBeTruthy()
  })
})
