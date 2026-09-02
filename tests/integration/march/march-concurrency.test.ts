/**
 * Integration tests — March Concurrency (Phase 33, STEP 17).
 *
 * Races exercised through the PUBLIC service layer with REAL parallelism
 * (Promise.all), real transactions, real SQLite — zero mocks:
 *
 *  1. same units × 10 march creations  → only CAS-fitting reservations land;
 *     player_units NEVER negative, no double reservation
 *  2. same march × 10 arrival processors → exactly ONE battle
 *  3. same march × 10 homecoming processors → exactly ONE restoration
 *  4. cancel × arrival race (10 cancels + 10 arrivals) → exactly one wins
 *  5. same march × 10 cancellation requests → exactly one state transition
 *
 * Identities live in the isolated 9100057… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { createMarch, cancelMarch } from '../../../src/lib/game/services/march.service'
import { runMarchArrival, runMarchHomecoming } from '../../../src/lib/game/services/march-processor'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error('March concurrency tests require TELEGRAM_BOT_TOKEN and JWT_SECRET (.env).')
}

const TG_PREFIX = '9100057'
const IP = '203.0.136.1'

let tgCounter = 9100057001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEWC000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({ id: Number(telegramId), first_name: `Con${telegramId.slice(-3)}` }),
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
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const parsed = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!parsed.ok || !parsed.data) throw new Error(`concurrency registration failed ${tgId}`)
  return { token: parsed.data.token, playerId: parsed.data.player.id }
}

async function grantArmy(playerId: string, count: number): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count },
    update: { count: { increment: count } },
  })
}

/** Raises the castle to unlock N march slots (1 + floor(level/5)). */
async function raiseCastle(playerId: string, level: number): Promise<void> {
  await db.building.updateMany({
    where: { city: { playerId }, type: 'CASTLE' },
    data: { level },
  })
}

const players: string[] = []
const touched: string[] = []

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

async function findAdjacentUnclaimed(
  playerId: string,
  excludeId?: string,
): Promise<{ id: string; x: number; y: number } | null> {
  const capital = await db.territory.findFirstOrThrow({
    where: { ownerPlayerId: playerId, isCapital: true },
    select: { x: true, y: true },
  })
  const cell = await db.territory.findFirst({
    where: {
      OR: adjacentCoords(capital.x, capital.y).map((c) => ({ x: c.x, y: c.y })),
      status: 'UNCLAIMED',
      isCapital: false,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, x: true, y: true },
  })
  if (cell) touched.push(cell.id)
  return cell ?? null
}

/**
 * Registers players until one spawns next to an unclaimed frontier cell —
 * the spawn spiral clusters consecutive capitals, so a fresh registration
 * may be fully landlocked by its predecessors. `wanted` frontier cells are
 * required (C3 needs two distinct targets for one lord).
 */
async function registerWithFrontiers(wanted: number): Promise<{
  token: string
  playerId: string
  cells: Array<{ id: string; x: number; y: number }>
}> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const p = await register()
    players.push(p.playerId)
    const cells: Array<{ id: string; x: number; y: number }> = []
    for (let i = 0; i < wanted; i++) {
      const cell = await findAdjacentUnclaimed(p.playerId, cells[0]?.id)
      if (!cell) break
      cells.push(cell)
    }
    if (cells.length === wanted) return { ...p, cells }
  }
  throw new Error(`no lord with ${wanted} frontier cells after 8 registrations`)
}

describe('March concurrency (STEP 17 races)', () => {
  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('march-conc', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
  })

  afterAll(async () => {
    await purge()
  })

  it('C1 — same units × 10 march creations: no double reservation, no negative rows', async () => {
    const { playerId: pid, cells } = await registerWithFrontiers(1)
    await grantArmy(pid, 100) // + bootstrap starter 20 = 120 swordsman
    await raiseCastle(pid, 41) // 1 + floor(41/5) = 9 slots — the units are the constraint
    const target = cells[0]!

    // 10 concurrent ATTACK marches each demanding 70 of the same 120 units.
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        createMarch(pid, {
          territoryId: target.id,
          type: 'ATTACK',
          units: [{ unitId: 'swordsman', count: 70 }],
        }),
      ),
    )
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled').length
    const rejected = attempts.filter((a) => a.status === 'rejected').length
    expect(fulfilled).toBe(1) // only ONE reservation of the 70 fits
    expect(rejected).toBe(9)

    // The home army keeps exactly 120 − 70 = 50 — never negative, never duplicated.
    const army = await db.playerUnit.findFirstOrThrow({
      where: { playerId: pid, unitId: 'swordsman' },
      select: { count: true },
    })
    expect(army.count).toBe(50)
    // Exactly one live march row exists for the winner.
    const marches = await db.march.count({
      where: { playerId: pid, status: 'EN_ROUTE' },
    })
    expect(marches).toBe(1)
  })

  it('C2 — same march × 10 arrival processors: exactly ONE battle', async () => {
    const { playerId: pid, cells } = await registerWithFrontiers(1)
    await grantArmy(pid, 40)
    const target = cells[0]!
    const march = await createMarch(pid, {
      territoryId: target.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
    })
    // Force the march due, then race ten processors.
    await db.march.update({
      where: { id: march.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })

    const results = await Promise.all(Array.from({ length: 10 }, () => runMarchArrival(march.id)))
    const processed = results.filter((r) => r.processed).length
    expect(processed).toBe(1) // exactly-once arrival

    // The battle row is stamped with marchId — unique constraint guarantees
    // at most one; the processor guarantee is that it exists exactly once.
    const battle = await db.battle.findUniqueOrThrow({
      where: { marchId: march.id },
    })
    expect(battle.marchId).toBe(march.id)
    const battlesForMarch = await db.battle.count({
      where: { attackerPlayerId: pid, marchId: march.id },
    })
    expect(battlesForMarch).toBe(1)
  })

  it('C3 — same march × 10 homecoming processors: exactly ONE restoration', async () => {
    const { playerId: pid, cells } = await registerWithFrontiers(2)
    await grantArmy(pid, 60) // + bootstrap 20 = 80 swordsman
    await raiseCastle(pid, 41) // 9 slots — two marches must coexist
    // REINFORCE delivers to an OWN holding — the capital is the simplest one.
    const ownCapital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: pid, isCapital: true },
      select: { id: true },
    })
    const _reinforceMarch = await createMarch(pid, {
      territoryId: ownCapital.id,
      type: 'REINFORCE',
      units: [{ unitId: 'swordsman', count: 10 }],
    })
    // A REINFORCE delivers at arrival — for the homecoming race we need an
    // ATTACK march. Create one for the same lord (castle slots allow 9).
    const target2 = cells[1]!
    const attack = await createMarch(pid, {
      territoryId: target2.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 40 }],
    })
    await db.march.update({
      where: { id: attack.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    await runMarchArrival(attack.id)
    const afterArrival = await db.march.findUniqueOrThrow({ where: { id: attack.id } })
    expect(afterArrival.status).toBe('RETURNING')

    // Homecoming must add the survivors EXACTLY once.
    await db.march.update({
      where: { id: attack.id },
      data: { returnsAt: new Date(Date.now() - 1000) },
    })
    const survivors = afterArrival.survivors as Array<{ unitId: string; count: number }>
    const survivorTotal = survivors.reduce((sum, s) => sum + s.count, 0)
    const armyBefore = await db.playerUnit.findFirstOrThrow({
      where: { playerId: pid, unitId: 'swordsman' },
      select: { count: true },
    })

    const results = await Promise.all(
      Array.from({ length: 10 }, () => runMarchHomecoming(attack.id)),
    )
    const processed = results.filter((r) => r.processed).length
    expect(processed).toBe(1)

    const armyAfter = await db.playerUnit.findFirstOrThrow({
      where: { playerId: pid, unitId: 'swordsman' },
      select: { count: true },
    })
    expect(armyAfter.count).toBe(armyBefore.count + survivorTotal) // EXACTLY once
  })

  it('C4 — cancel × arrival race: exactly one side wins the state transition', async () => {
    const { playerId: pid, cells } = await registerWithFrontiers(1)
    await grantArmy(pid, 20)
    const target = cells[0]!
    const march = await createMarch(pid, {
      territoryId: target.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 20 }],
    })
    await db.march.update({
      where: { id: march.id },
      data: { arrivesAt: new Date(Date.now() - 1000) },
    })
    const processor = runMarchArrival

    // 10 cancels vs 10 arrivals, all at once.
    const [cancels, arrivals] = await Promise.all([
      Promise.allSettled(Array.from({ length: 10 }, () => cancelMarch(pid, march.id))),
      Promise.allSettled(Array.from({ length: 10 }, () => processor(march.id))),
    ])
    const cancelWins = cancels.filter((c) => c.status === 'fulfilled').length
    const arrivalsProcessed = arrivals.filter(
      (a) => a.status === 'fulfilled' && (a.value as { processed: boolean }).processed,
    ).length
    expect(cancelWins + arrivalsProcessed).toBe(1) // exactly one state transition wins

    const row = await db.march.findUniqueOrThrow({ where: { id: march.id } })
    // The winner decided: either CANCELLED (units home) or the arrival ran.
    expect(['CANCELLED', 'RETURNING', 'LOST']).toContain(row.status)
    if (row.status === 'CANCELLED') {
      const army = await db.playerUnit.findFirstOrThrow({
        where: { playerId: pid, unitId: 'swordsman' },
        select: { count: true },
      })
      // bootstrap 20 + grant 20: released EXACTLY once back to 40
      expect(army.count).toBe(40)
      expect(await db.battle.count({ where: { marchId: march.id } })).toBe(0)
    } else {
      expect(await db.battle.count({ where: { marchId: march.id } })).toBe(1)
    }
  })

  it('C5 — same march × 10 cancellation requests: exactly one transition', async () => {
    const { playerId: pid, cells } = await registerWithFrontiers(1)
    await grantArmy(pid, 15)
    const target = cells[0]!
    const march = await createMarch(pid, {
      territoryId: target.id,
      type: 'ATTACK',
      units: [{ unitId: 'swordsman', count: 15 }],
    })
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => cancelMarch(pid, march.id)),
    )
    const wins = results.filter((r) => r.status === 'fulfilled').length
    expect(wins).toBe(1)
    const army = await db.playerUnit.findFirstOrThrow({
      where: { playerId: pid, unitId: 'swordsman' },
      select: { count: true },
    })
    // bootstrap 20 + grant 15, minus 15 reserved, plus 15 released = 35
    expect(army.count).toBe(35) // released EXACTLY once, not 10×
    const row = await db.march.findUniqueOrThrow({ where: { id: march.id } })
    expect(row.status).toBe('CANCELLED')
  })

  it('C6 — route-level replay of the same idempotent creation returns the same march', async () => {
    const { token: lordToken, playerId: pid, cells } = await registerWithFrontiers(1)
    await grantArmy(pid, 10)
    const target = cells[0]!
    const payload = {
      territoryId: target.id,
      type: 'SCOUT' as const,
      units: [{ unitId: 'swordsman', count: 3 }],
      idempotencyKey: 'conc-replay-key',
    }
    const { POST: post } = await import('../../../src/app/api/v1/marches/route')
    const req = (body: unknown): Request =>
      new Request('http://localhost:3000/api/v1/marches', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${lordToken}`,
          'content-type': 'application/json',
          'x-forwarded-for': IP,
        },
        body: JSON.stringify(body),
      })
    const [a, b, c] = await Promise.all([
      post(req(payload)) as Promise<Response>,
      post(req(payload)) as Promise<Response>,
      post(req(payload)) as Promise<Response>,
    ])
    const bodies = await Promise.all([a.json(), b.json(), c.json()])
    const ids = bodies.map((body) => (body as { data: { id: string } }).data?.id)
    expect(new Set(ids).size).toBe(1) // one march id across all three
    const rows = await db.march.count({
      where: { playerId: pid, status: 'EN_ROUTE' },
    })
    expect(rows).toBe(1) // exactly one row, three replays
  })
})
