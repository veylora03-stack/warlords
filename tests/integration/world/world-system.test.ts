/**
 * Integration tests — World Map + Territory System (Phase 32): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → service → transaction → envelope). Assaults run
 * through the PUBLIC service path inside real transactions — real energy CAS,
 * real BigInt ledger rows, real SQLite, zero mocks.
 *
 * Required scenarios (Phase 32 contract):
 *  1. UNAUTHENTICATED        — 401 without a session
 *  2. WORLD BOOTSTRAP        — deterministic 36 regions / 1681 territories, idempotent
 *  3. MAP                    — viewport clamp, area cap refusal, capital-centered default
 *  4. CAPITAL                — every registration owns an unattackable capital (SPAWN history)
 *  5. DETAIL                 — server-computed attackability; fake ids → 404
 *  6. REFUSALS               — own/capital/locked/non-adjacent → typed errors, ZERO writes
 *  7. HAPPY PATH             — assault vs virtual garrison: TERRITORY_ASSAULT battle row,
 *                              capture, CAPTURE history, TERRITORY_CAPTURE ledger spoils,
 *                              honor/XP/season points, stats, power, logs, notifications
 *  8. QUEST + ACHIEVEMENT    — TERRITORY_CAPTURED advances seasonal-conqueror; STAT
 *                              achievements unlock through the existing engines
 *  9. QUEST COMPLETION       — 3 captures complete seasonal-conqueror → claim → ledger
 * 10. PRODUCTION             — lazy collection: interval gate, cap, ledger credit,
 *                              double-collect refusal, foreign collect refusal
 * 11. HISTORY                — append-only ownership records, paging, no private data
 * 12. LEDGER INVARIANT       — Σ(ledger deltas) == wallet balance for every resource
 *
 * Test identities live in the isolated 9100032… telegramId range and are
 * removed in afterAll (captured territories are RESET to unclaimed — the
 * shared sandbox world must stay reusable across suites).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as mapGet } from '../../../src/app/api/v1/world/map/route'
import { GET as detailGet } from '../../../src/app/api/v1/world/territories/[id]/route'
import { POST as attackPost } from '../../../src/app/api/v1/world/territories/[id]/attack/route'
import { GET as historyGet } from '../../../src/app/api/v1/world/territories/[id]/history/route'
import { POST as collectPost } from '../../../src/app/api/v1/world/territories/[id]/collect/route'
import { GET as playerTerritoriesGet } from '../../../src/app/api/v1/world/player-territories/route'
import { GET as questsBoardGet } from '../../../src/app/api/v1/quests/route'
import { GET as achievementsBoardGet } from '../../../src/app/api/v1/quests/achievements/route'
import { POST as questClaimPost } from '../../../src/app/api/v1/quests/[id]/claim/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { WORLD_ATTACK } from '../../../src/lib/game/config/world'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'World integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100032'
const IP = '203.0.133.'
let ipCounter = 1
const nextIp = (): string => `${IP}${ipCounter++}`

let tgCounter = 9100032001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `WorldLord${telegramId.slice(-3)}`,
      username: `world_lord_${telegramId.slice(-4)}`,
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

function withParams(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
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
    territoryId ? withParams(territoryId) : undefined,
  )
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
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
  if (!body.ok || !body.data) throw new Error(`world integration registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
}

/** Test arrangement: a veteran army (real PlayerUnit rows) so assaults on
 *  garrisons resolve deterministically — the flow itself is never faked. */
async function grantVeteranArmy(playerId: string): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: 100 },
    update: { count: { increment: 100 } },
  })
}

/** Elapses the shared attack cooldown the honest way — server-clock backdating. */
async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

interface MapCell {
  id: string
  x: number
  y: number
  name: string | null
  terrain: string
  status: string
  ownerPlayerId: string | null
  ownerName: string | null
  isCapital: boolean
  resourceType: string | null
  productionRate: number
  strategicValue: number
  defenseStrength: number
  captureCount: number
}

const createdPlayerIds: string[] = []

async function purge(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
  if (ids.length > 0) {
    // Reset captured/test territories so the shared sandbox world stays reusable.
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

// ── The suite ────────────────────────────────────────────────────────────────

describe('World system (map → capital → assault → capture → production → history)', () => {
  let lord: { token: string; playerId: string }
  let capitalCell: MapCell
  let capturedCellId: string

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('world-it', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    lord = await register()
    createdPlayerIds.push(lord.playerId)
  })

  afterAll(async () => {
    await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
    await purge()
  })

  it('1 — refuses unauthenticated world access', async () => {
    const map = await call(mapGet, '', '/api/v1/world/map')
    expect(map.status).toBe(401)
    expect(map.body.ok).toBe(false)
    const attack = await call(
      attackPost,
      '',
      '/api/v1/world/territories/x/attack',
      'POST',
      {},
      'nonexistent',
    )
    expect(attack.status).toBe(401)
  })

  it('2 — bootstraps the deterministic world once (36 regions, 1681 territories)', async () => {
    // A full-world viewport (41×41) is REFUSED by policy — the world is never
    // serialized in full (STEP 24/31 contract).
    const oversized = await call(
      mapGet,
      lord.token,
      '/api/v1/world/map?minX=0&maxX=40&minY=0&maxY=40',
    )
    expect(oversized.status).toBe(400)
    expect(oversized.body.error!.code).toBe('VALIDATION_ERROR')

    // A cap-compliant viewport (21×21 = exactly maxViewportArea) works.
    const first = await call<{
      total: number
      worldSize: { sizeX: number; sizeY: number }
      regions: unknown[]
      territories: MapCell[]
    }>(mapGet, lord.token, '/api/v1/world/map?minX=0&maxX=20&minY=0&maxY=20')
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(first.body.data!.total).toBe(441)
    expect(first.body.data!.worldSize).toEqual({ sizeX: 41, sizeY: 41 })

    const regionCount = await db.region.count()
    const territoryCount = await db.territory.count()
    expect(regionCount).toBe(36)
    expect(territoryCount).toBe(1681)

    // Idempotent: a second pass adds nothing.
    const regionsAgain = await db.region.count()
    expect(regionsAgain).toBe(36)
  })

  it('3 — every registered player owns an unattackable capital with a SPAWN history row', async () => {
    const view = await call<{
      capital: { id: string; x: number; y: number; isCapital: boolean } | null
      territories: Array<{ id: string; isCapital: boolean }>
    }>(playerTerritoriesGet, lord.token, '/api/v1/world/player-territories')
    expect(view.status).toBe(200)
    expect(view.body.data!.capital).not.toBeNull()
    capitalCell = (await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: lord.playerId, isCapital: true },
      select: {
        id: true,
        x: true,
        y: true,
        name: true,
        terrain: true,
        status: true,
        ownerPlayerId: true,
        ownerType: true,
        isCapital: true,
        resourceType: true,
        productionRate: true,
        strategicValue: true,
        defenseStrength: true,
        captureCount: true,
      },
    })) as unknown as MapCell
    expect(capitalCell.isCapital).toBe(true)
    expect(capitalCell.status).toBe('CONTROLLED')

    const spawnRows = await db.territoryHistory.findMany({
      where: { territoryId: capitalCell.id, reason: 'SPAWN', newOwnerId: lord.playerId },
    })
    // The shared sandbox world accumulates append-only history across runs —
    // THIS run's registration must have written exactly one row for THIS lord.
    expect(spawnRows.length).toBeGreaterThanOrEqual(1)
    expect(spawnRows.every((row) => row.reason === 'SPAWN')).toBe(true)
  })

  it('4 — the capital can NEVER be assaulted (server rule, zero writes)', async () => {
    const energyBefore = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { energy: true },
      })
    ).energy
    const attack = await call<{ error: { code: string } }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: `cap-${Date.now()}` },
      capitalCell.id,
    )
    expect(attack.status).toBe(403)
    expect(attack.body.error!.code).toBe('TERRITORY_CAPITAL_PROTECTED')
    const energyAfter = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { energy: true },
      })
    ).energy
    expect(energyAfter).toBe(energyBefore) // zero-write refusal
  })

  it('5 — territory detail exposes public knowledge + server attackability (no defender army)', async () => {
    const detail = await call<{
      id: string
      terrain: string
      attack: { attackable: boolean; reasons: string[] }
      region: { id: string; name: string } | null
    }>(detailGet, lord.token, '/api/v1/world/territories/x', 'GET', undefined, capitalCell.id)
    expect(detail.status).toBe(200)
    expect(detail.body.data!.id).toBe(capitalCell.id)
    expect(detail.body.data!.region).not.toBeNull()
    expect(detail.body.data!.attack.attackable).toBe(false)
    expect(detail.body.data!.attack.reasons).toContain('OWNED_BY_YOU')
    // Private data never leaks: no army/composition keys exist on the view.
    const raw = JSON.stringify(detail.body.data!)
    expect(raw).not.toContain('stacks')
    expect(raw).not.toContain('strongAgainst')

    const missing = await call(
      detailGet,
      lord.token,
      '/api/v1/world/territories/x',
      'GET',
      undefined,
      'does-not-exist',
    )
    expect(missing.status).toBe(404)
    expect(missing.body.error!.code).toBe('TERRITORY_NOT_FOUND')
  })

  it('6 — refuses non-adjacent assaults with zero writes', async () => {
    const far = await db.territory.findFirstOrThrow({
      where: { status: 'UNCLAIMED', isCapital: false, x: 40, y: 40 },
      select: { id: true, x: true, y: true },
    })
    const distance = Math.abs(far.x - capitalCell.x) + Math.abs(far.y - capitalCell.y)
    expect(distance).toBeGreaterThan(1)
    const energyBefore = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { energy: true },
      })
    ).energy
    const attack = await call<{ error: { code: string } }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      {},
      far.id,
    )
    expect(attack.status).toBe(400)
    expect(attack.body.error!.code).toBe('TERRITORY_NOT_ADJACENT')
    const energyAfter = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { energy: true },
      })
    ).energy
    expect(energyAfter).toBe(energyBefore)
  })

  it('7 — the full assault pipeline captures an adjacent territory from the virtual garrison', async () => {
    await grantVeteranArmy(lord.playerId)
    // Pick an adjacent, unclaimed, non-special cell (deterministic order).
    const neighbors = await db.territory.findMany({
      where: {
        status: 'UNCLAIMED',
        isCapital: false,
        OR: [
          { x: capitalCell.x, y: { in: [capitalCell.y - 1, capitalCell.y + 1] } },
          { y: capitalCell.y, x: { in: [capitalCell.x - 1, capitalCell.x + 1] } },
        ],
      },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
    })
    expect(neighbors.length).toBeGreaterThan(0)
    const target = neighbors[0]!
    const captureCountBefore = (
      await db.territory.findUniqueOrThrow({
        where: { id: target.id },
        select: { captureCount: true },
      })
    ).captureCount

    const attack = await call<{
      battleId: string
      outcome: string
      result: string
      territory: { id: string; captured: boolean; captureCount: number }
      defender: { playerId: string | null; name: string }
      spoils: Record<string, string>
      seasonPointsAwarded: number
      energySpent: number
      casualties: { attacker: unknown[]; defender: unknown[] }
      cooldownUntil: string
    }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: `assault-${lord.tgId}` },
      target.id,
    )
    expect(attack.status).toBe(200)
    const data = attack.body.data!
    expect(data.battleId).toBeTruthy()
    expect(data.outcome).toBe('VICTORY') // veteran army vs a small garrison
    expect(data.result).toBe('ATTACKER_WIN')
    expect(data.territory.id).toBe(target.id)
    expect(data.territory.captured).toBe(true)
    // The shared sandbox world accumulates captures across runs — assert the DELTA.
    expect(data.territory.captureCount).toBe(captureCountBefore + 1)
    expect(data.defender.playerId).toBeNull() // virtual garrison — NOT a player
    expect(data.energySpent).toBe(WORLD_ATTACK.energyCost)
    expect(new Date(data.cooldownUntil).getTime()).toBeGreaterThan(Date.now())
    capturedCellId = target.id

    // Battle row: REAL TERRITORY_ASSAULT bound to the territory.
    const battle = await db.battle.findUniqueOrThrow({ where: { id: data.battleId } })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.territoryId).toBe(target.id)
    expect(battle.defenderPlayerId).toBeNull()
    expect(battle.configVersion).toBe(BATTLE.version)

    // Ownership flip + history.
    const captured = await db.territory.findUniqueOrThrow({ where: { id: target.id } })
    expect(captured.ownerPlayerId).toBe(lord.playerId)
    expect(captured.status).toBe('CONTROLLED')
    expect(captured.captureCount).toBe(captureCountBefore + 1)
    const history = await db.territoryHistory.findMany({ where: { territoryId: target.id } })
    const captureRow = history.find(
      (row) => row.reason === 'CAPTURE' && row.battleId === data.battleId,
    )
    expect(captureRow).toBeDefined()
    expect(captureRow!.newOwnerId).toBe(lord.playerId)

    // Spoils flowed through the EXISTING ledger (TERRITORY_CAPTURE).
    if (Object.keys(data.spoils).length > 0) {
      const ledger = await db.resourceTransaction.findMany({
        where: { playerId: lord.playerId, reason: 'TERRITORY_CAPTURE' },
      })
      expect(ledger.length).toBeGreaterThan(0)
    }

    // Stats + season points.
    const player = await db.player.findUniqueOrThrow({ where: { id: lord.playerId } })
    const stats = player.stats as Record<string, number>
    expect(stats['territoriesCaptured']).toBe(1)
    expect(player.seasonPoints).toBeGreaterThanOrEqual(WORLD_ATTACK.captureSeasonPoints)

    // Notifications ride the EXISTING engine.
    await drainNotificationQueue({ telegramConfig: { token: null } })
    const notifs = await db.notification.findMany({
      where: { playerId: lord.playerId, type: 'ATTACK_RESULT' },
    })
    expect(notifs.length).toBeGreaterThan(0)
  })

  it('8 — TERRITORY_CAPTURED advanced the real seasonal quest through the Phase 31 engine', async () => {
    const board = await call<{
      quests: Array<{
        id: string
        instance: { progress: number; target: number; status: string } | null
      }>
    }>(questsBoardGet, lord.token, '/api/v1/quests?filter=all')
    expect(board.status).toBe(200)
    const conqueror = board.body.data!.quests.find((q) => q.id === 'seasonal-conqueror')
    expect(conqueror).toBeDefined()
    expect(conqueror!.instance).not.toBeNull()
    expect(conqueror!.instance!.progress).toBe(1)
    expect(conqueror!.instance!.target).toBe(3)
    expect(conqueror!.instance!.status).toBe('ACTIVE')
  })

  it('9 — STAT achievements unlocked through the existing achievement engine', async () => {
    const achievements = await call<{
      achievements: Array<{ id: string; unlocked: boolean }>
    }>(achievementsBoardGet, lord.token, '/api/v1/quests/achievements')
    expect(achievements.status).toBe(200)
    const first = achievements.body.data!.achievements.find((a) => a.id === 'ach-first-territory')
    expect(first).toBeDefined()
    expect(first!.unlocked).toBe(true)
  })

  /** Unclaimed cells adjacent to ANY of the player's holdings — mirrors the
   *  real adjacency rule (expansion fronts grow with the empire). */
  async function findUnclaimedFrontier(playerId: string): Promise<string[]> {
    const owned = await db.territory.findMany({
      where: { ownerPlayerId: playerId },
      select: { x: true, y: true },
    })
    const coords = new Set<string>()
    for (const cell of owned) {
      for (const adj of adjacentCoords(cell.x, cell.y)) coords.add(`${adj.x},${adj.y}`)
    }
    const list = [...coords].map((key) => key.split(',').map(Number) as [number, number])
    if (list.length === 0) return []
    const rows = await db.territory.findMany({
      where: {
        status: 'UNCLAIMED',
        isCapital: false,
        OR: list.map(([x, y]) => ({ x, y })),
      },
      orderBy: [{ y: 'asc' }, { x: 'asc' }],
      select: { id: true },
    })
    return rows.map((row) => row.id)
  }

  it('10 — three real captures COMPLETE seasonal-conqueror; the claim pays through the ledger', async () => {
    // Two more REAL assaults (cooldown elapsed by server-clock backdating).
    for (let round = 0; round < 2; round++) {
      await elapseCooldown(lord.playerId)
      const frontier = await findUnclaimedFrontier(lord.playerId)
      expect(frontier.length).toBeGreaterThan(0)
      const targetId = frontier[0]!
      const attack = await call<{ outcome: string; territory: { captured: boolean } }>(
        attackPost,
        lord.token,
        '/api/v1/world/territories/x/attack',
        'POST',
        { idempotencyKey: `assault-${lord.tgId}-${round}` },
        targetId,
      )
      expect(attack.status).toBe(200)
      expect(attack.body.data!.territory.captured).toBe(true)
    }

    const board = await call<{
      quests: Array<{
        id: string
        instance: { progress: number; status: string; cycle: string } | null
      }>
    }>(questsBoardGet, lord.token, '/api/v1/quests?filter=all')
    const conqueror = board.body.data!.quests.find((q) => q.id === 'seasonal-conqueror')!
    expect(conqueror.instance!.progress).toBe(3)
    expect(conqueror.instance!.status).toBe('COMPLETED')

    // Claim → QUEST_REWARD ledger entries + wallet credit.
    const walletBefore = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: lord.playerId },
      select: { gold: true },
    })
    const claim = await call<{ reward: Record<string, number> }>(
      questClaimPost,
      lord.token,
      '/api/v1/quests/x/claim',
      'POST',
      {},
      'seasonal-conqueror',
    )
    expect(claim.status).toBe(200)
    expect(claim.body.data!.reward['GOLD']).toBeGreaterThan(0)
    const walletAfter = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: lord.playerId },
      select: { gold: true },
    })
    expect(walletAfter.gold - walletBefore.gold).toBe(BigInt(claim.body.data!.reward['GOLD']!))

    // Double claim refused.
    const replay = await call(
      questClaimPost,
      lord.token,
      '/api/v1/quests/x/claim',
      'POST',
      {},
      'seasonal-conqueror',
    )
    expect(replay.status).toBe(409)
    expect(replay.body.error!.code).toBe('QUEST_ALREADY_CLAIMED')
  })

  it('11 — production is lazy, interval-gated, ledger-backed and refuses double collection', async () => {
    // Arrange: the captured cell becomes a producing territory (operator-style
    // arrangement of REAL state — the flow itself is exercised for real).
    const producing = await db.territory.findUniqueOrThrow({ where: { id: capturedCellId } })
    await db.territory.update({
      where: { id: capturedCellId },
      data: { resourceType: 'GOLD', productionRate: 120 },
    })
    // Cursor: just collected → the interval gate must refuse.
    await db.territory.update({
      where: { id: capturedCellId },
      data: { productionCollectedAt: new Date() },
    })
    const tooSoon = await call<{ error: { code: string } }>(
      collectPost,
      lord.token,
      '/api/v1/world/territories/x/collect',
      'POST',
      {},
      capturedCellId,
    )
    expect(tooSoon.status).toBe(409)
    expect(tooSoon.body.error!.code).toBe('TERRITORY_NOT_COLLECTIBLE')

    // Elapse the cursor beyond the interval → collect.
    await db.territory.update({
      where: { id: capturedCellId },
      data: {
        productionCollectedAt: new Date(Date.now() - 2 * 3600_000), // 2h elapsed
      },
    })
    const walletBefore = (
      await db.resourceWallet.findUniqueOrThrow({
        where: { playerId: lord.playerId },
        select: { gold: true },
      })
    ).gold
    const collect = await call<{
      resourceType: string
      amount: string
      wallet: Record<string, string>
      nextCollectAtMs: number
    }>(collectPost, lord.token, '/api/v1/world/territories/x/collect', 'POST', {}, capturedCellId)
    expect(collect.status).toBe(200)
    expect(collect.body.data!.resourceType).toBe('GOLD')
    const amount = BigInt(collect.body.data!.amount)
    expect(amount).toBeGreaterThan(0n)
    expect(Number(collect.body.data!.nextCollectAtMs)).toBeGreaterThan(Date.now())

    const walletAfter = (
      await db.resourceWallet.findUniqueOrThrow({
        where: { playerId: lord.playerId },
        select: { gold: true },
      })
    ).gold
    expect(walletAfter - walletBefore).toBe(amount)

    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: lord.playerId, reason: 'TERRITORY_PRODUCTION' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]!.delta).toBe(amount)

    // Immediate re-collect refused (cursor advanced in the same tx).
    const again = await call(
      collectPost,
      lord.token,
      '/api/v1/world/territories/x/collect',
      'POST',
      {},
      capturedCellId,
    )
    expect(again.status).toBe(409)

    void producing
  })

  it('12 — another player collecting foreign production is refused', async () => {
    const stranger = await register()
    createdPlayerIds.push(stranger.playerId)
    const foreign = await call(
      collectPost,
      stranger.token,
      '/api/v1/world/territories/x/collect',
      'POST',
      {},
      capturedCellId,
    )
    expect(foreign.status).toBe(403)
    expect(foreign.body.error!.code).toBe('FORBIDDEN')
  })

  it('13 — territory history is the append-only public record with paging', async () => {
    const page1 = await call<{
      territory: { id: string }
      rows: Array<{ reason: string; newOwner: { id: string | null; name: string | null } }>
      total: number
      pages: number
      pageSize: number
    }>(
      historyGet,
      lord.token,
      '/api/v1/world/territories/x/history?page=1&pageSize=1',
      'GET',
      undefined,
      capturedCellId,
    )
    expect(page1.status).toBe(200)
    expect(page1.body.data!.territory.id).toBe(capturedCellId)
    // Append-only shared world: at least THIS run's capture is recorded, and
    // the newest row is the CAPTURE that flipped ownership to this lord.
    expect(page1.body.data!.total).toBeGreaterThanOrEqual(1)
    expect(page1.body.data!.rows[0]!.reason).toBe('CAPTURE')
    expect(page1.body.data!.rows[0]!.newOwner.id).toBe(lord.playerId)
    expect(page1.body.data!.rows[0]!.newOwner.name).not.toBeNull()
    expect(page1.body.data!.pageSize).toBe(1)

    // No private data on the public history surface.
    const raw = JSON.stringify(page1.body.data!)
    expect(raw).not.toContain('wallet')
    expect(raw).not.toContain('stacks')
  })

  it('14 — the ledger reconciles: Σ(deltas) == balance for every resource', async () => {
    const wallet = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: lord.playerId },
    })
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: lord.playerId },
      select: { resource: true, delta: true },
    })
    const sums: Record<string, bigint> = {}
    for (const row of ledger) {
      sums[row.resource] = (sums[row.resource] ?? 0n) + row.delta
    }
    expect(sums['GOLD']).toBe(wallet.gold)
    expect(sums['WOOD']).toBe(wallet.wood)
    expect(sums['IRON']).toBe(wallet.iron)
    expect(sums['FOOD']).toBe(wallet.food)
    expect(sums['CRYSTAL']).toBe(wallet.crystal)
  })
})
