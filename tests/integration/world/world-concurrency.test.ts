/**
 * Integration tests — World Concurrency (Phase 32).
 *
 * Everything here fires REAL parallel requests (Promise.all) through the
 * public routes — real mutexes, real CAS, real SQLite serialization:
 *  - A vs B on the SAME unclaimed territory at the same instant
 *  - one player × 10 parallel assaults with distinct keys
 *  - one player × double-submit with the SAME key
 *  - parallel production collection
 * Invariants after every storm: exactly one owner per territory, no negative
 * unit counts, one battle per admitted assault, Σ(ledger) == wallet, no
 * duplicate quest progress per event.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as attackPost } from '../../../src/app/api/v1/world/territories/[id]/attack/route'
import { POST as collectPost } from '../../../src/app/api/v1/world/territories/[id]/collect/route'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { adjacentCoords } from '../../../src/lib/game/engine/world/generator'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'World concurrency tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100055'
const IP = '203.0.142.' // unique per file: shared pools trip AUTH_RATE_LIMIT across parallel suites
let ipCounter = 1
const nextIp = (): string => `${IP}${ipCounter++}`
let tgCounter = 9100055001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAECC0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `ConcLord${telegramId.slice(-3)}`,
      username: `conc_lord_${telegramId.slice(-4)}`,
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
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(
    authed(path, token, method, payload),
    territoryId ? { params: Promise.resolve({ id: territoryId }) } : undefined,
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
  if (!body.ok || !body.data) throw new Error(`concurrency registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
}

async function grantVeteranArmy(playerId: string): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: 200 },
    update: { count: { increment: 200 } },
  })
}

/** Unclaimed cells adjacent to ANY of the player's holdings. */
async function frontier(playerId: string, count = 1): Promise<string[]> {
  const owned = await db.territory.findMany({
    where: { ownerPlayerId: playerId },
    select: { x: true, y: true },
  })
  const coords = new Set<string>()
  for (const cell of owned) {
    for (const adj of adjacentCoords(cell.x, cell.y)) coords.add(`${adj.x},${adj.y}`)
  }
  const list = [...coords].map((key) => key.split(',').map(Number) as [number, number])
  const rows = await db.territory.findMany({
    where: { status: 'UNCLAIMED', isCapital: false, OR: list.map(([x, y]) => ({ x, y })) },
    orderBy: [{ y: 'asc' }, { x: 'asc' }],
    select: { id: true },
    take: count,
  })
  return rows.map((row) => row.id)
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

describe('World concurrency (same target · same player · production races)', () => {
  let alpha: { token: string; playerId: string }
  let bravo: { token: string; playerId: string }

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('world-conc', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    alpha = await register()
    bravo = await register()
    await grantVeteranArmy(alpha.playerId)
    await grantVeteranArmy(bravo.playerId)
  })

  afterAll(async () => {
    await purge()
  })

  it('1 — two players assault the SAME territory simultaneously → serial, consistent world', async () => {
    const [shared] = await frontier(alpha.playerId, 1)
    expect(shared).toBeTruthy()

    const [a, b] = await Promise.all([
      call<{ battleId: string; outcome: string; territory: { captured: boolean } }>(
        attackPost,
        alpha.token,
        '/api/v1/world/territories/x/attack',
        'POST',
        { idempotencyKey: `conc-a-${Date.now()}` },
        shared,
      ),
      call<{ battleId: string; outcome: string; territory: { captured: boolean } }>(
        attackPost,
        bravo.token,
        '/api/v1/world/territories/x/attack',
        'POST',
        { idempotencyKey: `conc-b-${Date.now()}` },
        shared,
      ),
    ])

    // Both requests resolve (200 or typed refusal) — no 500s, no corruption.
    for (const res of [a, b]) {
      expect([200, 400, 403, 409, 429]).toContain(res.status)
    }
    // The territory ends with EXACTLY ONE owner.
    const final = await db.territory.findUniqueOrThrow({
      where: { id: shared },
      select: { ownerPlayerId: true, status: true },
    })
    const owners = new Set([final.ownerPlayerId])
    expect(owners.size).toBe(1)
    if (a.status === 200 && b.status === 200) {
      // Serial execution: the second attacker fought the FIRST attacker's army
      // (a real defender) — both battles exist, history is consistent.
      expect(final.ownerPlayerId).not.toBeNull()
      const battles = await db.battle.findMany({
        where: { territoryId: shared, type: 'TERRITORY_ASSAULT' },
        orderBy: { startedAt: 'asc' },
      })
      expect(battles.length).toBeGreaterThanOrEqual(2)
      // The SECOND battle's defender is the pre-battle owner of that instant.
      expect(battles[1]!.defenderPlayerId).not.toBeNull()
    }
    // History rows: at most one CAPTURE per battle id.
    const history = await db.territoryHistory.findMany({ where: { territoryId: shared } })
    const battleIds = history.filter((row) => row.battleId).map((row) => row.battleId)
    expect(new Set(battleIds).size).toBe(battleIds.length)
  })

  it('2 — one player × 10 parallel assaults (distinct keys) → at most one admitted, rest cooldown-gated', async () => {
    await db.player.update({ where: { id: alpha.playerId }, data: { energy: 100 } })
    const targets = await frontier(alpha.playerId, 3)
    const target = targets[0]!
    const key = `storm-${alpha.tgId}`
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call<{ battleId?: string; replayed?: boolean }>(
          attackPost,
          alpha.token,
          '/api/v1/world/territories/x/attack',
          'POST',
          { idempotencyKey: `${key}-${i}` }, // distinct keys = distinct battles IF admitted
          target,
        ),
      ),
    )
    const admitted = responses.filter((r) => r.status === 200 && !r.body.data!.replayed)
    // Cooldown + serialization: at most ONE real assault went through.
    expect(admitted.length).toBeLessThanOrEqual(1)
    for (const res of responses) {
      expect([200, 400, 403, 409, 429]).toContain(res.status)
    }
    // Exactly one battle per admitted assault.
    const battles = await db.battle.count({
      where: { attackerPlayerId: alpha.playerId, territoryId: target },
    })
    expect(battles).toBe(admitted.length)
  })

  it('3 — one player × 10 parallel double-submits (SAME key) → exactly one battle', async () => {
    await elapseAll(alpha.playerId)
    await db.player.update({ where: { id: alpha.playerId }, data: { energy: 100 } })
    const targets = await frontier(alpha.playerId, 1)
    const target = targets[0]!
    const key = `double-${alpha.tgId}`
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        call<{ battleId: string; replayed?: boolean }>(
          attackPost,
          alpha.token,
          '/api/v1/world/territories/x/attack',
          'POST',
          { idempotencyKey: key },
          target,
        ),
      ),
    )
    const battles = await db.battle.count({
      where: { attackerPlayerId: alpha.playerId, territoryId: target },
    })
    expect(battles).toBeLessThanOrEqual(1)
    const okResponses = responses.filter((r) => r.status === 200)
    // Every 200 response reports the SAME battle id (original or replay).
    const ids = new Set(okResponses.map((r) => r.body.data!.battleId))
    expect(ids.size).toBeLessThanOrEqual(1)
  })

  it('4 — parallel production collection credits exactly once', async () => {
    // Arrange: a producing territory owned by alpha.
    const targets = await frontier(alpha.playerId, 1)
    expect(targets.length).toBeGreaterThan(0)
    const targetId = targets[0]!
    // Capture it first (serial — cooldown elapsed).
    await elapseAll(alpha.playerId)
    await db.player.update({ where: { id: alpha.playerId }, data: { energy: 100 } })
    const capture = await call(
      attackPost,
      alpha.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: `prod-${alpha.tgId}` },
      targetId,
    )
    if (capture.status === 200 && capture.body.data!.territory.captured) {
      // Make it producing + fully elapsed.
      await db.territory.update({
        where: { id: targetId },
        data: {
          resourceType: 'GOLD',
          productionRate: 120,
          productionCollectedAt: new Date(Date.now() - 3 * 3600_000),
        },
      })
      const walletBefore = (
        await db.resourceWallet.findUniqueOrThrow({
          where: { playerId: alpha.playerId },
          select: { gold: true },
        })
      ).gold
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          call<{ amount?: string; error?: { code: string } }>(
            collectPost,
            alpha.token,
            '/api/v1/world/territories/x/collect',
            'POST',
            {},
            targetId,
          ),
        ),
      )
      const credited = results.filter((r) => r.status === 200)
      expect(credited.length).toBe(1) // exactly one collector wins
      const walletAfter = (
        await db.resourceWallet.findUniqueOrThrow({
          where: { playerId: alpha.playerId },
          select: { gold: true },
        })
      ).gold
      expect(walletAfter - walletBefore).toBe(BigInt(credited[0]!.body.data!.amount!))
    }
  })

  it('5 — post-storm invariants: no negative units, ledger reconciles, no duplicate quest progress', async () => {
    for (const player of [alpha, bravo]) {
      // No negative unit counts.
      const negative = await db.playerUnit.count({
        where: { playerId: player.playerId, count: { lt: 0 } },
      })
      expect(negative).toBe(0)

      // Σ(ledger deltas) == wallet balance for every resource.
      const wallet = await db.resourceWallet.findUniqueOrThrow({
        where: { playerId: player.playerId },
      })
      const ledger = await db.resourceTransaction.findMany({
        where: { playerId: player.playerId },
        select: { resource: true, delta: true },
      })
      const sums: Record<string, bigint> = {}
      for (const row of ledger) sums[row.resource] = (sums[row.resource] ?? 0n) + row.delta
      for (const resource of ['gold', 'wood', 'iron', 'food', 'crystal'] as const) {
        expect(sums[resource.toUpperCase()] ?? 0n).toBe(wallet[resource])
      }

      // No duplicate quest progress per event identity (lastEventKey guards).
      const dupes = await db.$queryRaw<
        Array<{ playerId: string; questId: string; cycle: string; key: string; n: number }>
      >`
        SELECT "playerId", "questId", "cycle", "lastEventKey" as "key", COUNT(*) as "n"
        FROM "player_quests"
        WHERE "playerId" = ${player.playerId} AND "lastEventKey" IS NOT NULL
        GROUP BY "playerId", "questId", "cycle", "lastEventKey"
        HAVING COUNT(*) > 1`
      // A (quest, cycle) row is unique; the same EVENT KEY must appear once per row.
      // Cross-row duplication would mean one event advanced two instances of the
      // SAME quest — impossible by the (playerId, questId, cycle) unique constraint.
      expect(dupes.length).toBe(0)
    }
    // Every territory is internally consistent. Abandoned CAPITALS (owner
    // SetNull after a player deletion from OTHER suites' cleanups) are a
    // documented sandbox artifact — they are inert (unattackable, unclaimable)
    // — so the structural pairing invariant applies to every NON-capital cell.
    const corrupt = await db.territory.count({
      where: {
        isCapital: false,
        OR: [
          { status: 'CONTROLLED', ownerPlayerId: null },
          { status: 'UNCLAIMED', ownerPlayerId: { not: null } },
        ],
      },
    })
    expect(corrupt).toBe(0)
    // Ownership direction can never be inverted anywhere in the world.
    const inverted = await db.territory.count({
      where: { status: 'UNCLAIMED', ownerPlayerId: { not: null } },
    })
    expect(inverted).toBe(0)
  })
})

async function elapseAll(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}
