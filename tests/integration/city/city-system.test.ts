/**
 * Integration tests — City & Building System (Phase 6): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod params → auth guard → services → transactions → envelope).
 * Construction mutations run through the PUBLIC service paths inside real
 * transactions — real BigInt economy debits, real SQLite, zero mocks.
 *
 * Required scenarios (user contract):
 *  1. UPGRADE FLOW      — resources checked, requirements checked, resource
 *                         transaction created, upgrade state recorded
 *  2. DOUBLE-SPENDING   — concurrent starters converge; cost debited exactly
 *                         once; conditional claim guard as the DB backstop
 *  3. CONSTRUCTION      — start time / finish time / status lifecycle with
 *                         the server clock as the only timing authority
 *  4. ROLLBACK          — a crash mid-upgrade persists NOTHING (cost, timer,
 *                         ledger, notification share one transaction)
 *  5. UNAUTHORIZED      — 401 without a session; route modules export the
 *                         exact intended verb set; per-player isolation
 *  6. VALIDATION MATRIX — unknown type / max level / prerequisites / queue
 *                         capacity / insufficient funds — all typed, zero writes
 *
 * Test identities live in the isolated 9100007… telegramId range and are
 * removed in afterAll (cascades: player, city, buildings, wallet, ledger…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as cityGet } from '../../../src/app/api/v1/city/route'
import { GET as catalogGet } from '../../../src/app/api/v1/city/buildings/route'
import { POST as upgradePost } from '../../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import { POST as finishPost } from '../../../src/app/api/v1/city/buildings/[type]/finish/route'
import * as cityRouteModule from '../../../src/app/api/v1/city/route'
import * as catalogRouteModule from '../../../src/app/api/v1/city/buildings/route'
import * as upgradeRouteModule from '../../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import * as finishRouteModule from '../../../src/app/api/v1/city/buildings/[type]/finish/route'
import { AppError } from '../../../src/lib/api/errors'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import {
  finishBuildingUpgrade,
  finishBuildingUpgradeInTx,
  getCityView,
  startBuildingUpgrade,
  startBuildingUpgradeInTx,
} from '../../../src/lib/game/services/city.service'
import {
  getWalletBalances,
  runEconomyTransaction,
  spendResources,
} from '../../../src/lib/game/services/economy.service'
import {
  effectsFor,
  upgradeCostFor,
  upgradeDurationSecFor,
} from '../../../src/lib/game/config/buildings'
import { STARTER_WALLET } from '../../../src/lib/game/config/starter'
import { POWER } from '../../../src/lib/game/config/power'
import type { ApiEnvelope } from '../../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'City integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '203.0.117.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100007001
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
      first_name: `CityLord${telegramId.slice(-3)}`,
      username: `city_lord_${telegramId.slice(-4)}`,
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

function authedRequest(path: string, token: string, method: 'GET' | 'POST' = 'GET'): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
  })
}

function routeCtx(type: string): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ type }) }
}

interface BuildingViewData {
  id: string
  type: string
  name: string
  category: string
  level: number
  maxLevel: number
  status: string
  isConstructing: boolean
  upgradeStartedAt: string | null
  upgradeCompletesAt: string | null
  pendingLevel: number | null
  effects: Record<string, unknown>
  nextUpgrade: {
    toLevel: number
    cost: Record<string, string>
    durationSec: number
    requirements: Record<string, unknown>
    requirementsMet: boolean
    unmetRequirements: string[]
  } | null
}

interface CityViewData {
  city: { id: string; name: string; x: number; y: number }
  buildings: BuildingViewData[]
  production: { GOLD: number; WOOD: number; IRON: number; FOOD: number }
  storage: { capacity: number }
  construction: { activeCount: number; queueSlots: number }
  updatedAt: string
}

interface UpgradeResultData {
  building: BuildingViewData
  balances: Record<string, string>
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

/** Backdates an in-flight construction so the server clock accepts the claim. */
async function backdateConstruction(playerId: string, type: string): Promise<void> {
  const city = await db.city.findUnique({ where: { playerId }, select: { id: true } })
  if (!city) throw new Error('fixture city missing')
  const updated = await db.building.updateMany({
    where: { cityId: city.id, type, isConstructing: true },
    data: {
      upgradeStartedAt: new Date(Date.now() - 3_600_000),
      upgradeCompletesAt: new Date(Date.now() - 60_000),
    },
  })
  if (updated.count !== 1) throw new Error('fixture backdate found no in-flight construction')
}

async function buildingRow(playerId: string, type: string) {
  const row = await db.building.findFirst({
    where: { city: { playerId }, type },
  })
  if (!row) throw new Error(`fixture missing ${type} row for ${playerId}`)
  return row
}

// ── Shared fixtures (created once) ───────────────────────────────────────────

const viewTgId = nextTgId()
const upTgId = nextTgId()
const insufTgId = nextTgId()
const concTgId = nextTgId()
const concQueueTgId = nextTgId()
const finTgId = nextTgId()
const rollTgId = nextTgId()
const isoATgId = nextTgId()
const isoBTgId = nextTgId()

let viewToken = ''
let viewPlayerId = ''
let upToken = ''
let upPlayerId = ''
let insufPlayerId = ''
let insufToken = ''
let concPlayerId = ''
let concQueuePlayerId = ''
let finPlayerId = ''
let rollPlayerId = ''
let isoAPlayerId = ''
let isoBToken = ''

beforeAll(async () => {
  const view = await exchange(viewTgId)
  viewPlayerId = view.playerId
  viewToken = view.token

  const up = await exchange(upTgId)
  upPlayerId = up.playerId
  upToken = up.token

  const insuf = await exchange(insufTgId)
  insufPlayerId = insuf.playerId
  insufToken = insuf.token

  concPlayerId = (await exchange(concTgId)).playerId
  concQueuePlayerId = (await exchange(concQueueTgId)).playerId

  finPlayerId = (await exchange(finTgId)).playerId

  rollPlayerId = (await exchange(rollTgId)).playerId

  isoAPlayerId = (await exchange(isoATgId)).playerId
  isoBToken = (await exchange(isoBTgId)).token
})

afterAll(async () => {
  await db.user.deleteMany({ where: { telegramId: { startsWith: '9100007' } } })
})

// ── 1. City view (read API) ─────────────────────────────────────────────────

describe('GET /api/v1/city (city projection)', () => {
  it('projects all 17 starter buildings at level 1 with idle status', async () => {
    const res = await cityGet(authedRequest('/api/v1/city', viewToken))
    expect(res.status).toBe(200)
    const body = await parse<CityViewData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.buildings.length).toBe(17)
    expect(new Set(body.data.buildings.map((b) => b.level))).toEqual(new Set([1]))
    for (const building of body.data.buildings) {
      expect(building.status).toBe('IDLE')
      expect(building.isConstructing).toBeFalse()
      expect(building.pendingLevel).toBeNull()
      expect(building.nextUpgrade).not.toBeNull()
    }

    const city = await db.city.findUnique({ where: { playerId: viewPlayerId } })
    expect(body.data.city.id).toBe(city?.id)
    expect(body.data.city.x).toBe(city?.x)
    expect(body.data.city.y).toBe(city?.y)
  })

  it('aggregates real level-1 effects: production, storage and queue', async () => {
    const view = await getCityView(db, viewPlayerId)
    expect(view.production).toEqual({
      GOLD: 45, // GOLD_MINE L1
      WOOD: 50, // WOOD_MILL L1
      IRON: 40, // IRON_MINE L1
      FOOD: 60, // FARM L1
    })
    expect(view.storage.capacity).toBe(effectsFor('WAREHOUSE', 1).storageCapacity)
    expect(view.construction).toEqual({ activeCount: 0, queueSlots: 1 })
  })

  it('previews next upgrades with server-computed requirement evaluation', async () => {
    const view = await getCityView(db, viewPlayerId)
    const farm = view.buildings.find((b) => b.type === 'FARM')!
    expect(farm.nextUpgrade).toMatchObject({
      toLevel: 2,
      cost: { GOLD: '120', WOOD: '100' },
      durationSec: upgradeDurationSecFor('FARM', 2),
      requirementsMet: true,
      unmetRequirements: [],
    })

    // SPY_CENTER L2 needs Town Hall 8 — the view flags it unmet with reasons.
    const spy = view.buildings.find((b) => b.type === 'SPY_CENTER')!
    expect(spy.nextUpgrade?.requirementsMet).toBeFalse()
    expect(spy.nextUpgrade?.unmetRequirements.length).toBeGreaterThan(0)
    expect(spy.nextUpgrade?.unmetRequirements.join(' ')).toContain('Town Hall level 8')

    // CASTLE L2 needs TH 6 — same flag, different reason.
    const castle = view.buildings.find((b) => b.type === 'CASTLE')!
    expect(castle.nextUpgrade?.requirementsMet).toBeFalse()
  })
})

describe('GET /api/v1/city/buildings (materialized catalog)', () => {
  it('materializes all 17 types with per-level config data', async () => {
    const res = await catalogGet(authedRequest('/api/v1/city/buildings', viewToken))
    expect(res.status).toBe(200)
    const body = await parse<{
      types: Array<{
        type: string
        maxLevel: number
        levels: Array<{ level: number; cost: Record<string, string>; durationSec: number }>
      }>
    }>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.types.length).toBe(17)
    const farm = body.data.types.find((t) => t.type === 'FARM')!
    expect(farm.levels[1]!.cost).toEqual({ GOLD: '120', WOOD: '100' })
    const castle = body.data.types.find((t) => t.type === 'CASTLE')!
    expect(castle.maxLevel).toBe(11)
    // Costs are display strings (BigInt policy) matching the config authority.
    for (const entry of body.data.types) {
      for (const level of entry.levels) {
        for (const amount of Object.values(level.cost)) {
          expect(typeof amount).toBe('string')
        }
      }
    }
  })
})

// ── 2. UPGRADE FLOW — the full happy path ────────────────────────────────────

describe('POST upgrade — happy path (cost · ledger · construction state)', () => {
  it('debits exactly the catalog cost, appends a BUILDING_UPGRADE ledger row and records the timer', async () => {
    const before = await getWalletBalances(db, upPlayerId)
    const farmBefore = await buildingRow(upPlayerId, 'FARM')

    const res = await upgradePost(
      authedRequest('/api/v1/city/buildings/FARM/upgrade', upToken, 'POST'),
      routeCtx('FARM'),
    )
    expect(res.status).toBe(200)
    const body = await parse<UpgradeResultData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    // Balances after: starter minus the exact catalog cost.
    const cost = upgradeCostFor('FARM', 2)
    expect(body.data.balances['GOLD']).toBe(String(before.GOLD - BigInt(cost['GOLD'] ?? 0)))
    expect(body.data.balances['WOOD']).toBe(String(before.WOOD - BigInt(cost['WOOD'] ?? 0)))
    expect(body.data.balances['FOOD']).toBe(String(before.FOOD))

    // Response building view is CONSTRUCTING toward level 2.
    expect(body.data.building.type).toBe('FARM')
    expect(body.data.building.status).toBe('CONSTRUCTING')
    expect(body.data.building.pendingLevel).toBe(2)
    expect(body.data.building.level).toBe(1)

    // DB construction state: start/finish/status fields recorded.
    const farmAfter = await db.building.findUnique({ where: { id: farmBefore.id } })
    expect(farmAfter?.isConstructing).toBeTrue()
    expect(farmAfter?.pendingLevel).toBe(2)
    expect(farmAfter?.upgradeStartedAt).not.toBeNull()
    const durationMs = upgradeDurationSecFor('FARM', 2) * 1000
    expect(farmAfter!.upgradeCompletesAt!.getTime()).toBeGreaterThan(
      Date.now() + durationMs - 2_000,
    )
    expect(farmAfter!.upgradeCompletesAt!.getTime()).toBeLessThan(Date.now() + durationMs + 2_000)

    // Ledger: one BUILDING_UPGRADE row PER debited resource (GOLD + WOOD),
    // each referencing the building row (ledger = economic truth).
    const ledgerRows = await db.resourceTransaction.findMany({
      where: { playerId: upPlayerId, reason: 'BUILDING_UPGRADE', resource: 'GOLD' },
    })
    expect(ledgerRows.length).toBe(1)
    expect(ledgerRows[0]!.refType).toBe('building')
    expect(ledgerRows[0]!.refId).toBe(farmBefore.id)
    expect(ledgerRows[0]!.delta).toBe(-BigInt(cost['GOLD'] ?? 0))
    const woodRow = await db.resourceTransaction.findFirst({
      where: { playerId: upPlayerId, reason: 'BUILDING_UPGRADE', resource: 'WOOD' },
    })
    expect(woodRow?.delta).toBe(-BigInt(cost['WOOD'] ?? 0))
    expect(woodRow?.refId).toBe(farmBefore.id)
    const metadata = ledgerRows[0]!.metadata as Record<string, unknown>
    expect(metadata['buildingType']).toBe('FARM')
    expect(metadata['fromLevel']).toBe(1)
    expect(metadata['toLevel']).toBe(2)

    // Ledger-first invariant still reconciles after the debit.
    const balances = await getWalletBalances(db, upPlayerId)
    const grouped = await db.resourceTransaction.groupBy({
      by: ['resource'],
      where: { playerId: upPlayerId },
      _sum: { delta: true },
    })
    for (const [resource, balance] of Object.entries(balances)) {
      const sum = grouped.find((g) => g.resource === resource)?._sum.delta ?? 0n
      expect(sum).toBe(balance)
    }
  })

  it('reflects the queue as 1/1 while the construction is in flight', async () => {
    const view = await getCityView(db, upPlayerId)
    expect(view.construction).toEqual({ activeCount: 1, queueSlots: 1 })
    const farm = view.buildings.find((b) => b.type === 'FARM')!
    expect(farm.status).toBe('CONSTRUCTING')
    expect(farm.nextUpgrade).toBeNull() // no second queue on an in-flight building
  })

  it('refuses a second upgrade of the SAME building while constructing', async () => {
    const before = await getWalletBalances(db, upPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({
      where: { playerId: upPlayerId, reason: 'BUILDING_UPGRADE' },
    })

    const err = await expectAppError(
      () => startBuildingUpgrade(upPlayerId, 'FARM'),
      'CONSTRUCTION_IN_PROGRESS',
    )
    expect(err.httpStatus).toBe(409)

    expect(await getWalletBalances(db, upPlayerId)).toEqual(before)
    expect(
      await db.resourceTransaction.count({
        where: { playerId: upPlayerId, reason: 'BUILDING_UPGRADE' },
      }),
    ).toBe(ledgerBefore)
  })

  it('refuses a DIFFERENT building while the queue slot is full (BUILDING_QUEUE_BUSY)', async () => {
    const before = await getWalletBalances(db, upPlayerId)
    const err = await expectAppError(
      () => startBuildingUpgrade(upPlayerId, 'WOOD_MILL'),
      'BUILDING_QUEUE_BUSY',
    )
    expect(err.details?.['slots']).toBe(1)
    expect(await getWalletBalances(db, upPlayerId)).toEqual(before)
  })
})

// ── 3. VALIDATION MATRIX — typed refusals, zero writes ───────────────────────

describe('upgrade validation matrix', () => {
  it('rejects an unknown building type with BUILDING_NOT_FOUND (404)', async () => {
    const res = await upgradePost(
      authedRequest('/api/v1/city/buildings/PAGODA/upgrade', insufToken, 'POST'),
      routeCtx('PAGODA'),
    )
    expect(res.status).toBe(404)
    const body = await parse<unknown>(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('BUILDING_NOT_FOUND')
  })

  it('refuses an upgrade the wallet cannot afford with INSUFFICIENT_* and writes nothing', async () => {
    // Drain GOLD to exactly 1 (server-side spend, the Phase 5 public path).
    await runEconomyTransaction(insufPlayerId, (tx) =>
      spendResources(
        tx,
        insufPlayerId,
        { GOLD: BigInt(STARTER_WALLET.GOLD) - 1n },
        { reason: 'MARKET_PURCHASE' },
      ),
    )
    const before = await getWalletBalances(db, insufPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({
      where: { playerId: insufPlayerId },
    })

    const err = await expectAppError(
      () => startBuildingUpgrade(insufPlayerId, 'FARM'),
      'INSUFFICIENT_GOLD',
    )
    expect(err.httpStatus).toBe(409)
    expect(err.details?.['have']).toBe(1)

    expect(await getWalletBalances(db, insufPlayerId)).toEqual(before)
    expect(await db.resourceTransaction.count({ where: { playerId: insufPlayerId } })).toBe(
      ledgerBefore,
    )
    const farm = await buildingRow(insufPlayerId, 'FARM')
    expect(farm.isConstructing).toBeFalse()
  })

  it('refuses SPY_CENTER with PREREQUISITE_MISSING and the concrete unmet list', async () => {
    const before = await getWalletBalances(db, insufPlayerId)
    const err = await expectAppError(
      () => startBuildingUpgrade(insufPlayerId, 'SPY_CENTER'),
      'PREREQUISITE_MISSING',
    )
    const missing = err.details?.['missing'] as string[]
    expect(missing.join(' ')).toContain('Town Hall level 8')
    expect(await getWalletBalances(db, insufPlayerId)).toEqual(before)
  })

  it('refuses upgrades at the configured max level with MAX_LEVEL_REACHED', async () => {
    // Fixture: push WOOD_MILL to its catalog max (15), then attempt L16.
    const mill = await buildingRow(rollPlayerId, 'WOOD_MILL')
    await db.building.update({ where: { id: mill.id }, data: { level: 15 } })

    const err = await expectAppError(
      () => startBuildingUpgrade(rollPlayerId, 'WOOD_MILL'),
      'MAX_LEVEL_REACHED',
    )
    expect(err.httpStatus).toBe(409)
    // Restore so later rollback fixtures start from a clean WOOD_MILL.
    await db.building.update({ where: { id: mill.id }, data: { level: 1 } })
  })
})

// ── 4. CONSTRUCTION LIFECYCLE — server clock authority ───────────────────────

describe('POST finish — construction lifecycle (start · finish · status)', () => {
  it('refuses an early claim against the server clock (CONSTRUCTION_NOT_COMPLETE)', async () => {
    const res = await finishPost(
      authedRequest('/api/v1/city/buildings/FARM/finish', upToken, 'POST'),
      routeCtx('FARM'),
    )
    expect(res.status).toBe(409)
    const body = await parse<unknown>(res)
    expect(body.ok).toBe(false)
    if (body.ok) return
    expect(body.error.code).toBe('CONSTRUCTION_NOT_COMPLETE')
    const details = body.error.details as { remainingSec: number; completesAt: string }
    expect(details.remainingSec).toBeGreaterThan(0)
    expect(new Date(details.completesAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('applies the level, clears the timers, raises power and notifies — in one claim', async () => {
    const playerBefore = await db.player.findUnique({
      where: { id: upPlayerId },
      select: { power: true },
    })
    const balanceBefore = await getWalletBalances(db, upPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: upPlayerId } })

    await backdateConstruction(upPlayerId, 'FARM')

    const res = await finishPost(
      authedRequest('/api/v1/city/buildings/FARM/finish', upToken, 'POST'),
      routeCtx('FARM'),
    )
    expect(res.status).toBe(200)
    const body = await parse<{ building: BuildingViewData; power: number; newLevel: number }>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    expect(body.data.newLevel).toBe(2)
    expect(body.data.building.status).toBe('IDLE')
    expect(body.data.building.level).toBe(2)
    expect(body.data.building.upgradeCompletesAt).toBeNull()
    expect(body.data.building.pendingLevel).toBeNull()

    // The effect is LIVE: power grew by exactly the FARM weight per level.
    const playerAfter = await db.player.findUnique({
      where: { id: upPlayerId },
      select: { power: true },
    })
    expect(Number(playerAfter!.power) - Number(playerBefore!.power)).toBe(
      POWER.buildingWeight['FARM'],
    )

    // A claim moves NO resources and appends NO ledger rows.
    expect(await getWalletBalances(db, upPlayerId)).toEqual(balanceBefore)
    expect(await db.resourceTransaction.count({ where: { playerId: upPlayerId } })).toBe(
      ledgerBefore,
    )

    // The completion notice is ENQUEUED in the same transaction (Phase 22
    // engine) — the inbox row lands when the worker drains the queue.
    const farmRow = await db.building.findFirst({
      where: { city: { playerId: upPlayerId }, type: 'FARM' },
    })
    expect(farmRow).not.toBeNull()
    const queued = await db.notificationQueue.findUnique({
      where: {
        playerId_type_dedupeKey: {
          playerId: upPlayerId,
          type: 'CONSTRUCTION_COMPLETE',
          dedupeKey: `construction:${farmRow!.id}:${body.data.newLevel}`,
        },
      },
    })
    expect(queued).not.toBeNull()
    expect(queued!.status).toBe('PENDING')

    const drain = await drainNotificationQueue({ workerId: 'city-test' })
    expect(drain.sent).toBeGreaterThanOrEqual(1)

    const notifications = await db.notification.findMany({
      where: { playerId: upPlayerId, type: 'CONSTRUCTION_COMPLETE' },
    })
    expect(notifications.length).toBe(1)
    expect(notifications[0]!.body).toContain('level 2')
    expect(notifications[0]!.title).toContain('Farm')
  })

  it('retries of the same claim are typed CONSTRUCTION_NOT_ACTIVE (level applied once)', async () => {
    const farm = await buildingRow(upPlayerId, 'FARM')
    expect(farm.level).toBe(2)
    expect(farm.isConstructing).toBeFalse()

    const err = await expectAppError(
      () => finishBuildingUpgrade(upPlayerId, 'FARM'),
      'CONSTRUCTION_NOT_ACTIVE',
    )
    expect(err.httpStatus).toBe(409)

    // The level was applied exactly once — no double-application possible.
    const farmAfter = await db.building.findUnique({ where: { id: farm.id } })
    expect(farmAfter?.level).toBe(2)
  })

  it('frees the queue slot: the next upgrade preview is live with level-2 effects', async () => {
    const view = await getCityView(db, upPlayerId)
    expect(view.construction.activeCount).toBe(0)
    const farm = view.buildings.find((b) => b.type === 'FARM')!
    expect(farm.nextUpgrade?.toLevel).toBe(3)
    // Level-2 effects are live in the aggregate view (60 × 2 food/h).
    expect(view.production.FOOD).toBe(120)
  })

  it('refuses a finish on an idle building (CONSTRUCTION_NOT_ACTIVE)', async () => {
    const err = await expectAppError(
      () => finishBuildingUpgrade(upPlayerId, 'WOOD_MILL'),
      'CONSTRUCTION_NOT_ACTIVE',
    )
    expect(err.httpStatus).toBe(409)
  })

  it('concurrent finish claims converge: exactly one applies, the rest refuse', async () => {
    // Start a construction on the finish fixture player, backdate it, then
    // fire 5 parallel claims — the conditional guard lets exactly one win.
    await startBuildingUpgrade(finPlayerId, 'WOOD_MILL')
    await backdateConstruction(finPlayerId, 'WOOD_MILL')

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => finishBuildingUpgrade(finPlayerId, 'WOOD_MILL')),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(4)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError)
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe('CONSTRUCTION_NOT_ACTIVE')
    }

    const mine = await buildingRow(finPlayerId, 'WOOD_MILL')
    expect(mine.level).toBe(2)
    expect(mine.isConstructing).toBeFalse()
  })
})

// ── 5. DOUBLE-SPENDING — concurrent starters behind the mutex ────────────────

describe('double-spending protection (concurrency)', () => {
  it('serializes N parallel upgrades of one building: cost debited exactly once', async () => {
    const before = await getWalletBalances(db, concPlayerId)
    const cost = upgradeCostFor('BARRACKS', 2)

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => startBuildingUpgrade(concPlayerId, 'BARRACKS')),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(7)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError)
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe(
        'CONSTRUCTION_IN_PROGRESS',
      )
    }

    // Exactly ONE cost debit — the double-spend is impossible.
    const after = await getWalletBalances(db, concPlayerId)
    expect(after.GOLD).toBe(before.GOLD - BigInt(cost['GOLD'] ?? 0))
    expect(after.WOOD).toBe(before.WOOD - BigInt(cost['WOOD'] ?? 0))
    expect(after.GOLD >= 0n).toBeTrue()

    // One ledger row per debited resource (BARRACKS costs GOLD + WOOD).
    expect(
      await db.resourceTransaction.count({
        where: { playerId: concPlayerId, reason: 'BUILDING_UPGRADE' },
      }),
    ).toBe(2)
    expect(
      await db.resourceTransaction.count({
        where: { playerId: concPlayerId, reason: 'BUILDING_UPGRADE', resource: 'GOLD' },
      }),
    ).toBe(1)

    const barracks = await buildingRow(concPlayerId, 'BARRACKS')
    expect(barracks.isConstructing).toBeTrue()
    expect(barracks.pendingLevel).toBe(2)
  })

  it('serializes parallel DIFFERENT buildings onto the single queue slot', async () => {
    // FARM + WOOD_MILL (both TH-gate 1) race for the one free slot: exactly
    // one wins, the loser hits BUILDING_QUEUE_BUSY — debits == successes.
    const before = await getWalletBalances(db, concQueuePlayerId)
    const farmCost = upgradeCostFor('FARM', 2)
    const millCost = upgradeCostFor('WOOD_MILL', 2)

    const results = await Promise.allSettled([
      startBuildingUpgrade(concQueuePlayerId, 'FARM'),
      startBuildingUpgrade(concQueuePlayerId, 'WOOD_MILL'),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
    expect(((rejected[0] as PromiseRejectedResult).reason as AppError).code).toBe(
      'BUILDING_QUEUE_BUSY',
    )

    const after = await getWalletBalances(db, concQueuePlayerId)
    const goldDelta = before.GOLD - after.GOLD
    // Exactly one first-upgrade debit happened (FARM 120 / WOOD_MILL 140 gold).
    expect([BigInt(farmCost['GOLD'] ?? 0), BigInt(millCost['GOLD'] ?? 0)]).toContain(goldDelta)
    // One success = two debited resources = two ledger rows.
    expect(
      await db.resourceTransaction.count({
        where: { playerId: concQueuePlayerId, reason: 'BUILDING_UPGRADE' },
      }),
    ).toBe(2)
  })
})

// ── 6. TRANSACTION ROLLBACK — crash mid-upgrade persists nothing ─────────────

describe('transaction rollback', () => {
  it('rolls back cost + timer + ledger when the caller transaction crashes after the start', async () => {
    const before = await getWalletBalances(db, rollPlayerId)
    const ledgerBefore = await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })
    const mine = await buildingRow(rollPlayerId, 'WOOD_MILL')

    await db
      .$transaction(async (tx) => {
        await startBuildingUpgradeInTx(tx, rollPlayerId, 'WOOD_MILL')
        throw new Error('simulated crash after construction start')
      })
      .catch(() => {}) // the crash is the test

    expect(await getWalletBalances(db, rollPlayerId)).toEqual(before)
    expect(await db.resourceTransaction.count({ where: { playerId: rollPlayerId } })).toBe(
      ledgerBefore,
    )
    const mineAfter = await db.building.findUnique({ where: { id: mine.id } })
    expect(mineAfter?.isConstructing).toBeFalse()
    expect(mineAfter?.pendingLevel).toBeNull()
    expect(mineAfter?.upgradeCompletesAt).toBeNull()
  })

  it('rolls back the finish claim (level, power, notification) on a caller crash', async () => {
    await startBuildingUpgrade(rollPlayerId, 'WOOD_MILL')
    await backdateConstruction(rollPlayerId, 'WOOD_MILL')
    const playerBefore = await db.player.findUnique({
      where: { id: rollPlayerId },
      select: { power: true },
    })

    await db
      .$transaction(async (tx) => {
        await finishBuildingUpgradeInTx(tx, rollPlayerId, 'GOLD_MINE')
        throw new Error('simulated crash after finish claim')
      })
      .catch(() => {})

    const mine = await buildingRow(rollPlayerId, 'WOOD_MILL')
    expect(mine.level).toBe(1)
    expect(mine.isConstructing).toBeTrue() // the claim rolled back — still in flight
    expect(mine.pendingLevel).toBe(2)
    const playerAfter = await db.player.findUnique({
      where: { id: rollPlayerId },
      select: { power: true },
    })
    expect(playerAfter!.power).toBe(playerBefore!.power)
    expect(
      await db.notification.count({
        where: { playerId: rollPlayerId, type: 'CONSTRUCTION_COMPLETE' },
      }),
    ).toBe(0)
  })
})

// ── 7. UNAUTHORIZED — auth gates + module surface + isolation ────────────────

describe('unauthorized access protection', () => {
  it('rejects anonymous requests on all four endpoints with 401', async () => {
    for (const [handler, path] of [
      [cityGet, '/api/v1/city'],
      [catalogGet, '/api/v1/city/buildings'],
    ] as Array<[typeof cityGet, string]>) {
      const res = await handler(new Request(`http://localhost:3000${path}`))
      expect(res.status).toBe(401)
    }
    for (const handler of [upgradePost, finishPost]) {
      // Well-formed params: an anonymous caller must hit the auth gate (401),
      // not the schema (validation precedes auth inside the handler body).
      const res = await handler(
        new Request('http://localhost:3000/api/v1/city/buildings/FARM/upgrade', {
          method: 'POST',
        }),
        routeCtx('FARM'),
      )
      expect(res.status).toBe(401)
    }
    const garbage = await upgradePost(
      new Request('http://localhost:3000/api/v1/city/buildings/FARM/upgrade', {
        method: 'POST',
        headers: { authorization: 'Bearer garbage' },
      }),
      routeCtx('FARM'),
    )
    expect(garbage.status).toBe(401)
  })

  it('exposes exactly the intended verbs per route module', () => {
    expect(
      Object.keys(cityRouteModule)
        .filter((k) => k === k.toUpperCase())
        .sort(),
    ).toEqual(['GET'])
    expect(
      Object.keys(catalogRouteModule)
        .filter((k) => k === k.toUpperCase())
        .sort(),
    ).toEqual(['GET'])
    expect(
      Object.keys(upgradeRouteModule)
        .filter((k) => k === k.toUpperCase())
        .sort(),
    ).toEqual(['POST'])
    expect(
      Object.keys(finishRouteModule)
        .filter((k) => k === k.toUpperCase())
        .sort(),
    ).toEqual(['POST'])
  })

  it('keeps players isolated: B starts construction without touching A', async () => {
    const aFarmBefore = await buildingRow(isoAPlayerId, 'FARM')
    const aWalletBefore = await getWalletBalances(db, isoAPlayerId)

    // B upgrades HIS OWN farm through the route.
    const res = await upgradePost(
      authedRequest('/api/v1/city/buildings/FARM/upgrade', isoBToken, 'POST'),
      routeCtx('FARM'),
    )
    expect(res.status).toBe(200)

    // A is untouched — rows, wallet, construction state.
    const aFarmAfter = await db.building.findUnique({ where: { id: aFarmBefore.id } })
    expect(aFarmAfter?.isConstructing).toBeFalse()
    expect(aFarmAfter?.level).toBe(aFarmBefore.level)
    expect(await getWalletBalances(db, isoAPlayerId)).toEqual(aWalletBefore)

    // B's city view only ever contains B's own rows.
    const bViewRes = await cityGet(authedRequest('/api/v1/city', isoBToken))
    const bView = await parse<CityViewData>(bViewRes)
    expect(bView.ok).toBe(true)
    if (bView.ok) {
      const aCity = await db.city.findUnique({ where: { playerId: isoAPlayerId } })
      expect(bView.data.city.id).not.toBe(aCity?.id)
      expect(bView.data.buildings.find((b) => b.type === 'FARM')?.isConstructing).toBeTrue()
    }
  })
})
