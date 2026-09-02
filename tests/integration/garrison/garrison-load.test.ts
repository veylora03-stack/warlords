/**
 * Integration tests — Garrison & Clan Load (Phase 34, STEP 25): REAL
 * measurements, no claims without numbers.
 *
 * Surfaces measured:
 *  - CLAN CREATION: 20 sequential creates through the full clan service
 *  - GARRISON VIEW: 25 parallel public reads of a garrisoned territory
 *  - DEPLOY PIPELINE: 10 sequential DEFEND marches (create + arrival +
 *    stationing) with per-deploy latency
 *  - MULTI-CONTRIBUTOR: 19 same-clan reinforcements stacking onto ONE
 *    territory (the maxContributionsPerTerritory ceiling), the aggregated
 *    view read, and one full assault against the stacked garrison
 *  - PARALLEL DEPLOYS: 10 simultaneous march creations — no deadlock,
 *    conservation intact
 *
 * Identities live in the isolated 9100062… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { createMarch } from '../../../src/lib/game/services/march.service'
import { runMarchArrival, runMarchHomecoming } from '../../../src/lib/game/services/march-processor'
import { getTerritoryGarrisonView } from '../../../src/lib/game/services/garrison.service'
import { attackTerritory } from '../../../src/lib/game/services/world.service'
import { createClan, joinClan } from '../../../src/lib/game/services/clan.service'
import { GARRISON } from '../../../src/lib/game/config/garrison'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'
import { findTwoStepFrontier } from '../../helpers/frontier'
import { BATTLE } from '../../../src/lib/game/config/battle'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('Garrison load tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100062'

let tgCounter = 9100062001
const nextTgId = (): string => String(tgCounter++)
let ipCounter = 1
const nextIp = (): string => `203.0.139.${ipCounter++}`

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAELG0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({ id: Number(telegramId), first_name: `GarL${telegramId.slice(-3)}` }),
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
  if (!parsed.ok || !parsed.data) throw new Error(`garrison load registration failed ${tgId}`)
  return { token: parsed.data.token, playerId: parsed.data.player.id }
}

async function grantArmy(playerId: string, count: number): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count },
    update: { count: { increment: count } },
  })
}

const clanIds: string[] = []

async function purge(): Promise<void> {
  if (clanIds.length > 0) {
    await db.clanMember.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clanInvitation.deleteMany({ where: { clanId: { in: [...clanIds] } } })
    await db.clan.deleteMany({ where: { id: { in: [...clanIds] } } })
    clanIds.length = 0
  }
  await db.idempotencyKey.deleteMany({ where: { key: { startsWith: 'garload-' } } })
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

/** Backdates the regroup clock and tops the energy pool up (setup-time only). */
async function prepareBattle(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
  await db.player.update({
    where: { id: playerId },
    data: { energy: 100, energyUpdatedAt: new Date() },
  })
}

/** Captures a cell through the ONE march engine and brings the survivors home. */
async function captureCellFor(playerId: string, cellId: string): Promise<void> {
  await prepareBattle(playerId)
  const march = await createMarch(playerId, {
    territoryId: cellId,
    type: 'ATTACK',
    units: [{ unitId: 'swordsman', count: 300 }],
  })
  await db.march.update({
    where: { id: march.id },
    data: { arrivesAt: new Date(Date.now() - 1000) },
  })
  await runMarchArrival(march.id)
  await db.march.update({
    where: { id: march.id },
    data: { returnsAt: new Date(Date.now() - 1000) },
  })
  await runMarchHomecoming(march.id)
}

describe('Garrison & clan load (STEP 25 measurements)', () => {
  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('garrison-load', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
  }, 60_000)

  afterAll(async () => {
    await purge()
  }, 60_000)

  it('L1 — CLAN CREATION: 20 sequential creates with per-create latency', async () => {
    const lord = await register()
    const latencies: number[] = []
    for (let i = 0; i < 20; i++) {
      const founderId = i === 0 ? lord.playerId : (await register()).playerId
      const t0 = performance.now()
      const clan = await createClan(founderId, {
        name: `Load Legion ${i}`,
        tag: `LL${String(i).padStart(2, '0')}`,
      })
      const ms = performance.now() - t0
      latencies.push(ms)
      clanIds.push(clan.id)
    }
    const avg = latencies.reduce((s, n) => s + n, 0) / latencies.length
    const worst = Math.max(...latencies)
    console.log(`L1 clan create: avg=${avg.toFixed(1)}ms worst=${worst.toFixed(1)}ms n=20`)
    expect(worst).toBeLessThan(2_000)
    expect(await db.clan.count({ where: { id: { in: [...clanIds] } } })).toBe(20)
  }, 120_000)

  it('L2 — GARRISON VIEW: 25 parallel public reads stay bounded', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 100)
    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: lord.playerId, isCapital: true },
      select: { id: true },
    })
    const march = await createMarch(lord.playerId, {
      territoryId: capital.id,
      type: 'DEFEND',
      units: [{ unitId: 'swordsman', count: 60 }],
    })
    await db.march.update({
      where: { id: march.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    await runMarchArrival(march.id)

    const t0 = performance.now()
    const reads = await Promise.all(
      Array.from({ length: 25 }, () => getTerritoryGarrisonView(db, capital.id, lord.playerId)),
    )
    const ms = performance.now() - t0
    console.log(
      `L2 garrison view: total=${ms.toFixed(1)}ms avg=${(ms / 25).toFixed(1)}ms n=25 parallel`,
    )
    expect(ms).toBeLessThan(5_000)
    for (const view of reads) {
      expect(view.garrisoned).toBe(true)
      expect(view.totalUnits).toBe(60)
    }
  }, 60_000)

  it('L3 — DEPLOY PIPELINE: 10 sequential DEFEND marches with per-deploy latency', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 400)
    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: lord.playerId, isCapital: true },
      select: { id: true },
    })
    const latencies: number[] = []
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      const march = await createMarch(lord.playerId, {
        territoryId: capital.id,
        type: 'DEFEND',
        units: [{ unitId: 'swordsman', count: 20 }],
      })
      await db.march.update({
        where: { id: march.id },
        data: { arrivesAt: new Date(Date.now() - 1000) },
      })
      await runMarchArrival(march.id)
      latencies.push(performance.now() - t0)
    }
    const avg = latencies.reduce((s, n) => s + n, 0) / latencies.length
    const worst = Math.max(...latencies)
    console.log(`L3 deploy pipeline: avg=${avg.toFixed(1)}ms worst=${worst.toFixed(1)}ms n=10`)
    expect(worst).toBeLessThan(3_000)
    // Conservation: 10 × 20 stationed exactly once.
    const rows = await db.territoryGarrison.findMany({ where: { territoryId: capital.id } })
    const total = rows.reduce(
      (sum, r) => sum + (r.units as Array<{ count: number }>).reduce((s, u) => s + u.count, 0),
      0,
    )
    expect(total).toBe(200)
    expect(rows.length).toBe(10)
  }, 120_000)

  it('L4 — MULTI-CONTRIBUTOR: 19 same-clan reinforcements stack onto one territory; view + assault bounded', async () => {
    // Honest geography: the stacked cell is a CAPTURED frontier cell (never
    // a capital — capitals are unassailable), found via the shared two-step
    // frontier helper.
    const { lord, foe, cell, foeCell } = await findTwoStepFrontier(register)
    const clan = await createClan(lord.playerId, { name: 'Load Stack', tag: 'LSTK' })
    clanIds.push(clan.id)
    await grantArmy(lord.playerId, 400)
    await grantArmy(foe.playerId, 2_000)
    await prepareBattle(lord.playerId)
    const capture = await createMarch(lord.playerId, {
      territoryId: cell.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 300 }],
    })
    await db.march.update({
      where: { id: capture.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    await runMarchArrival(capture.id)
    await db.march.update({
      where: { id: capture.id },
      data: { returnsAt: new Date(Date.now() - 1000) },
    })
    await runMarchHomecoming(capture.id)

    // The lord's own contribution (the 20th — the ceiling). His capture
    // battle restarted the regroup clock — elapse it again first.
    await prepareBattle(lord.playerId)
    const lordDefend = await createMarch(lord.playerId, {
      territoryId: cell.id,
      type: 'DEFEND',
      units: [{ unitId: 'swordsman', count: 30 }],
    })
    await db.march.update({
      where: { id: lordDefend.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    await runMarchArrival(lordDefend.id)

    const capacity = GARRISON.capacityBase + GARRISON.capacityPerStrategicValue * 3 // SV ≥ 0 documented floor

    // 19 clanmates each reinforce 30 swordsmen (19 + the lord's own = 20
    // contributions — the configured ceiling).
    const mateIds: string[] = []
    for (let i = 0; i < 19; i++) {
      const mate = await register()
      mateIds.push(mate.playerId)
      await joinClan(mate.playerId, clan.id)
      await grantArmy(mate.playerId, 30)
    }
    const deployStart = performance.now()
    for (const mateId of mateIds) {
      const march = await createMarch(mateId, {
        territoryId: cell.id,
        type: 'REINFORCE',
        units: [{ unitId: 'swordsman', count: 30 }],
      })
      await db.march.update({
        where: { id: march.id },
        data: { arrivesAt: new Date(Date.now() - 1000) },
      })
      await runMarchArrival(march.id)
    }
    const deployMs = performance.now() - deployStart

    const viewStart = performance.now()
    const view = await getTerritoryGarrisonView(db, cell.id, lord.playerId)
    const viewMs = performance.now() - viewStart
    console.log(
      `L4 stack: 19 reinforcements in ${deployMs.toFixed(0)}ms; view=${viewMs.toFixed(1)}ms total=${view.totalUnits}`,
    )
    expect(view.contributionCount).toBe(20) // lord + 19
    expect(view.totalUnits).toBe(20 * 30)
    expect(view.totalUnits).toBeLessThanOrEqual(capacity)
    expect(viewMs).toBeLessThan(1_000)

    // One full assault against the stacked 600-unit garrison.
    await captureCellFor(foe.playerId, foeCell.id)
    await prepareBattle(foe.playerId)
    const assaultStart = performance.now()
    const assault = await attackTerritory(foe.playerId, {
      territoryId: cell.id,
      idempotencyKey: 'garload-assault-1',
    })
    const assaultMs = performance.now() - assaultStart
    console.log(
      `L4 assault vs 20-contributor garrison: ${assaultMs.toFixed(1)}ms outcome=${assault.outcome}`,
    )
    expect(assaultMs).toBeLessThan(5_000)
    expect(assault.battleId).toBeTruthy()
  }, 240_000)

  it('L5 — PARALLEL DEPLOYS: 10 simultaneous creations — no deadlock, conservation intact', async () => {
    const lord = await register()
    await grantArmy(lord.playerId, 500)
    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: lord.playerId, isCapital: true },
      select: { id: true },
    })
    const t0 = performance.now()
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        createMarch(lord.playerId, {
          territoryId: capital.id,
          type: 'DEFEND',
          units: [{ unitId: 'swordsman', count: 10 }],
          idempotencyKey: i === 0 ? 'garload-parallel-key' : undefined,
        }),
      ),
    )
    const ms = performance.now() - t0
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled').length
    const rejected = attempts.filter((a) => a.status === 'rejected').length
    console.log(
      `L5 parallel deploys: total=${ms.toFixed(1)}ms fulfilled=${fulfilled} rejected=${rejected}`,
    )
    expect(ms).toBeLessThan(20_000)
    expect(fulfilled).toBeGreaterThanOrEqual(1)
    // Every outcome is either a march or a typed AppError — never a crash.
    for (const a of attempts) {
      if (a.status === 'rejected') {
        expect((a.reason as { code?: string }).code).toBeTruthy()
      }
    }
    // Conservation over ALL marches: reserved ≤ granted, nothing negative.
    const marches = await db.march.findMany({ where: { playerId: lord.playerId } })
    const reserved = marches.reduce(
      (sum, m) => sum + (m.units as Array<{ count: number }>).reduce((s, u) => s + u.count, 0),
      0,
    )
    const army = await db.playerUnit.findFirstOrThrow({
      where: { playerId: lord.playerId, unitId: 'swordsman' },
      select: { count: true },
    })
    expect(reserved + army.count).toBe(500 + 20) // grant + bootstrap
  }, 120_000)
})
