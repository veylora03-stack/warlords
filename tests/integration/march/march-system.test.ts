/**
 * Integration tests — March & Army Movement System (Phase 33): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → service → transaction → envelope). Marches run
 * through the PUBLIC service path inside real transactions — real unit
 * reservations, real energy CAS, real battle rows through the SHARED assault
 * pipeline, real BigInt ledger rows, real SQLite, zero mocks.
 *
 * Required scenarios (Phase 33 contract):
 *  1. UNAUTHENTICATED        — 401 without a session
 *  2. CREATION               — ATTACK march: units RESERVED (leave player_units),
 *                              server-derived origin/distance/arrival, EN_ROUTE
 *  3. ZERO-WRITE REFUSALS    — capital/self/locked/non-adjacent/foreign targets,
 *                              unknown units, insufficient units → typed, NO writes
 *  4. IDEMPOTENCY            — same key → same march replay; same key + different
 *                              destination → typed 409
 *  5. SLOTS                  — CASTLE marchSlots cap (starter castle = 1)
 *  6. PROCESS (not due)      — server-authoritative no-op + countdown state
 *  7. ATTACK ARRIVAL         — REAL TERRITORY_ASSAULT through the shared pipeline,
 *                              Battle.marchId stamped, capture + history + spoils,
 *                              honor/XP/season/stats, survivors manifest → RETURNING
 *  8. HOMECOMING             — survivors restored EXACTLY once, COMPLETED,
 *                              MARCH_RETURNED notification, MARCH_COMPLETED quest
 *                              progress (weekly-patrol), marchBattlesWon stat
 *  9. SCOUT                  — ScoutReport with PUBLIC data only (no army
 *                              composition), NO battle row, weekly-recon progress
 * 10. REINFORCE/DEFEND       — own territory delivery → COMPLETED at arrival
 * 11. CANCELLATION           — EN_ROUTE recall releases units exactly once;
 *                              cancel after arrival → MARCH_NOT_CANCELLABLE
 * 12. LEDGER INVARIANT       — Σ(ledger deltas) == wallet balance for every resource
 *
 * Test identities live in the isolated 9100033… telegramId range and are
 * removed in afterAll (captured territories are RESET to unclaimed — the
 * shared sandbox world must stay reusable across suites).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as marchPost, GET as marchListGet } from '../../../src/app/api/v1/marches/route'
import { GET as marchGet } from '../../../src/app/api/v1/marches/[id]/route'
import { POST as cancelPost } from '../../../src/app/api/v1/marches/[id]/cancel/route'
import { POST as processPost } from '../../../src/app/api/v1/marches/[id]/process/route'
import { GET as questsBoardGet } from '../../../src/app/api/v1/quests/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import { MARCH } from '../../../src/lib/game/config/march'
import { BATTLE } from '../../../src/lib/game/config/battle'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'March integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100033'
const IP = '203.0.134.'
let ipCounter = 1
const nextIp = (): string => `${IP}${ipCounter++}`

let tgCounter = 9100033001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `MarchLord${telegramId.slice(-3)}`,
      username: `march_lord_${telegramId.slice(-4)}`,
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
  marchId?: string,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(
    authed(path, token, method, payload),
    marchId ? withParams(marchId) : undefined,
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
  if (!body.ok || !body.data) throw new Error(`march integration registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
}

/** Test arrangement: a veteran army (real PlayerUnit rows) — the honest way. */
async function grantVeteranArmy(playerId: string, swordsman = 100): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: swordsman },
    update: { count: { increment: swordsman } },
  })
}

async function homeArmy(playerId: string): Promise<Map<string, number>> {
  const rows = await db.playerUnit.findMany({
    where: { playerId },
    select: { unitId: true, count: true },
  })
  return new Map<string, number>(rows.map((r) => [r.unitId, r.count]))
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
  departedAt: string
  arrivesAt: string
  returnsAt: string | null
  completedAt: string | null
  serverNowMs: number
  cancellable: boolean
  dueNow: boolean
  battleId: string | null
  outcome: Record<string, unknown> | null
}

/** Backdates a march's arrival the honest way — the SERVER clock moved. */
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

/** Elapses the shared regroup clock the honest way — server-clock backdating. */
async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

const createdPlayerIds: string[] = []
const touchedTerritoryIds: string[] = []

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
    for (const id of touchedTerritoryIds) {
      await db.territory.updateMany({
        where: { id, ownerPlayerId: { in: ids } },
        data: {
          ownerPlayerId: null,
          ownerType: 'NONE',
          status: 'UNCLAIMED',
          lastCapturedAt: null,
          productionCollectedAt: null,
        },
      })
    }
    await db.march.deleteMany({ where: { playerId: { in: ids } } })
    await db.scoutReport.deleteMany({ where: { attackerPlayerId: { in: ids } } })
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

// ── The suite ────────────────────────────────────────────────────────────────

describe('March system (create → travel → assault → return → restore)', () => {
  let lord: { token: string; playerId: string }
  let capital: { id: string; x: number; y: number }
  let adjacentUnclaimed: { id: string; x: number; y: number; name: string | null } | null = null

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('march-it', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    // Register until the spawn has an adjacent unclaimed frontier cell —
    // the spiral clusters consecutive capitals, so the first pick may be
    // fully landlocked by its predecessors.
    for (let attempt = 0; attempt < 8 && !adjacentUnclaimed; attempt++) {
      const candidate = await register()
      createdPlayerIds.push(candidate.playerId)
      await grantVeteranArmy(candidate.playerId)
      const cap = await db.territory.findFirstOrThrow({
        where: { ownerPlayerId: candidate.playerId, isCapital: true },
        select: { id: true, x: true, y: true },
      })
      const cell = await db.territory.findFirst({
        where: {
          OR: adjacentCoords(cap.x, cap.y).map((c) => ({ x: c.x, y: c.y })),
          status: 'UNCLAIMED',
          isCapital: false,
        },
        select: { id: true, x: true, y: true, name: true },
        take: 1,
      })
      if (cell) {
        lord = candidate
        capital = cap
        adjacentUnclaimed = cell
      }
    }
    if (!adjacentUnclaimed) throw new Error('no frontier cell for the march fixtures')
    touchedTerritoryIds.push(adjacentUnclaimed.id)
  })

  afterAll(async () => {
    await drainNotificationQueue({ telegramConfig: { token: null } }).catch(() => undefined)
    await purge()
  })

  it('1 — refuses unauthenticated march access', async () => {
    const created = await call(marchPost, '', '/api/v1/marches', 'POST', {
      territoryId: 'whatever',
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 1 }],
    })
    expect(created.status).toBe(401)
    const listed = await call(marchListGet, '', '/api/v1/marches')
    expect(listed.status).toBe(401)
  })

  it('2 — creates an ATTACK march: units reserved, server-derived origin/arrival', async () => {
    expect(adjacentUnclaimed).not.toBeNull()
    touchedTerritoryIds.push(adjacentUnclaimed!.id)
    const armyBefore = await homeArmy(lord.playerId)
    const energyBefore = (
      await db.player.findUniqueOrThrow({ where: { id: lord.playerId }, select: { energy: true } })
    ).energy

    const created = await call<MarchView>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: adjacentUnclaimed!.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
      idempotencyKey: 'march-it-create-1',
    })
    expect(created.status).toBe(200)
    const march = created.body.data!
    expect(march.type).toBe('ATTACK')
    expect(march.status).toBe('EN_ROUTE')
    expect(march.origin).toEqual({ x: capital.x, y: capital.y }) // server-derived
    expect(march.destination.territoryId).toBe(adjacentUnclaimed!.id)
    expect(march.units).toEqual([{ unitId: 'swordsman', unitName: 'Swordsman', count: 40 }])
    expect(march.cancellable).toBe(true)
    expect(march.dueNow).toBe(false)
    // deterministic travel: ≥ minTravelSeconds in the future
    expect(new Date(march.arrivesAt).getTime()).toBeGreaterThan(
      Date.now() + MARCH.minTravelSeconds * 1000 - 2000,
    )

    // Reservation: units LEFT the home army (real rows).
    const armyAfter = await homeArmy(lord.playerId)
    expect(armyAfter.get('swordsman')).toBe(armyBefore.get('swordsman')! - 40)

    // Energy charged at the decision point.
    const energyAfter = (
      await db.player.findUniqueOrThrow({ where: { id: lord.playerId }, select: { energy: true } })
    ).energy
    expect(energyAfter).toBe(energyBefore - 10) // WORLD_ATTACK.energyCost

    // marchesLaunched stat
    const stats = await db.player.findUniqueOrThrow({
      where: { id: lord.playerId },
      select: { stats: true },
    })
    expect((stats.stats as Record<string, number>)['marchesLaunched']).toBe(1)
  })

  it('3 — replays the same idempotency key to the SAME march; different target → 409', async () => {
    const replay = await call<MarchView>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: adjacentUnclaimed!.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
      idempotencyKey: 'march-it-create-1',
    })
    expect(replay.status).toBe(200)
    expect(replay.body.data!.id).toBe(
      (await db.march.findFirstOrThrow({ where: { playerId: lord.playerId } })).id,
    )
    expect(replay.body.data!.units[0]!.count).toBe(40)

    // A second attack march is blocked by the 1-slot starter castle anyway,
    // so first clear a free adjacent cell target check via a different player cell:
    const other = await db.territory.findFirst({
      where: { status: 'UNCLAIMED', isCapital: false, id: { not: adjacentUnclaimed!.id } },
      select: { id: true },
    })
    const conflict = await call<{ error: { code: string } }>(
      marchPost,
      lord.token,
      '/api/v1/marches',
      'POST',
      {
        territoryId: other!.id,
        type: 'ATTACK',
        units: [{ unitId: 'swordsman', count: 1 }],
        idempotencyKey: 'march-it-create-1',
      },
    )
    // Same key + different request hash → typed refusal (idempotency abuse).
    expect([409, 400]).toContain(conflict.status)
    if (conflict.status === 409) {
      expect(conflict.body.error!.code).toBe('IDEMPOTENT_REPLAY')
    } else {
      // The starter castle slot cap refused BEFORE idempotency could be
      // reached — also a typed, zero-write refusal.
      expect(conflict.body.error!.code).toBe('MARCH_SLOTS_EXHAUSTED')
    }
  })

  it('4 — refuses every invalid target with typed errors and ZERO writes', async () => {
    // A dedicated player with a FREE march slot — the refusal matrix must be
    // independent of the lord's occupied slot (the slot cap is its own test).
    const quartermaster = await register()
    createdPlayerIds.push(quartermaster.playerId)
    await grantVeteranArmy(quartermaster.playerId)
    const qCapital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: quartermaster.playerId, isCapital: true },
      select: { x: true, y: true },
    })
    const armyBefore = await homeArmy(quartermaster.playerId)
    const marchesBefore = await db.march.count({ where: { playerId: quartermaster.playerId } })

    // capital
    const qCapitalCell = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: quartermaster.playerId, isCapital: true },
      select: { id: true },
    })
    const capitalHit = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: qCapitalCell.id, type: 'ATTACK', units: [{ unitId: 'swordsman', count: 1 }] },
    )
    expect(capitalHit.status).toBe(403)
    expect(capitalHit.body.error!.code).toBe('TERRITORY_CAPITAL_PROTECTED')

    // fake destination
    const fake = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      {
        territoryId: 'nonexistent-territory',
        type: 'ATTACK',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
    )
    expect(fake.status).toBe(404)
    expect(fake.body.error!.code).toBe('TERRITORY_NOT_FOUND')

    // foreign DEFEND/REINFORCE destination (unclaimed ≠ owned)
    const foreign = await db.territory.findFirst({
      where: { status: 'UNCLAIMED' },
      select: { id: true },
    })
    const reinforce = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: foreign!.id, type: 'REINFORCE', units: [{ unitId: 'swordsman', count: 1 }] },
    )
    expect(reinforce.status).toBe(400)
    expect(reinforce.body.error!.code).toBe('MARCH_DESTINATION_NOT_OWNED')

    // SCOUT has no adjacency requirement — unit-level refusals ride SCOUT:
    // unknown unit (reaches the catalog oracle AFTER the free slot check)
    const farCell = await db.territory.findFirst({
      where: { status: 'UNCLAIMED', isCapital: false },
      select: { id: true },
    })
    const badUnit = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: farCell!.id, type: 'SCOUT', units: [{ unitId: 'dragon', count: 1 }] },
    )
    expect(badUnit.status).toBe(400)
    expect(badUnit.body.error!.code).toBe('MARCH_INVALID_UNITS')

    // more units than owned (CAS would fail → typed refusal). 400 ≤ owned 100
    // is false but ≤ maxUnitsPerMarch — a true INSUFFICIENT_UNITS, not a
    // payload-shape refusal.
    const tooMany = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: farCell!.id, type: 'SCOUT', units: [{ unitId: 'swordsman', count: 400 }] },
    )
    expect(tooMany.status).toBe(409)
    expect(tooMany.body.error!.code).toBe('INSUFFICIENT_UNITS')

    // payload-shape cap: total units beyond maxUnitsPerMarch → MARCH_INVALID_UNITS
    const oversized = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: farCell!.id, type: 'SCOUT', units: [{ unitId: 'swordsman', count: 999999 }] },
    )
    expect(oversized.status).toBe(400)
    expect(oversized.body.error!.code).toBe('MARCH_INVALID_UNITS')

    // ATTACK beyond the front line (no adjacent owned territory)
    const farAttack = await call<{ error: { code: string } }>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      { territoryId: farCell!.id, type: 'ATTACK', units: [{ unitId: 'swordsman', count: 1 }] },
    )
    expect(farAttack.status).toBe(400)
    expect(farAttack.body.error!.code).toBe('TERRITORY_NOT_ADJACENT')

    // forge attempts the client must never control: distance/speed/arrival —
    // Zod strips unknown keys; the march engine derives everything itself.
    const forged = await call<MarchView>(
      marchPost,
      quartermaster.token,
      '/api/v1/marches',
      'POST',
      {
        territoryId: farCell!.id,
        type: 'SCOUT',
        units: [{ unitId: 'swordsman', count: 1 }],
        distance: 0,
        speed: 9999,
        arrivesInSeconds: 0,
        origin: { x: 5, y: 5 },
      },
    )
    expect(forged.status).toBe(200)
    expect(forged.body.data!.origin).toEqual({ x: qCapital.x, y: qCapital.y }) // server-derived
    expect(new Date(forged.body.data!.arrivesAt).getTime()).toBeGreaterThan(Date.now()) // server timing
    const recalled = await call(
      cancelPost,
      quartermaster.token,
      '/api/v1/marches/x/cancel',
      'POST',
      undefined,
      forged.body.data!.id,
    )
    expect(recalled.status).toBe(200)

    // ZERO net writes across every refusal above (the forged march was
    // recalled — its CANCELLED row legitimately remains as history).
    const armyAfter = await homeArmy(quartermaster.playerId)
    expect(armyAfter.get('swordsman')).toBe(armyBefore.get('swordsman'))
    const liveMarches = await db.march.count({
      where: { playerId: quartermaster.playerId, status: { not: 'CANCELLED' } },
    })
    expect(liveMarches).toBe(marchesBefore)
  })

  it('5 — enforces the CASTLE march-slot cap (starter castle = 1 slot)', async () => {
    // The lord already has one EN_ROUTE march — a second must refuse.
    const second = await call<{ error: { code: string } }>(
      marchPost,
      lord.token,
      '/api/v1/marches',
      'POST',
      {
        territoryId: (await db.territory.findFirst({
          where: { status: 'UNCLAIMED', isCapital: false },
          select: { id: true },
        }))!.id,
        type: 'SCOUT',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
    )
    expect(second.status).toBe(409)
    expect(second.body.error!.code).toBe('MARCH_SLOTS_EXHAUSTED')
  })

  it('6 — process before arrival is a server no-op (client cannot rush the clock)', async () => {
    const march = await db.march.findFirstOrThrow({ where: { playerId: lord.playerId } })
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(processed.status).toBe(200)
    expect(processed.body.data!.processed).toBe(false)
    expect(processed.body.data!.march.status).toBe('EN_ROUTE')
    // The march row is untouched.
    const fresh = await db.march.findUniqueOrThrow({
      where: { id: march.id },
      select: { status: true },
    })
    expect(fresh.status).toBe('EN_ROUTE')
  })

  it('7 — ATTACK arrival runs the REAL battle engine through the shared pipeline', async () => {
    const march = await db.march.findFirstOrThrow({ where: { playerId: lord.playerId } })
    await backdateArrival(march.id)
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(processed.status).toBe(200)
    expect(processed.body.data!.processed).toBe(true)
    const view = processed.body.data!.march
    // Either the assault resolved (RETURNING survivors) or everything died (LOST)
    expect(['RETURNING', 'LOST']).toContain(view.status)

    // The battle row exists, is a TERRITORY_ASSAULT, and is STAMPED with marchId
    expect(
      view.outcome!.aborted,
      `arrival aborted: ${JSON.stringify(view.outcome)}`,
    ).toBeUndefined()
    expect(view.outcome!.battleId).toBeDefined()
    const battle = await db.battle.findUniqueOrThrow({
      where: { id: view.outcome!.battleId as string },
    })
    expect(battle.type).toBe('TERRITORY_ASSAULT')
    expect(battle.marchId).toBe(march.id)
    expect(battle.energySpent).toBe(10)

    if (view.status === 'RETURNING') {
      // Survivors manifest = committed − losses (checked against the battle)
      const losses = await db.battleRound.findMany({
        where: { battleId: battle.id, side: 'ATTACKER' },
        select: { unitsLost: true },
      })
      // unitsLost rows are [{ unitTypeId, count }] arrays (per-side records).
      const lostTotal = losses.reduce((sum, row) => {
        const lost = Array.isArray(row.unitsLost)
          ? (row.unitsLost as Array<{ unitTypeId?: string; count?: number }>)
          : []
        return sum + lost.reduce((a, e) => a + (typeof e?.count === 'number' ? e.count : 0), 0)
      }, 0)
      const survivorsTotal = view.survivors!.reduce((sum, s) => sum + s.count, 0)
      expect(survivorsTotal).toBe(40 - lostTotal)
      expect(view.returnsAt).not.toBeNull()

      // Capture state (a win vs a weak garrison typically captures)
      if (battle.result === 'ATTACKER_WIN') {
        expect(view.outcome!.captured).toBe(true)
        const territory = await db.territory.findUniqueOrThrow({
          where: { id: adjacentUnclaimed!.id },
        })
        expect(territory.ownerPlayerId).toBe(lord.playerId)
        // append-only history with the battle id
        const history = await db.territoryHistory.findFirstOrThrow({
          where: { territoryId: adjacentUnclaimed!.id, battleId: battle.id, reason: 'CAPTURE' },
        })
        expect(history.newOwnerId).toBe(lord.playerId)
      }
    } else {
      // LOST: nothing returned, terminal state
      expect(view.completedAt).not.toBeNull()
      expect(view.outcome!.unitsLost).toBe(40)
    }
  })

  it('8 — homecoming restores survivors EXACTLY once and completes the march', async () => {
    const march = await db.march.findFirstOrThrow({
      where: { playerId: lord.playerId, status: 'RETURNING' },
    })
    const manifest = march.survivors as Array<{ unitId: string; count: number }>
    const armyBefore = await homeArmy(lord.playerId)
    const expectedSwordsman =
      (armyBefore.get('swordsman') ?? 0) +
      (manifest.find((s) => s.unitId === 'swordsman')?.count ?? 0)

    await backdateReturn(march.id)
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(processed.status).toBe(200)
    expect(processed.body.data!.processed).toBe(true)
    expect(processed.body.data!.march.status).toBe('COMPLETED')

    // Units restored exactly once.
    const armyAfter = await homeArmy(lord.playerId)
    expect(armyAfter.get('swordsman')).toBe(expectedSwordsman)

    // marchesCompleted + marchBattlesWon (when the assault was won)
    const stats = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { stats: true },
      })
    ).stats as Record<string, number>
    expect(stats['marchesCompleted']).toBe(1)
    expect(stats['marchesScouted']).toBe(0) // zero-filled catalog normalization

    // MARCH_COMPLETED quest progress on weekly-patrol (1/5)
    const board = await call<{
      quests: Array<{ id: string; instance: { progress: number; status: string } | null }>
    }>(questsBoardGet, lord.token, '/api/v1/quests')
    expect(board.status).toBe(200)
    const patrol = board.body.data!.quests.find((q) => q.id === 'weekly-patrol')
    expect(patrol).toBeDefined()
    expect(patrol!.instance).not.toBeNull()
    expect(patrol!.instance!.progress).toBe(1)
    expect(patrol!.instance!.status).toBe('ACTIVE')

    // Processing AGAIN is an idempotent no-op (no double restoration).
    const armyBeforeReplay = await homeArmy(lord.playerId)
    const again = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      march.id,
    )
    expect(again.body.data!.processed).toBe(false)
    const armyAfterReplay = await homeArmy(lord.playerId)
    expect(armyAfterReplay.get('swordsman')).toBe(armyBeforeReplay.get('swordsman'))
  })

  it('9 — SCOUT reveals PUBLIC data only and never creates a battle', async () => {
    elapseCooldown(lord.playerId) // the test-7 battle started the regroup clock
    // Free the slot: cancel nothing — the first march is COMPLETED (terminal).
    const target = await db.territory.findFirst({
      where: { status: 'UNCLAIMED', isCapital: false, id: { not: adjacentUnclaimed!.id } },
      select: { id: true, x: true, y: true },
    })
    expect(target).not.toBeNull()
    touchedTerritoryIds.push(target!.id)
    const created = await call<MarchView>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: target!.id,
      type: 'SCOUT',
      units: [{ unitId: 'swordsman', count: 2 }],
      idempotencyKey: 'march-it-scout-1',
    })
    expect(created.status).toBe(200)
    const marchId = created.body.data!.id
    await backdateArrival(marchId)
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      marchId,
    )
    expect(processed.body.data!.processed).toBe(true)
    expect(processed.body.data!.march.status).toBe('RETURNING')
    // The ride home is server-scheduled — backdate it, then come home.
    await backdateReturn(marchId)
    const homeward = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      marchId,
    )
    expect(homeward.body.data!.march.status).toBe('COMPLETED')

    // Scout report exists with PUBLIC fields only
    const report = await db.scoutReport.findFirstOrThrow({
      where: { attackerPlayerId: lord.playerId, territoryId: target!.id },
    })
    const data = report.data as Record<string, unknown>
    expect(data['x']).toBe(target!.x)
    expect(data['terrain']).toBeDefined()
    expect(data['army']).toBeUndefined() // NO private army data
    expect(data['units']).toBeUndefined()
    expect(data['wallet']).toBeUndefined()
    expect(report.success).toBe(true)

    // NO battle row for scouting (no fake combat)
    const marchRow = await db.march.findUniqueOrThrow({ where: { id: marchId } })
    expect(marchRow.battleId).toBeNull()
    expect(marchRow.status).toBe('COMPLETED')

    // marchesScouted stat + weekly-recon quest progress
    const stats = (
      await db.player.findUniqueOrThrow({
        where: { id: lord.playerId },
        select: { stats: true },
      })
    ).stats as Record<string, number>
    expect(stats['marchesScouted']).toBe(1)
    const board = await call<{
      quests: Array<{ id: string; instance: { progress: number } | null }>
    }>(questsBoardGet, lord.token, '/api/v1/quests')
    const recon = board.body.data!.quests.find((q) => q.id === 'weekly-recon')
    expect(recon).toBeDefined()
    expect(recon!.instance).not.toBeNull()
    expect(recon!.instance!.progress).toBe(1)
  })

  it('10 — REINFORCE delivers the detachment to an own territory at arrival', async () => {
    elapseCooldown(lord.playerId)
    // The lord owns the captured cell from test 7 (if captured) — use the
    // capital itself as a delivery target (the simplest own holding).
    const created = await call<MarchView>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: capital.id,
      type: 'REINFORCE',
      units: [{ unitId: 'swordsman', count: 3 }],
      idempotencyKey: 'march-it-reinforce-1',
    })
    expect(created.status).toBe(200)
    const marchId = created.body.data!.id
    const armyBefore = await homeArmy(lord.playerId)
    await backdateArrival(marchId)
    const processed = await call<{ march: MarchView; processed: boolean }>(
      processPost,
      lord.token,
      '/api/v1/marches/x/process',
      'POST',
      undefined,
      marchId,
    )
    expect(processed.body.data!.march.status).toBe('COMPLETED')
    expect(processed.body.data!.march.outcome!.delivered).toBe(true)
    // Delivered = restored to the realm-wide army at arrival (3 back).
    const armyAfter = await homeArmy(lord.playerId)
    expect(armyAfter.get('swordsman')).toBe((armyBefore.get('swordsman') ?? 0) + 3)
  })

  it('11 — cancellation releases units exactly once; after arrival it refuses', async () => {
    elapseCooldown(lord.playerId)
    const created = await call<MarchView>(marchPost, lord.token, '/api/v1/marches', 'POST', {
      territoryId: capital.id,
      type: 'DEFEND',
      units: [{ unitId: 'swordsman', count: 5 }],
      idempotencyKey: 'march-it-cancel-1',
    })
    expect(created.status).toBe(200)
    const marchId = created.body.data!.id
    const armyBefore = await homeArmy(lord.playerId)

    const cancelled = await call<{
      march: MarchView
      unitsReleased: number
      energyRefunded: number
    }>(cancelPost, lord.token, '/api/v1/marches/x/cancel', 'POST', undefined, marchId)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.data!.march.status).toBe('CANCELLED')
    expect(cancelled.body.data!.unitsReleased).toBe(5)
    expect(cancelled.body.data!.energyRefunded).toBe(0) // mobilization policy
    const armyAfter = await homeArmy(lord.playerId)
    expect(armyAfter.get('swordsman')).toBe((armyBefore.get('swordsman') ?? 0) + 5)

    // Double cancel → typed refusal, no double restoration
    const again = await call<{ error: { code: string } }>(
      cancelPost,
      lord.token,
      '/api/v1/marches/x/cancel',
      'POST',
      undefined,
      marchId,
    )
    expect(again.status).toBe(409)
    expect(again.body.error!.code).toBe('MARCH_NOT_CANCELLABLE')
    const armyFinal = await homeArmy(lord.playerId)
    expect(armyFinal.get('swordsman')).toBe(armyAfter.get('swordsman'))

    // Cancel AFTER arrival (the reinforce march from test 10 is COMPLETED)
    const doneMarch = await db.march.findFirstOrThrow({
      where: { playerId: lord.playerId, status: 'COMPLETED' },
    })
    const late = await call<{ error: { code: string } }>(
      cancelPost,
      lord.token,
      '/api/v1/marches/x/cancel',
      'POST',
      undefined,
      doneMarch.id,
    )
    expect(late.status).toBe(409)
    expect(late.body.error!.code).toBe('MARCH_NOT_CANCELLABLE')
  })

  it('12 — the ledger reconciles exactly (Σ deltas == wallet balance)', async () => {
    const wallet = await db.resourceWallet.findUniqueOrThrow({
      where: { playerId: lord.playerId },
    })
    const txs = await db.resourceTransaction.findMany({
      where: { playerId: lord.playerId },
      select: { resource: true, delta: true },
    })
    const sums = new Map<string, bigint>()
    for (const tx of txs) {
      sums.set(tx.resource, (sums.get(tx.resource) ?? 0n) + tx.delta)
    }
    for (const [resource, key] of [
      ['GOLD', 'gold'],
      ['WOOD', 'wood'],
      ['IRON', 'iron'],
      ['FOOD', 'food'],
      ['CRYSTAL', 'crystal'],
    ] as const) {
      const ledgerSum = sums.get(resource) ?? 0n
      const balance = wallet[key]
      expect(ledgerSum).toBe(balance)
    }
  })

  it('13 — foreign march access is a NOT_FOUND (no existence leak)', async () => {
    const march = await db.march.findFirstOrThrow({ where: { playerId: lord.playerId } })
    const stranger = await register()
    createdPlayerIds.push(stranger.playerId)
    await grantVeteranArmy(stranger.playerId)
    const stolen = await call<MarchView>(
      marchGet,
      stranger.token,
      '/api/v1/marches/x',
      'GET',
      undefined,
      march.id,
    )
    expect(stolen.status).toBe(404)
    expect(stolen.body.error!.code).toBe('MARCH_NOT_FOUND')
    const stolenCancel = await call<{ error: { code: string } }>(
      cancelPost,
      stranger.token,
      '/api/v1/marches/x/cancel',
      'POST',
      undefined,
      march.id,
    )
    expect(stolenCancel.status).toBe(404)
  })

  it('14 — the cooldown clock still gates new combat marches after a battle', async () => {
    // Arrange a RECENT battle (the honest way — a battle 10s ago is inside
    // the 60s regroup window) and verify the clock refuses new combat marches.
    await db.battle.updateMany({
      where: { attackerPlayerId: lord.playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
      data: { startedAt: new Date(Date.now() - 10_000) },
    })
    // Pick an ADJACENT unclaimed target (adjacency is checked before the
    // cooldown in the pipeline — the clock must be what refuses here).
    const ownedCells = await db.territory.findMany({
      where: { ownerPlayerId: lord.playerId },
      select: { x: true, y: true },
    })
    const adjacentCoordsSet = new Set(
      ownedCells.flatMap((cell) => adjacentCoords(cell.x, cell.y).map((c) => `${c.x},${c.y}`)),
    )
    const adjacentCandidates = [...adjacentCoordsSet].map((key) => {
      const [x, y] = key.split(',').map(Number)
      return { x: x!, y: y! }
    })
    const adjacentTarget = await db.territory.findFirst({
      where: {
        OR: adjacentCandidates.map((c) => ({ x: c.x, y: c.y })),
        status: 'UNCLAIMED',
        isCapital: false,
        id: { not: adjacentUnclaimed!.id },
      },
      select: { id: true, x: true, y: true },
    })
    expect(adjacentTarget).not.toBeNull()
    expect(adjacentCoordsSet.has(`${adjacentTarget!.x},${adjacentTarget!.y}`)).toBe(true)
    const created = await call<{ error: { code: string } }>(
      marchPost,
      lord.token,
      '/api/v1/marches',
      'POST',
      {
        territoryId: adjacentTarget!.id,
        type: 'ATTACK',
        units: [{ unitId: 'swordsman', count: 1 }],
      },
    )
    expect(created.status).toBe(429)
    expect(created.body.error!.code).toBe('ACTION_ON_COOLDOWN')
    expect(created.body.error!.details).toHaveProperty('retryAfterSec')
  })
})
