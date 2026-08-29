/**
 * Integration tests — Army & Unit System (Phase 7): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod body/params → auth guard → services → transactions → envelope).
 * Recruitment mutations run through the PUBLIC service paths inside real
 * transactions — real BigInt economy debits, real SQLite, zero mocks.
 *
 * Required scenarios (user contract):
 *  1. RECRUIT FLOW        — resources checked, cost debited through the
 *                           ledger (UNIT_TRAINING), queue item recorded with
 *                           start time / finish time / status
 *  2. INSUFFICIENT        — typed INSUFFICIENT_* 409, zero writes
 *  3. QUEUE               — FIFO chain (follower anchors on tail), depth
 *                           enforced, TRAINING_QUEUE_FULL at the limit
 *  4. COMPLETION          — server-clock claim; early claim refused with the
 *                           remaining seconds; completion lands units, DONE
 *                           status, power recalculation, notification; a
 *                           double claim is refused
 *  5. CONCURRENT          — parallel recruits serialize behind the wallet
 *                           mutex; each debited exactly once; chain consistent
 *  6. INVALID UNIT        — unknown AND retired ids → UNIT_NOT_FOUND 404
 *  7. NEGATIVE QUANTITY   — zero/negative/fractional → VALIDATION_ERROR 400
 *  8. CANCELLATION        — policy refunds (100% queued · 50% in progress),
 *                           ledger refund rows, queue re-walk anchors
 *                           followers earlier, double cancel refused
 *  9. BUILDING GATE       — unit gated on Barracks 5 refused at Barracks 1
 * 10. UNAUTHORIZED        — 401 without a session; route modules export the
 *                           exact intended verb set; cross-player isolation
 *
 * Test identities live in the isolated 9100009… telegramId range and are
 * removed in afterAll (cascades: player, city, buildings, wallet, ledger,
 * queue, units…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as armyGet } from '../../../src/app/api/v1/army/route'
import { GET as catalogGet } from '../../../src/app/api/v1/army/catalog/route'
import { POST as trainPost } from '../../../src/app/api/v1/army/train/route'
import { POST as completePost } from '../../../src/app/api/v1/army/train/[id]/complete/route'
import { POST as cancelPost } from '../../../src/app/api/v1/army/train/[id]/cancel/route'
import * as armyRouteModule from '../../../src/app/api/v1/army/route'
import * as catalogRouteModule from '../../../src/app/api/v1/army/catalog/route'
import * as trainRouteModule from '../../../src/app/api/v1/army/train/route'
import * as completeRouteModule from '../../../src/app/api/v1/army/train/[id]/complete/route'
import * as cancelRouteModule from '../../../src/app/api/v1/army/train/[id]/cancel/route'
import { AppError } from '../../../src/lib/api/errors'
import {
  cancelTraining,
  completeTraining,
  recruitUnits,
} from '../../../src/lib/game/services/army.service'
import {
  getWalletBalances,
  runEconomyTransaction,
} from '../../../src/lib/game/services/economy.service'
import { ARMY_TRAINING } from '../../../src/lib/game/config/army'
import { computeUnitBasePower } from '../../../src/lib/game/config/power'
import { STARTER_UNITS } from '../../../src/lib/game/config/starter'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Army integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '203.0.119.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100009001
const nextTgId = (): string => String(tgCounter++)

function telegramRequest(initData: string): Request {
  return new Request('http://localhost:3000/api/v1/auth/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
    body: JSON.stringify({ initData }),
  })
}

function buildInitData(telegramId: string, seq = 0): string {
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAA${telegramId.slice(-4)}${seq}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60 - seq),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `ArmyLord${telegramId.slice(-3)}`,
      username: `army_lord_${telegramId.slice(-4)}`,
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

function authedRequest(
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

function routeCtx(id: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id }) }
}

interface QueueItemData {
  id: string
  unitId: string
  unitName: string
  count: number
  status: string
  startedAt: string
  completesAt: string
  remainingSec: number
}

interface ArmyViewData {
  units: Array<{
    unitId: string
    name: string
    class: string
    tier: number
    count: number
    attack: number
    defense: number
    health: number
    speed: number
    foodUpkeep: number
    carryCapacity: number
  }>
  totals: { unitCount: number; upkeepFood: number; carryCapacity: number }
  training: {
    queue: QueueItemData[]
    activeCount: number
    queueSlots: number
    speedBps: Record<string, number>
  }
  updatedAt: string
}

interface RecruitResultData {
  item: QueueItemData
  queue: QueueItemData[]
  balances: Record<string, string>
}

interface TrainingCancelResultData {
  cancelled: {
    id: string
    unitId: string
    unitName: string
    count: number
    wasStarted: boolean
    refundBps: number
  }
  refund: Partial<Record<string, string>>
  balances: Record<string, string>
  queue: QueueItemData[]
}

async function parse<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

async function exchange(tgId: string): Promise<{ token: string; playerId: string }> {
  const res = await telegramPost(telegramRequest(buildInitData(tgId)))
  expect(res.status).toBe(200)
  const body = await parse<{ token: string; player: { id: string } | null }>(res)
  expect(body.ok).toBe(true)
  if (!body.ok || !body.data.player) throw new Error('exchange did not return a player')
  return { token: body.data.token, playerId: body.data.player.id }
}

async function expectAppError(run: () => Promise<unknown>, code: string): Promise<AppError> {
  try {
    await run()
  } catch (err) {
    if (err instanceof AppError && err.code === code) return err
    throw new Error(`expected AppError ${code}, got: ${String(err)}`)
  }
  throw new Error(`expected AppError ${code}, but the call succeeded`)
}

/** Backdates a queue item so the server clock accepts the claim / marks it started. */
async function backdateItem(
  itemId: string,
  opts: { startedAgoSec: number; completesAgoSec: number },
): Promise<void> {
  const updated = await db.trainingQueueItem.updateMany({
    where: { id: itemId, status: 'TRAINING' },
    data: {
      startedAt: new Date(Date.now() - opts.startedAgoSec * 1000),
      completesAt: new Date(Date.now() - opts.completesAgoSec * 1000),
    },
  })
  if (updated.count !== 1) throw new Error('fixture backdate found no in-flight item')
}

/** Shifts a queue item's window into the past but leaves completesAt future. */
async function backdateToMidTraining(itemId: string, totalWindowSec: number): Promise<void> {
  const updated = await db.trainingQueueItem.updateMany({
    where: { id: itemId, status: 'TRAINING' },
    data: {
      startedAt: new Date(Date.now() - Math.floor(totalWindowSec / 2) * 1000),
    },
  })
  if (updated.count !== 1) throw new Error('fixture mid-training backdate found no item')
}

async function queueItemRow(itemId: string) {
  const row = await db.trainingQueueItem.findUnique({ where: { id: itemId } })
  if (!row) throw new Error(`fixture missing queue item ${itemId}`)
  return row
}

async function stackOf(playerId: string, unitId: string): Promise<number> {
  const row = await db.playerUnit.findUnique({
    where: { playerId_unitId: { playerId, unitId } },
  })
  return row?.count ?? 0
}

// ── Shared fixtures (created once) ───────────────────────────────────────────

const viewTgId = nextTgId()
const recTgId = nextTgId()
const insufTgId = nextTgId()
const queueTgId = nextTgId()
const compTgId = nextTgId()
const concTgId = nextTgId()
const cancTgId = nextTgId()
const gateTgId = nextTgId()
const isoATgId = nextTgId()
const isoBTgId = nextTgId()

let viewToken = ''
let recToken = ''
let recPlayerId = ''
let insufToken = ''
let insufPlayerId = ''
let queueToken = ''
let compToken = ''
let compPlayerId = ''
let concPlayerId = ''
let cancToken = ''
let cancPlayerId = ''
let gateToken = ''
let isoAToken = ''
let isoAPlayerId = ''
let isoBToken = ''

beforeAll(async () => {
  const view = await exchange(viewTgId)
  viewToken = view.token

  const rec = await exchange(recTgId)
  recToken = rec.token
  recPlayerId = rec.playerId

  const insuf = await exchange(insufTgId)
  insufToken = insuf.token
  insufPlayerId = insuf.playerId

  const queue = await exchange(queueTgId)
  queueToken = queue.token

  const comp = await exchange(compTgId)
  compToken = comp.token
  compPlayerId = comp.playerId

  concPlayerId = (await exchange(concTgId)).playerId

  const canc = await exchange(cancTgId)
  cancToken = canc.token
  cancPlayerId = canc.playerId

  const gate = await exchange(gateTgId)
  gateToken = gate.token

  const isoA = await exchange(isoATgId)
  isoAToken = isoA.token
  isoAPlayerId = isoA.playerId
  isoBToken = (await exchange(isoBTgId)).token
})

afterAll(async () => {
  await db.user.deleteMany({ where: { telegramId: { startsWith: '9100009' } } })
})

// ── 1. Army view + catalog (read APIs) ───────────────────────────────────────

describe('GET /api/v1/army (army projection)', () => {
  it('projects the full 11-unit roster with the starter stacks', async () => {
    const res = await armyGet(authedRequest('/api/v1/army', viewToken))
    expect(res.status).toBe(200)
    const body = await parse<ArmyViewData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.units.length).toBe(11)
    const swordsman = body.data.units.find((u) => u.unitId === 'swordsman')
    const archer = body.data.units.find((u) => u.unitId === 'archer')
    expect(swordsman?.count).toBe(20)
    expect(archer?.count).toBe(10)
    // Starter army totals: upkeep + carry aggregated from real stacks.
    expect(body.data.totals.unitCount).toBe(30)
    const expectedUpkeep = STARTER_UNITS.reduce((sum, s) => {
      const unit = body.data.units.find((u) => u.unitId === s.unitId)!
      return sum + unit.foodUpkeep * s.count
    }, 0)
    expect(body.data.totals.upkeepFood).toBe(expectedUpkeep)
    // Retired baseline units (militia) never appear in the active roster.
    expect(body.data.units.find((u) => u.unitId === 'militia')).toBeUndefined()
    expect(body.data.training).toEqual({
      queue: [],
      activeCount: 0,
      queueSlots: ARMY_TRAINING.queueSlots,
      speedBps: { BARRACKS: 10_000, ARCHER_CAMP: 10_000, STABLE: 10_000, ARMORY: 10_000 },
    })
  })

  it('materializes the catalog with costs as strings and counter data', async () => {
    const res = await catalogGet(authedRequest('/api/v1/army/catalog', viewToken))
    expect(res.status).toBe(200)
    const body = await parse<{
      units: Array<{
        id: string
        trainingCost: Record<string, string>
        trainingBuilding: string
        requiredBuildingLevel: number
        strongAgainst: Array<{ unitId: string; bonusBps: number }>
        weakAgainst: Array<{ unitId: string; penaltyBps: number }>
      }>
    }>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.units.length).toBe(11)
    const swordsman = body.data.units.find((u) => u.id === 'swordsman')!
    expect(swordsman.trainingCost).toEqual({ GOLD: '120', FOOD: '60', IRON: '50' })
    expect(swordsman.trainingBuilding).toBe('BARRACKS')
    expect(swordsman.requiredBuildingLevel).toBe(1)
    // Data-driven counter edges cross the API.
    expect(swordsman.strongAgainst.map((c) => c.unitId).sort()).toEqual([
      'cavalry',
      'heavy_cavalry',
      'knight',
    ])
    const knight = body.data.units.find((u) => u.id === 'knight')!
    expect(knight.requiredBuildingLevel).toBe(10)
    const catapult = body.data.units.find((u) => u.id === 'catapult')!
    expect(catapult.strongAgainst).toEqual([])
  })
})

// ── 2. Recruit flow ──────────────────────────────────────────────────────────

describe('POST /api/v1/army/train (recruit flow)', () => {
  it('debits the exact batch cost through the ledger and records the queue item', async () => {
    const before = await getWalletBalances(db, recPlayerId)
    const res = await trainPost(
      authedRequest('/api/v1/army/train', recToken, 'POST', { unitId: 'swordsman', count: 2 }),
    )
    expect(res.status).toBe(200)
    const body = await parse<RecruitResultData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    // Queue item: start/finish/status — 2 swordsmen at 10_000 bps = 44s.
    expect(body.data.item.unitId).toBe('swordsman')
    expect(body.data.item.count).toBe(2)
    expect(body.data.item.status).toBe('TRAINING')
    const windowMs = Date.parse(body.data.item.completesAt) - Date.parse(body.data.item.startedAt)
    expect(windowMs).toBe(44_000)

    // Balances after: swordsman ×2 = G240 F120 I100.
    expect(body.data.balances['GOLD']).toBe((before.GOLD - 240n).toString())
    expect(body.data.balances['FOOD']).toBe((before.FOOD - 120n).toString())
    expect(body.data.balances['IRON']).toBe((before.IRON - 100n).toString())
    expect(body.data.balances['WOOD']).toBe(before.WOOD.toString())

    // Ledger: UNIT_TRAINING debits with a queue ref, all-or-nothing.
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: recPlayerId, reason: 'UNIT_TRAINING' },
    })
    expect(ledger.length).toBe(3)
    for (const row of ledger) {
      expect(row.refType).toBe('training_queue')
      expect(row.refId).toBe(body.data.item.id)
      expect(row.delta).toBeLessThan(0n)
    }

    // Unit counts are untouched until the batch is CLAIMED.
    expect(await stackOf(recPlayerId, 'swordsman')).toBe(20)
  })

  it('anchors a follower batch on the current tail (FIFO chain)', async () => {
    const res = await trainPost(
      authedRequest('/api/v1/army/train', recToken, 'POST', { unitId: 'archer', count: 1 }),
    )
    expect(res.status).toBe(200)
    const body = await parse<RecruitResultData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    // The queue: head (2 swordsmen) then the new archer batch.
    expect(body.data.queue.length).toBe(2)
    const [head, follower] = body.data.queue
    expect(follower!.status).toBe('TRAINING')
    // Follower starts exactly when the head completes.
    expect(Date.parse(follower!.startedAt)).toBe(Date.parse(head!.completesAt))
    // Archer at 10_000 bps = 15s window.
    const windowMs = Date.parse(follower!.completesAt) - Date.parse(follower!.startedAt)
    expect(windowMs).toBe(15_000)
  })

  it('refuses an early claim against the server clock with the remaining seconds', async () => {
    const queue = await db.trainingQueueItem.findMany({
      where: { playerId: recPlayerId, status: 'TRAINING' },
      orderBy: [{ createdAt: 'asc' }],
    })
    const head = queue[0]!
    const service = await expectAppError(
      () => completeTraining(recPlayerId, head.id),
      'TRAINING_NOT_COMPLETE',
    )
    expect(service.details?.['remainingSec']).toBeGreaterThan(0)
  })
})

// ── 3. Insufficient resources ────────────────────────────────────────────────

describe('recruit refusals — insufficient resources (zero writes)', () => {
  it('refuses a batch the wallet cannot cover with a typed 409', async () => {
    // 10 swordsmen need 500 iron — the starter wallet holds 400.
    const before = await getWalletBalances(db, insufPlayerId)
    const res = await trainPost(
      authedRequest('/api/v1/army/train', insufToken, 'POST', { unitId: 'swordsman', count: 10 }),
    )
    expect(res.status).toBe(409)
    const body = await parse<{
      error: { code: string; details?: { needed?: number; have?: number } }
    }>(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('INSUFFICIENT_IRON')
    expect(body.error.details?.['needed']).toBe(500)
    expect(body.error.details?.['have']).toBe(Number(before.IRON))

    // Zero writes: untouched wallet, no queue rows, no ledger rows.
    expect(await getWalletBalances(db, insufPlayerId)).toEqual(before)
    expect(await db.trainingQueueItem.count({ where: { playerId: insufPlayerId } })).toBe(0)
    expect(
      await db.resourceTransaction.count({
        where: { playerId: insufPlayerId, reason: 'UNIT_TRAINING' },
      }),
    ).toBe(0)
  })

  it('rolls back the queue row together with the failed debit (transactional)', async () => {
    const before = await db.trainingQueueItem.count({ where: { playerId: insufPlayerId } })
    // 10 swordsmen need 500 iron (wallet holds 400) — the enqueue must roll
    // back atomically, leaving zero queue rows behind.
    await expectAppError(() => recruitUnits(insufPlayerId, 'swordsman', 10), 'INSUFFICIENT_IRON')
    expect(await db.trainingQueueItem.count({ where: { playerId: insufPlayerId } })).toBe(before)
  })
})

// ── 4. Queue depth ───────────────────────────────────────────────────────────

describe('recruitment queue — FIFO depth enforcement', () => {
  it('accepts queueSlots parallel-space batches then refuses the next with 409', async () => {
    // Fill the queue to the config depth with 1-swordsman batches.
    const filled: QueueItemData[] = []
    for (let i = 0; i < ARMY_TRAINING.queueSlots; i++) {
      const res = await trainPost(
        authedRequest('/api/v1/army/train', queueToken, 'POST', { unitId: 'swordsman', count: 1 }),
      )
      expect(res.status).toBe(200)
      const body = await parse<RecruitResultData>(res)
      if (body.ok) filled.push(body.data.item)
    }
    expect(filled.length).toBe(ARMY_TRAINING.queueSlots)

    // The chain is monotonic: each follower anchors on the previous tail.
    for (let i = 1; i < filled.length; i++) {
      expect(Date.parse(filled[i]!.startedAt)).toBe(Date.parse(filled[i - 1]!.completesAt))
    }

    // One more → TRAINING_QUEUE_FULL.
    const res = await trainPost(
      authedRequest('/api/v1/army/train', queueToken, 'POST', { unitId: 'swordsman', count: 1 }),
    )
    expect(res.status).toBe(409)
    const body = await parse<{ error: { code: string; details?: Record<string, unknown> } }>(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('TRAINING_QUEUE_FULL')
    expect(body.error.details?.['slots']).toBe(ARMY_TRAINING.queueSlots)

    // The refusal wrote nothing.
    const playerId = (await db.user.findUnique({
      where: { telegramId: queueTgId },
      include: { player: true },
    }))!.player!.id
    expect(await db.trainingQueueItem.count({ where: { playerId } })).toBe(ARMY_TRAINING.queueSlots)
  })
})

// ── 5. Completion ────────────────────────────────────────────────────────────

describe('POST /api/v1/army/train/[id]/complete (claim lifecycle)', () => {
  it('lands the batch on claim: units, DONE status, power, notification', async () => {
    const beforePower = await db.player.findUniqueOrThrow({
      where: { id: compPlayerId },
      select: { power: true },
    })
    const res = await trainPost(
      authedRequest('/api/v1/army/train', compToken, 'POST', { unitId: 'swordsman', count: 2 }),
    )
    expect(res.status).toBe(200)
    const recruitBody = await parse<RecruitResultData>(res)
    expect(recruitBody.ok).toBe(true)
    const itemId = recruitBody.ok ? recruitBody.data.item.id : ''
    if (!itemId) return

    // Early claim refused (server clock is the only authority).
    const early = await completePost(
      authedRequest(`/api/v1/army/train/${itemId}/complete`, compToken, 'POST'),
      routeCtx(itemId),
    )
    expect(early.status).toBe(409)
    const earlyBody = await parse<{ error: { code: string; details?: { remainingSec?: number } } }>(
      early,
    )
    expect(earlyBody.ok).toBe(false)
    if (!earlyBody.ok) expect(earlyBody.error.code).toBe('TRAINING_NOT_COMPLETE')

    // Backdate the window (fixture — the server clock then accepts the claim).
    await backdateItem(itemId, { startedAgoSec: 60, completesAgoSec: 5 })

    const completeRes = await completePost(
      authedRequest(`/api/v1/army/train/${itemId}/complete`, compToken, 'POST'),
      routeCtx(itemId),
    )
    expect(completeRes.status).toBe(200)
    const completeBody = await parse<{
      completed: { id: string; unitId: string; count: number }
      power: number
      stackCount: number
    }>(completeRes)
    expect(completeBody.ok).toBe(true)
    if (!completeBody.ok) return

    expect(completeBody.data.completed.unitId).toBe('swordsman')
    expect(completeBody.data.completed.count).toBe(2)
    expect(completeBody.data.stackCount).toBe(22) // 20 starter + 2 trained

    // Power recalculated from real state: swordsman base × 2 added.
    const swordsmanPower = computeUnitBasePower({ attack: 24, defense: 32, health: 160, tier: 1 })
    expect(completeBody.data.power).toBe(Number(beforePower.power) + swordsmanPower * 2)

    const item = await queueItemRow(itemId)
    expect(item.status).toBe('DONE')

    // TRAINING_COMPLETE notification written in the same transaction.
    const notification = await db.notification.findFirst({
      where: { playerId: compPlayerId, type: 'TRAINING_COMPLETE' },
    })
    expect(notification).not.toBeNull()
  })

  it('refuses a double claim with TRAINING_NOT_ACTIVE', async () => {
    const done = await db.trainingQueueItem.findFirst({
      where: { playerId: compPlayerId, status: 'DONE' },
    })
    if (!done) throw new Error('fixture missing DONE item')
    const res = await completePost(
      authedRequest(`/api/v1/army/train/${done.id}/complete`, compToken, 'POST'),
      routeCtx(done.id),
    )
    expect(res.status).toBe(409)
    const body = await parse<{ error: { code: string } }>(res)
    if (!body.ok) expect(body.error.code).toBe('TRAINING_NOT_ACTIVE')
    // The stack did not double.
    expect(await stackOf(compPlayerId, 'swordsman')).toBe(22)
  })
})

// ── 6. Concurrent recruitment ────────────────────────────────────────────────

describe('concurrent recruitment — mutex serialization, exact debits', () => {
  it('resolves parallel recruits into a consistent FIFO chain with exact costs', async () => {
    const before = await getWalletBalances(db, concPlayerId)
    const results = await Promise.all([
      recruitUnits(concPlayerId, 'swordsman', 1),
      recruitUnits(concPlayerId, 'archer', 1),
      recruitUnits(concPlayerId, 'swordsman', 2),
    ])
    expect(results.length).toBe(3)

    // Every recruit debited exactly once (3 ledger debits, exact sums — BigInt math).
    const after = await getWalletBalances(db, concPlayerId)
    expect(after.GOLD).toBe(before.GOLD - 120n - 70n - 240n)
    expect(after.FOOD).toBe(before.FOOD - 60n - 30n - 120n)
    expect(after.IRON).toBe(before.IRON - 50n - 100n) // archer carries no iron cost
    expect(after.WOOD).toBe(before.WOOD - 40n)

    // The queue holds exactly 3 TRAINING items in a monotonic chain.
    const queue = await db.trainingQueueItem.findMany({
      where: { playerId: concPlayerId, status: 'TRAINING' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    expect(queue.length).toBe(3)
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i]!.startedAt.getTime()).toBeGreaterThanOrEqual(
        queue[i - 1]!.completesAt.getTime(),
      )
    }

    // No negative balances — the double-spending invariant.
    for (const value of Object.values(after)) {
      expect(BigInt(value) >= 0n).toBeTrue()
    }
  })
})

// ── 7. Invalid unit & negative quantity ──────────────────────────────────────

describe('recruit validation — invalid unit, negative quantity', () => {
  it('refuses unknown unit ids with UNIT_NOT_FOUND (404)', async () => {
    const res = await trainPost(
      authedRequest('/api/v1/army/train', viewToken, 'POST', { unitId: 'dragon', count: 1 }),
    )
    expect(res.status).toBe(404)
    const body = await parse<{ error: { code: string } }>(res)
    if (!body.ok) expect(body.error.code).toBe('UNIT_NOT_FOUND')
  })

  it('refuses retired baseline units exactly like unknown ids', async () => {
    const res = await trainPost(
      authedRequest('/api/v1/army/train', viewToken, 'POST', { unitId: 'militia', count: 1 }),
    )
    expect(res.status).toBe(404)
    const body = await parse<{ error: { code: string } }>(res)
    if (!body.ok) expect(body.error.code).toBe('UNIT_NOT_FOUND')
  })

  it('refuses zero and negative quantities with VALIDATION_ERROR (400)', async () => {
    for (const count of [0, -1, -100]) {
      const res = await trainPost(
        authedRequest('/api/v1/army/train', viewToken, 'POST', { unitId: 'swordsman', count }),
      )
      expect(res.status).toBe(400)
      const body = await parse<{ error: { code: string } }>(res)
      if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
    }
  })

  it('refuses fractional quantities with VALIDATION_ERROR (400)', async () => {
    const res = await trainPost(
      authedRequest('/api/v1/army/train', viewToken, 'POST', { unitId: 'swordsman', count: 1.5 }),
    )
    expect(res.status).toBe(400)
  })

  it('refuses a batch above the config ceiling (server-side policy)', async () => {
    const res = await trainPost(
      authedRequest('/api/v1/army/train', viewToken, 'POST', {
        unitId: 'swordsman',
        count: 1_000_000,
      }),
    )
    expect(res.status).toBe(400)
    const body = await parse<{ error: { code: string } }>(res)
    if (!body.ok) expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ── 8. Building gate ─────────────────────────────────────────────────────────

describe('recruit validation — training building gate', () => {
  it('refuses a unit whose training building is below the required level', async () => {
    // shield_guard requires Barracks 5 — every starter city has Barracks 1.
    const res = await trainPost(
      authedRequest('/api/v1/army/train', gateToken, 'POST', { unitId: 'shield_guard', count: 1 }),
    )
    expect(res.status).toBe(409)
    const body = await parse<{ error: { code: string; details?: { missing?: string[] } } }>(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('PREREQUISITE_MISSING')
    expect(body.error.details?.missing?.join(' ')).toContain('Barracks level 5')
  })
})

// ── 9. Cancellation ──────────────────────────────────────────────────────────

describe('POST /api/v1/army/train/[id]/cancel (refund policy + re-walk)', () => {
  it('refunds 100% for a queued (not started) batch and re-walks the followers', async () => {
    // Two batches: head (in progress), follower (queued behind).
    const first = await recruitUnits(cancPlayerId, 'swordsman', 2)
    const second = await recruitUnits(cancPlayerId, 'archer', 2)
    const before = await getWalletBalances(db, cancPlayerId)

    // Cancel the QUEUED follower → full refund (archer ×2 = G140 F60 W80).
    const result = await cancelTraining(cancPlayerId, second.item.id)
    expect(result.cancelled.wasStarted).toBe(false)
    expect(result.cancelled.refundBps).toBe(ARMY_TRAINING.notStartedRefundBps)
    expect(result.refund['GOLD']).toBe('140')
    expect(result.refund['FOOD']).toBe('60')
    expect(result.refund['WOOD']).toBe('80')

    const after = await getWalletBalances(db, cancPlayerId)
    expect(after.GOLD).toBe(before.GOLD + 140n)
    expect(after.FOOD).toBe(before.FOOD + 60n)
    expect(after.WOOD).toBe(before.WOOD + 80n)

    // Refund crossed the ledger with a queue ref.
    const refundRows = await db.resourceTransaction.findMany({
      where: { playerId: cancPlayerId, reason: 'UNIT_TRAINING', delta: { gt: 0n } },
    })
    expect(refundRows.length).toBe(3)
    for (const row of refundRows) {
      expect(row.refId).toBe(second.item.id)
    }

    // The queue no longer holds the cancelled item; the head is untouched.
    expect(result.queue.length).toBe(1)
    expect(result.queue[0]!.id).toBe(first.item.id)
    const cancelledRow = await queueItemRow(second.item.id)
    expect(cancelledRow.status).toBe('CANCELLED')
  })

  it('refunds 50% for an in-progress batch (policy matrix)', async () => {
    // Fresh batch — the head starts immediately (startedAt ≤ now).
    const batch = await recruitUnits(cancPlayerId, 'swordsman', 2)
    await backdateToMidTraining(batch.item.id, 44)

    const before = await getWalletBalances(db, cancPlayerId)
    const res = await cancelPost(
      authedRequest(`/api/v1/army/train/${batch.item.id}/cancel`, cancToken, 'POST'),
      routeCtx(batch.item.id),
    )
    expect(res.status).toBe(200)
    const body = await parse<TrainingCancelResultData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.cancelled.wasStarted).toBe(true)
    expect(body.data.cancelled.refundBps).toBe(ARMY_TRAINING.inProgressRefundBps)
    // 50% of G240 F120 I100.
    expect(body.data.refund['GOLD']).toBe('120')
    expect(body.data.refund['FOOD']).toBe('60')
    expect(body.data.refund['IRON']).toBe('50')

    const after = await getWalletBalances(db, cancPlayerId)
    expect(after.GOLD).toBe(before.GOLD + 120n)
    expect(after.FOOD).toBe(before.FOOD + 60n)
    expect(after.IRON).toBe(before.IRON + 50n)

    const row = await queueItemRow(batch.item.id)
    expect(row.status).toBe('CANCELLED')
  })

  it('anchors remaining followers earlier after cancelling a mid-queue batch', async () => {
    // A long-lived head from an earlier test is still in this player's queue;
    // three fresh batches A → B → C queue behind it. Cancel B: C must
    // re-anchor on A's completion — strictly earlier, same paid window.
    const a = await recruitUnits(cancPlayerId, 'swordsman', 1)
    const b = await recruitUnits(cancPlayerId, 'swordsman', 1)
    const c = await recruitUnits(cancPlayerId, 'swordsman', 1)
    const cOriginalStart = Date.parse(c.item.startedAt)

    const result = await cancelTraining(cancPlayerId, b.item.id)
    // Head (earlier test) + a + c — b is gone.
    expect(result.queue.length).toBe(3)
    expect(result.queue.find((q) => q.id === b.item.id)).toBeUndefined()

    const cRow = await queueItemRow(c.item.id)
    expect(cRow.status).toBe('TRAINING')
    // C now starts exactly when A (this test's head) completes — 22s earlier
    // than its original anchor (B's completion).
    expect(cRow.startedAt.getTime()).toBe(new Date(a.item.completesAt).getTime())
    expect(cRow.startedAt.getTime()).toBeLessThan(cOriginalStart)
    // C's paid window is preserved (22s for 1 swordsman at base speed).
    expect(cRow.completesAt.getTime() - cRow.startedAt.getTime()).toBe(22_000)
  })

  it('refuses a double cancel and an unknown id', async () => {
    const batch = await recruitUnits(cancPlayerId, 'archer', 1)
    await cancelTraining(cancPlayerId, batch.item.id)
    await expectAppError(() => cancelTraining(cancPlayerId, batch.item.id), 'TRAINING_NOT_ACTIVE')
    await expectAppError(() => cancelTraining(cancPlayerId, 'nonexistent-id'), 'TRAINING_NOT_FOUND')
    await expectAppError(
      () => completeTraining(cancPlayerId, 'nonexistent-id'),
      'TRAINING_NOT_FOUND',
    )
  })
})

// ── 10. Unauthorized & isolation ─────────────────────────────────────────────

describe('authorization — 401s, verb exports, cross-player isolation', () => {
  it('requires authentication for all five army endpoints', async () => {
    const bare = { 'x-forwarded-for': nextIp() } as const
    expect(
      (await armyGet(new Request('http://localhost:3000/api/v1/army', { headers: bare }))).status,
    ).toBe(401)
    expect(
      (
        await catalogGet(
          new Request('http://localhost:3000/api/v1/army/catalog', { headers: bare }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await trainPost(
          new Request('http://localhost:3000/api/v1/army/train', {
            method: 'POST',
            headers: { ...bare, 'content-type': 'application/json' },
            body: JSON.stringify({ unitId: 'swordsman', count: 1 }),
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await completePost(
          new Request('http://localhost:3000/api/v1/army/train/x/complete', {
            method: 'POST',
            headers: bare,
          }),
          routeCtx('x'),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await cancelPost(
          new Request('http://localhost:3000/api/v1/army/train/x/cancel', {
            method: 'POST',
            headers: bare,
          }),
          routeCtx('x'),
        )
      ).status,
    ).toBe(401)

    const garbage = { authorization: 'Bearer garbage-token', 'x-forwarded-for': nextIp() } as const
    expect(
      (await armyGet(new Request('http://localhost:3000/api/v1/army', { headers: garbage })))
        .status,
    ).toBe(401)
  })

  it('exports exactly the intended verbs per route module', () => {
    expect(Object.keys(armyRouteModule).sort()).toEqual(['GET'])
    expect(Object.keys(catalogRouteModule).sort()).toEqual(['GET'])
    expect(Object.keys(trainRouteModule).sort()).toEqual(['POST'])
    expect(Object.keys(completeRouteModule).sort()).toEqual(['POST'])
    expect(Object.keys(cancelRouteModule).sort()).toEqual(['POST'])
  })

  it('never exposes another player’s queue rows (no existence oracle)', async () => {
    // Player A owns a live queue item (recruited over the route with A's
    // own session); A's own early claim is legitimately refused on the
    // clock — proving the row is real and owner-reachable.
    const recruitRes = await trainPost(
      authedRequest('/api/v1/army/train', isoAToken, 'POST', { unitId: 'swordsman', count: 1 }),
    )
    expect(recruitRes.status).toBe(200)
    const recruitBody = await parse<RecruitResultData>(recruitRes)
    expect(recruitBody.ok).toBe(true)
    const itemId = recruitBody.ok ? recruitBody.data.item.id : ''
    if (!itemId) return

    await expectAppError(() => completeTraining(isoAPlayerId, itemId), 'TRAINING_NOT_COMPLETE')

    // Player B (own session over the route) gets TRAINING_NOT_FOUND for A's
    // item — the row id gives B no information, and neither complete nor
    // cancel can touch it.
    const bComplete = await completePost(
      authedRequest(`/api/v1/army/train/${itemId}/complete`, isoBToken, 'POST'),
      routeCtx(itemId),
    )
    expect(bComplete.status).toBe(404)
    const bCompleteBody = await parse<{ error: { code: string } }>(bComplete)
    if (!bCompleteBody.ok) expect(bCompleteBody.error.code).toBe('TRAINING_NOT_FOUND')

    const bCancel = await cancelPost(
      authedRequest(`/api/v1/army/train/${itemId}/cancel`, isoBToken, 'POST'),
      routeCtx(itemId),
    )
    expect(bCancel.status).toBe(404)

    // The item is intact and still A's.
    const row = await queueItemRow(itemId)
    expect(row.playerId).toBe(isoAPlayerId)
    expect(row.status).toBe('TRAINING')
  })

  it('keeps the ledger reconciled with the wallet (Σdelta == balance)', async () => {
    const result = await runEconomyTransaction(recPlayerId, async (tx) =>
      getWalletBalances(tx, recPlayerId),
    )
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: recPlayerId },
      orderBy: [{ createdAt: 'asc' }],
    })
    const sums = new Map<string, bigint>()
    for (const row of ledger) {
      sums.set(row.resource, (sums.get(row.resource) ?? 0n) + row.delta)
    }
    const stored: Record<string, bigint> = {
      GOLD: result.GOLD,
      WOOD: result.WOOD,
      IRON: result.IRON,
      FOOD: result.FOOD,
      CRYSTAL: result.CRYSTAL,
    }
    for (const [resource, balance] of Object.entries(stored)) {
      expect(sums.get(resource)).toBe(balance)
    }
  })
})
