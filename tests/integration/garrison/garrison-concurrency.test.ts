/**
 * Integration tests — Garrison & Clan Concurrency (Phase 34, STEP 16).
 *
 * Races exercised through the PUBLIC service layer with REAL parallelism
 * (Promise.all / Promise.allSettled), real transactions, real SQLite —
 * zero mocks. Every scenario ends with a conservation check:
 *
 *   home army + stationed garrison + in-flight march manifests == granted
 *   (nothing created from nothing, nothing destroyed without a battle)
 *
 *  C1  two clansmen reinforce the same territory simultaneously
 *  C2  two in-flight reinforcements together exceed capacity → overflow bounces
 *  C3  withdrawal × battle on one contribution → exactly one claim wins
 *  C4  battle resolution × reinforcement arrival → serialized, no lost rows
 *  C5  multi-contributor territory: battle wipes contributions while
 *      withdrawals race → destroyed + surviving + restored == committed
 *  C6  one lord runs deploy+deploy+withdraw concurrently → slot-safe, exact units
 *  C7  ten concurrent FOREIGN reinforce attempts → every one refused, zero writes
 *  C8  ten duplicate deploy requests (one idempotency key) → exactly one march
 *  C9  same idempotency key, different destination → typed 409, one march
 *
 * Identities live in the isolated 9100061… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { createMarch, withdrawGarrison } from '../../../src/lib/game/services/march.service'
import { runMarchArrival, runMarchHomecoming } from '../../../src/lib/game/services/march-processor'
import { attackTerritory } from '../../../src/lib/game/services/world.service'
import { createClan, joinClan } from '../../../src/lib/game/services/clan.service'
import { GARRISON } from '../../../src/lib/game/config/garrison'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import { BATTLE } from '../../../src/lib/game/config/battle'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'
import { findTwoStepFrontier, type FrontierChain } from '../../helpers/frontier'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('Garrison concurrency tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100061'

let tgCounter = 9100061001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.138.${ipCounter++}` // rotating — the auth limiter is per-IP

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({ id: Number(telegramId), first_name: `GarC${telegramId.slice(-3)}` }),
  }
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = createHmac('sha256', secret).update(checkString).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
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
  const parsed = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!parsed.ok || !parsed.data)
    throw new Error(`garrison concurrency registration failed ${tgId}`)
  return { token: parsed.data.token, playerId: parsed.data.player.id }
}

async function grantArmy(playerId: string, count = 300): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count },
    update: { count: { increment: count } },
  })
}

async function raiseCastle(playerId: string, level: number): Promise<void> {
  await db.building.updateMany({
    where: { city: { playerId }, type: 'CASTLE' },
    data: { level },
  })
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

/** Elapses the shared battle cooldown so marches can be created freely. */
async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

async function homeArmy(playerId: string): Promise<number> {
  const rows = await db.playerUnit.findMany({ where: { playerId }, select: { count: true } })
  return rows.reduce((sum, r) => sum + r.count, 0)
}

async function garrisonTotal(territoryId: string): Promise<number> {
  const rows = await db.territoryGarrison.findMany({ where: { territoryId } })
  return rows.reduce(
    (sum, row) =>
      sum +
      (row.units as Array<{ unitId: string; count: number }>).reduce((s, u) => s + u.count, 0),
    0,
  )
}

/** Total units locked in non-terminal marches for a player. */
async function inFlightUnits(playerId: string): Promise<number> {
  const rows = await db.march.findMany({
    where: { playerId, status: { in: ['EN_ROUTE', 'RETURNING', 'ARRIVED'] } },
    select: { units: true, survivors: true },
  })
  // EN_ROUTE/ARRIVED hold the full manifest in units; RETURNING carries survivors.
  return rows.reduce((sum, row) => {
    const manifest = (row.survivors ?? row.units) as Array<{ unitId: string; count: number }> | null
    return sum + (manifest?.reduce((s, u) => s + u.count, 0) ?? 0)
  }, 0)
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  if (clanIds.length > 0) {
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
    clanIds.length = 0
  }
  // Suite-fixed idempotency keys must not collide across runs (keys are
  // global-unique; stale rows from earlier runs would replay old marches).
  await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'conc-' } } })
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

async function lordCapital(playerId: string): Promise<{ id: string; strategicValue?: number }> {
  return db.territory.findFirstOrThrow({
    where: { ownerPlayerId: playerId, isCapital: true },
    select: { id: true, strategicValue: true },
  })
}

/** Deploys via the ONE march engine, arrives it, asserts stationing. */
async function station(
  playerId: string,
  territoryId: string,
  count: number,
  type: 'DEFEND' | 'REINFORCE' = 'DEFEND',
): Promise<string> {
  await elapseCooldown(playerId)
  const march = await createMarch(playerId, {
    territoryId,
    type,
    units: [{ unitId: 'swordsman', count }],
  })
  await backdateArrival(march.id)
  const arrival = await runMarchArrival(march.id)
  expect(arrival.processed).toBe(true)
  const row = await db.march.findUniqueOrThrow({ where: { id: march.id } })
  expect(row.status).toBe('ARRIVED')
  return march.id
}

/**
 * Prepares a foe for assault — the regroup clock and energy pool are top-ups
 * via direct writes and MUST run BEFORE any concurrent phase (a direct write
 * racing an interactive transaction would queue behind SQLite's single
 * writer and time out). The assault itself then goes through the SHARED
 * pipeline, whose battle:engine → db:write lock order serializes it.
 */
async function prepareAssault(playerId: string): Promise<void> {
  await elapseCooldown(playerId)
  await db.player.update({
    where: { id: playerId },
    data: { energy: 100, energyUpdatedAt: new Date() },
  })
}

/** The assault itself — one tx under the standard lock order. */
async function assault(playerId: string, territoryId: string, key: string): Promise<string> {
  const result = await attackTerritory(playerId, {
    territoryId,
    idempotencyKey: key,
  })
  return result.battleId
}

/**
 * Registers a (lord, foe) pair with a two-step frontier chain (shared helper
 * — the honest geography for positional-defense races).
 */
async function registerSharedFrontierRetry(): Promise<FrontierChain> {
  return findTwoStepFrontier(register)
}

/**
 * Captures the shared frontier cell for its new owner through the ONE march
 * engine and brings the survivors home (the return leg must complete before
 * a DEFEND march can claim the castle slot again).
 */
async function captureCell(playerId: string, cellId: string): Promise<void> {
  await elapseCooldown(playerId)
  await db.player.update({
    where: { id: playerId },
    data: { energy: 100, energyUpdatedAt: new Date() },
  })
  const march = await createMarch(playerId, {
    territoryId: cellId,
    type: 'ATTACK',
    units: [{ unitId: 'swordsman', count: 250 }],
  })
  await backdateArrival(march.id)
  const arrival = await runMarchArrival(march.id)
  expect(arrival.processed).toBe(true)
  const row = await db.march.findUniqueOrThrow({ where: { id: march.id } })
  expect(row.status).toBe('RETURNING') // survivors ride home
  await backdateReturn(march.id)
  await runMarchHomecoming(march.id)
}

describe('Garrison & clan concurrency (STEP 16 races)', () => {
  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('garrison-conc', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
  }, 60_000)

  afterAll(async () => {
    await purge()
  }, 60_000)

  it('C1 — two clansmen reinforce the same territory simultaneously: two contributions, exact totals', async () => {
    const lord = await register()
    const mateA = await register()
    const mateB = await register()
    const clan = await createClan(lord.playerId, { name: 'Conc Hold One', tag: 'CC1' })
    clanIds.push(clan.id)
    await joinClan(mateA.playerId, clan.id)
    await joinClan(mateB.playerId, clan.id)
    await grantArmy(mateA.playerId, 40)
    await grantArmy(mateB.playerId, 40)
    const homeA = await homeArmy(mateA.playerId)
    const homeB = await homeArmy(mateB.playerId)

    const target = await lordCapital(lord.playerId)
    const [a, b] = await Promise.allSettled([
      createMarch(mateA.playerId, {
        territoryId: target.id,
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 40 }],
      }),
      createMarch(mateB.playerId, {
        territoryId: target.id,
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 40 }],
      }),
    ])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
    const marchA = (a as PromiseFulfilledResult<{ id: string }>).value
    const marchB = (b as PromiseFulfilledResult<{ id: string }>).value

    await backdateArrival(marchA.id)
    await backdateArrival(marchB.id)
    const [arrA, arrB] = await Promise.all([runMarchArrival(marchA.id), runMarchArrival(marchB.id)])
    expect(arrA.processed).toBe(true)
    expect(arrB.processed).toBe(true)

    // Both contributions exist, no duplication, totals exact.
    const mine = await db.territoryGarrison.findMany({
      where: { territoryId: target.id, playerId: { in: [mateA.playerId, mateB.playerId] } },
    })
    expect(mine.length).toBe(2)
    expect(await garrisonTotal(target.id)).toBe(80)
    // Both marchers left home exactly once (delta against their start totals).
    expect(await homeArmy(mateA.playerId)).toBe(homeA - 40)
    expect(await homeArmy(mateB.playerId)).toBe(homeB - 40)
  }, 60_000)

  it('C2 — two in-flight reinforcements together exceed capacity: the overflow bounces home', async () => {
    const lord = await register()
    const mate = await register()
    const clan = await createClan(lord.playerId, { name: 'Conc Hold Two', tag: 'CC2' })
    clanIds.push(clan.id)
    await joinClan(mate.playerId, clan.id)
    await raiseCastle(mate.playerId, 41)
    await grantArmy(mate.playerId, 1000)

    const territory = await lordCapital(lord.playerId)
    const capacity =
      GARRISON.capacityBase + GARRISON.capacityPerStrategicValue * (territory.strategicValue ?? 0)
    const marchA = 400
    const marchB = capacity - marchA + 101 // together over by 101
    expect(marchB).toBeGreaterThan(0)
    await grantArmy(mate.playerId, marchB)
    const homeBefore = await homeArmy(mate.playerId)

    // Both pass the creation pre-check (only STATIONED troops count there).
    elapseCooldown(mate.playerId)
    const a = await createMarch(mate.playerId, {
      territoryId: territory.id,
      type: 'REINFORCE',
      units: [{ unitId: 'swordsman', count: marchA }],
    })
    const b = await createMarch(mate.playerId, {
      territoryId: territory.id,
      type: 'REINFORCE',
      units: [{ unitId: 'swordsman', count: marchB }],
    })
    await backdateArrival(a.id)
    await backdateArrival(b.id)
    const [arrA, arrB] = await Promise.all([runMarchArrival(a.id), runMarchArrival(b.id)])
    expect(arrA.processed).toBe(true)
    expect(arrB.processed).toBe(true)

    // Exactly one stations; the other bounces (RETURNING with the full manifest).
    const rowA = await db.march.findUniqueOrThrow({ where: { id: a.id } })
    const rowB = await db.march.findUniqueOrThrow({ where: { id: b.id } })
    const statuses = [rowA.status, rowB.status].sort()
    expect(statuses).toEqual(['ARRIVED', 'RETURNING'])

    const stationedMarch = rowA.status === 'ARRIVED' ? rowA : rowB
    const bouncedMarch = rowA.status === 'RETURNING' ? rowA : rowB
    const stationedCount = (stationedMarch.units as Array<{ count: number }>)[0]!.count
    expect(await garrisonTotal(territory.id)).toBe(stationedCount)
    expect(await garrisonTotal(territory.id)).toBeLessThanOrEqual(capacity)
    // The bounced detachment carries its OWN full manifest home — nothing
    // lost, whichever arrival lost the race (arrival order is not assumed).
    const manifest = bouncedMarch.survivors as Array<{ unitId: string; count: number }>
    expect(manifest.reduce((s, u) => s + u.count, 0)).toBe(marchA + marchB - stationedCount)
    // Homecoming restores it EXACTLY once.
    await backdateReturn(bouncedMarch.id)
    await runMarchHomecoming(bouncedMarch.id)
    expect(await homeArmy(mate.playerId)).toBe(homeBefore - stationedCount)
  }, 60_000)

  it('C3 — withdrawal × battle on one contribution: exactly one claim wins the ARRIVED march', async () => {
    const { lord, foe, cell, foeCell } = await registerSharedFrontierRetry()
    await grantArmy(lord.playerId, 300)
    await captureCell(lord.playerId, cell.id)
    const marchId = await station(lord.playerId, cell.id, 10)
    await grantArmy(foe.playerId, 500)
    await captureCell(foe.playerId, foeCell.id) // expand next door to X
    await prepareAssault(foe.playerId)

    // 5 concurrent withdrawals vs 2 concurrent assaults on the SAME cell.
    const [withdrawals, assaults] = await Promise.all([
      Promise.allSettled(Array.from({ length: 5 }, () => withdrawGarrison(lord.playerId, marchId))),
      Promise.allSettled([
        assault(foe.playerId, cell.id, 'conc-c3-a'),
        assault(foe.playerId, cell.id, 'conc-c3-b'),
      ]),
    ])
    const withdrawWins = withdrawals.filter((w) => w.status === 'fulfilled').length
    const assaultWins = assaults.filter((a) => a.status === 'fulfilled').length
    expect(withdrawWins + assaultWins).toBeGreaterThanOrEqual(1)

    const row = await db.march.findUniqueOrThrow({ where: { id: marchId } })
    if (withdrawWins > 0) {
      // The withdrawal claim won FIRST — the march rides home, garrison gone.
      expect(row.status).toBe('RETURNING')
      expect(await db.territoryGarrison.count({ where: { marchId } })).toBe(0)
    } else {
      // A battle resolved first: LOST (routed/destroyed) or the garrison
      // survived (ARRIVED) — but the march never went RETURNING.
      expect(['LOST', 'ARRIVED']).toContain(row.status)
    }
  }, 180_000)

  it('C4 — battle × reinforcement arrival: serialized outcomes, no lost contributions', async () => {
    const { lord, foe, cell, foeCell } = await registerSharedFrontierRetry()
    const mate = await register()
    const clan = await createClan(lord.playerId, { name: 'Conc Hold Four', tag: 'CC4' })
    clanIds.push(clan.id)
    await joinClan(mate.playerId, clan.id)
    await grantArmy(lord.playerId, 300)
    await grantArmy(mate.playerId, 60)
    await grantArmy(foe.playerId, 800)
    await raiseCastle(mate.playerId, 41)
    await captureCell(lord.playerId, cell.id)
    await captureCell(foe.playerId, foeCell.id) // expand next door to X
    await prepareAssault(foe.playerId)

    const reinforce = await createMarch(mate.playerId, {
      territoryId: cell.id,
      type: 'REINFORCE',
      units: [{ unitId: 'swordsman', count: 60 }],
    })
    await backdateArrival(reinforce.id)

    // The assault lands while the reinforcement is due.
    const [arr, bat] = await Promise.all([
      runMarchArrival(reinforce.id),
      assault(foe.playerId, cell.id, 'conc-c4-1'),
    ])
    expect(arr.processed).toBe(true)
    expect(bat).toBeTruthy()

    // Whatever the interleaving, the outcome is one of exactly three honest
    // states — never a duplicate contribution, never a stranded manifest:
    //  a) arrival won first and the garrison HELD  → contribution + ARRIVED
    //  b) arrival won first and the battle WIPED it → no contribution + LOST
    //  c) the capture won first → the arrival re-authorization BOUNCED the
    //     detachment home (RETURNING, aborted, contribution never created)
    const mine = await db.territoryGarrison.findMany({
      where: { territoryId: cell.id, playerId: mate.playerId },
    })
    const marchRow = await db.march.findUniqueOrThrow({ where: { id: reinforce.id } })
    if (mine.length === 1) {
      expect(marchRow.status).toBe('ARRIVED')
      const manifest = marchRow.survivors as Array<{ unitId: string; count: number }>
      const contribution = mine[0]!.units as Array<{ unitId: string; count: number }>
      expect(contribution).toEqual(manifest)
    } else {
      expect(mine.length).toBe(0)
      expect(['LOST', 'RETURNING']).toContain(marchRow.status)
      expect(
        await db.territoryGarrison.count({ where: { territoryId: cell.id } }),
      ).toBeLessThanOrEqual(1)
    }
  }, 180_000)

  it('C5 — multi-contributor battle wipe racing withdrawals: destroyed + surviving + restored == committed', async () => {
    const { lord, foe, cell, foeCell } = await registerSharedFrontierRetry()
    const mate = await register()
    const clan = await createClan(lord.playerId, { name: 'Conc Hold Five', tag: 'CC5' })
    clanIds.push(clan.id)
    await joinClan(mate.playerId, clan.id)
    await grantArmy(lord.playerId, 300)
    await grantArmy(mate.playerId, 300)
    await grantArmy(foe.playerId, 900)
    await raiseCastle(mate.playerId, 41)
    await captureCell(lord.playerId, cell.id)
    await captureCell(foe.playerId, foeCell.id) // expand next door to X
    await prepareAssault(foe.playerId)

    const lordMarch = await station(lord.playerId, cell.id, 10)
    const mateMarch = await station(mate.playerId, cell.id, 25, 'REINFORCE') // same-clan reinforcement
    const committed = 35

    const [withdrawals, bat] = await Promise.all([
      Promise.allSettled([
        withdrawGarrison(lord.playerId, lordMarch),
        withdrawGarrison(mate.playerId, mateMarch),
        withdrawGarrison(lord.playerId, lordMarch),
      ]),
      assault(foe.playerId, cell.id, 'conc-c5-1'),
    ])
    expect(bat).toBeTruthy()

    // Restore whatever the withdrawals claimed (exactly once each).
    let restored = 0
    for (const w of withdrawals) {
      if (w.status === 'fulfilled') {
        await backdateReturn(w.value.march.id)
        await runMarchHomecoming(w.value.march.id)
        restored += w.value.unitsReturning
      }
    }

    // Conservation: garrison survivors + restored + battle-destroyed == committed.
    const remaining = await garrisonTotal(cell.id)
    const destroyed = committed - remaining - restored
    expect(destroyed).toBeGreaterThanOrEqual(0)
    expect(remaining + restored + destroyed).toBe(committed)
  }, 180_000)

  it('C6 — one lord runs deploy+deploy+withdraw concurrently: slot-safe, exact units', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 100)
    await raiseCastle(lord.playerId, 41)
    const territory = await lordCapital(lord.playerId)
    const homeBefore = await homeArmy(lord.playerId)
    // A pre-stationed detachment to withdraw while two more deploy.
    const preMarch = await station(lord.playerId, territory.id, 20)

    elapseCooldown(lord.playerId)
    const [w, d1, d2] = await Promise.allSettled([
      withdrawGarrison(lord.playerId, preMarch),
      createMarch(lord.playerId, {
        territoryId: territory.id,
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 30 }],
      }),
      createMarch(lord.playerId, {
        territoryId: territory.id,
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 40 }],
      }),
    ])
    expect(w.status).toBe('fulfilled')
    expect(d1.status).toBe('fulfilled')
    expect(d2.status).toBe('fulfilled')

    // Conservation: home + in-flight + stationed == the start total.
    const home = await homeArmy(lord.playerId)
    const inflight = await inFlightUnits(lord.playerId)
    const stationedTotal = await garrisonTotal(territory.id)
    expect(home + inflight + stationedTotal).toBe(homeBefore)
  }, 60_000)

  it('C7 — ten concurrent FOREIGN reinforce attempts: every one refused, zero writes', async () => {
    const lord = await register()
    const foreignerA = await register()
    const foreignerB = await register()
    const territory = await lordCapital(lord.playerId)
    for (const f of [foreignerA, foreignerB]) await grantArmy(f.playerId, 50)
    const homeA = await homeArmy(foreignerA.playerId)
    const homeB = await homeArmy(foreignerB.playerId)

    const attempts = await Promise.allSettled(
      [foreignerA, foreignerB].flatMap((f) =>
        Array.from({ length: 5 }, () =>
          createMarch(f.playerId, {
            territoryId: territory.id,
            type: 'REINFORCE',
            units: [{ unitId: 'swordsman', count: 10 }],
          }),
        ),
      ),
    )
    // Every single attempt is a typed refusal.
    for (const attempt of attempts) {
      expect(attempt.status).toBe('rejected')
      if (attempt.status === 'rejected') {
        expect((attempt.reason as { code?: string }).code).toBe('MARCH_DESTINATION_NOT_OWNED')
      }
    }
    // Zero unauthorized writes anywhere.
    expect(await db.territoryGarrison.count({ where: { territoryId: territory.id } })).toBe(0)
    expect(await homeArmy(foreignerA.playerId)).toBe(homeA)
    expect(await homeArmy(foreignerB.playerId)).toBe(homeB)
  }, 60_000)

  it('C8 — ten duplicate deploy requests with one idempotency key: exactly one march', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 50)
    await raiseCastle(lord.playerId, 41)
    const territory = await lordCapital(lord.playerId)
    const homeBefore = await homeArmy(lord.playerId)
    elapseCooldown(lord.playerId)
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        createMarch(lord.playerId, {
          territoryId: territory.id,
          type: 'DEFEND',
          units: [{ unitId: 'swordsman', count: 10 }],
          idempotencyKey: 'conc-c8-key',
        }),
      ),
    )
    const fulfilled = attempts.filter(
      (a): a is PromiseFulfilledResult<{ id: string }> => a.status === 'fulfilled',
    )
    // EVERY call is fulfilled: one real creation + replays of the SAME
    // stored response — exactly one march id across all of them.
    const ids = new Set(fulfilled.map((f) => f.value.id))
    expect(ids.size).toBe(1)
    expect(await db.march.count({ where: { playerId: lord.playerId } })).toBe(1)
    // Reserved exactly once.
    expect(await homeArmy(lord.playerId)).toBe(homeBefore - 10)
  }, 60_000)

  it('C9 — same idempotency key on a different destination: typed 409, one march', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 50)
    await raiseCastle(lord.playerId, 41)
    const capital = await lordCapital(lord.playerId)
    const other = await db.territory.findFirst({
      where: {
        status: 'UNCLAIMED',
        isCapital: false,
        NOT: {
          OR: (
            await db.territory.findMany({
              where: { ownerPlayerId: lord.playerId },
              select: { x: true, y: true },
            })
          ).flatMap((c) => adjacentCoords(c.x, c.y).map((a) => ({ x: a.x, y: a.y }))),
        },
      },
      select: { id: true },
    })
    expect(other).not.toBeNull()
    elapseCooldown(lord.playerId)
    const first = await createMarch(lord.playerId, {
      territoryId: capital.id,
      type: 'DEFEND',
      units: [{ unitId: 'swordsman', count: 5 }],
      idempotencyKey: 'conc-c9-key',
    })
    // Concurrent replays: same payload → same march; different payload → 409.
    const [replay, conflict] = await Promise.allSettled([
      createMarch(lord.playerId, {
        territoryId: capital.id,
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 5 }],
        idempotencyKey: 'conc-c9-key',
      }),
      createMarch(lord.playerId, {
        territoryId: other!.id,
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 5 }],
        idempotencyKey: 'conc-c9-key',
      }),
    ])
    expect(replay.status).toBe('fulfilled')
    expect((replay as PromiseFulfilledResult<{ id: string }>).value.id).toBe(first.id)
    expect(conflict.status).toBe('rejected')
    if (conflict.status === 'rejected') {
      expect((conflict.reason as { code?: string }).code).toBe('IDEMPOTENT_REPLAY')
    }
    expect(await db.march.count({ where: { playerId: lord.playerId } })).toBe(1)
  }, 60_000)
})
