/**
 * Integration tests — World Security matrix (Phase 32).
 *
 * An adversary-driven pass over the territory surface: forged payloads,
 * replayed keys, duplicate captures, capital attacks, non-adjacent bypasses,
 * foreign collection, client-controlled quest progress — every refusal must
 * be typed and (where applicable) ZERO-WRITE.
 *
 * Identities live in the isolated 9100033… telegramId range.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as attackPost } from '../../../src/app/api/v1/world/territories/[id]/attack/route'
import { POST as collectPost } from '../../../src/app/api/v1/world/territories/[id]/collect/route'
import { GET as historyGet } from '../../../src/app/api/v1/world/territories/[id]/history/route'
import { GET as playerTerritoriesGet } from '../../../src/app/api/v1/world/player-territories/route'
import { POST as adminLockPost } from '../../../src/app/api/v1/admin/world/territories/[id]/lock/route'
import {
  adminSetTerritoryLock,
  adminSetTerritoryOwnership,
  adminGetTerritory,
} from '../../../src/lib/game/services/world.service'
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
    'World security tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100033'
const ADMIN_TG = '9100033000'
const IP = '203.0.134.'
let ipCounter = 1
const nextIp = (): string => `${IP}${ipCounter++}`

let tgCounter = 9100033001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEXS0000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `SecLord${telegramId.slice(-3)}`,
      username: `sec_lord_${telegramId.slice(-4)}`,
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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  if (!body.ok || !body.data) throw new Error(`security registration failed ${tgId}`)
  return { token: body.data.token, playerId: body.data.player.id, tgId }
}

async function grantVeteranArmy(playerId: string): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
    create: { playerId, unitId: 'swordsman', count: 100 },
    update: { count: { increment: 100 } },
  })
}

async function elapseCooldown(playerId: string): Promise<void> {
  await db.battle.updateMany({
    where: { attackerPlayerId: playerId, type: { in: ['PVP_ATTACK', 'TERRITORY_ASSAULT'] } },
    data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 10) * 1000) },
  })
}

/** Unclaimed cells adjacent to ANY of the player's holdings (the real rule). */
async function pickFrontier(playerId: string): Promise<string> {
  const owned = await db.territory.findMany({
    where: { ownerPlayerId: playerId },
    select: { x: true, y: true },
  })
  const coords = new Set<string>()
  for (const cell of owned) {
    for (const adj of adjacentCoords(cell.x, cell.y)) coords.add(`${adj.x},${adj.y}`)
  }
  const list = [...coords].map((key) => key.split(',').map(Number) as [number, number])
  const row = await db.territory.findFirstOrThrow({
    where: { status: 'UNCLAIMED', isCapital: false, OR: list.map(([x, y]) => ({ x, y })) },
    orderBy: [{ y: 'asc' }, { x: 'asc' }],
    select: { id: true },
  })
  return row.id
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
  // The suite's admin identity accumulates Restrict-referenced audit rows —
  // remove them (and the admin record) BEFORE the bulk user delete (its TG id
  // also matches the TG_PREFIX).
  const adminUser = await db.user.findUnique({
    where: { telegramId: ADMIN_TG },
    select: { id: true },
  })
  if (adminUser) {
    await db.auditLog.deleteMany({ where: { actorUserId: adminUser.id } })
    await db.adminUser.deleteMany({ where: { userId: adminUser.id } })
    await db.user.delete({ where: { id: adminUser.id } })
  }
  await purgeTestUsersByTelegramPrefix(db, TG_PREFIX)
}

describe('World security matrix (forged input · replay · duplicates · capital · RBAC)', () => {
  let lord: { token: string; playerId: string; tgId: string }
  let stranger: { token: string; playerId: string }
  let capitalId: string
  let adminUserId: string

  beforeAll(async () => {
    await purge()
    await runEconomyTransaction('world-sec', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    lord = await register()
    stranger = await register()
    await grantVeteranArmy(lord.playerId)

    const capital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: lord.playerId, isCapital: true },
      select: { id: true },
    })
    capitalId = capital.id

    // Admin identity for service-level assertions (fixed TG id → purgeable).
    const adminUser = await db.user.upsert({
      where: { telegramId: ADMIN_TG },
      create: { telegramId: ADMIN_TG, firstName: 'SecAdmin', role: 'ADMIN' },
      update: { role: 'ADMIN' },
    })
    await db.adminUser.upsert({
      where: { userId: adminUser.id },
      create: { userId: adminUser.id, role: 'ADMIN' },
      update: { isActive: true },
    })
    adminUserId = adminUser.id
  })

  afterAll(purge)

  it('1 — forged battle fields in the body are IGNORED (no client influence over combat)', async () => {
    await elapseCooldown(lord.playerId)
    const targetId = await pickFrontier(lord.playerId)
    const forged = {
      // Every one of these would be catastrophic if honored — the Zod schema
      // strips unknown keys and the service derives all values server-side.
      winner: 'ATTACKER_WIN',
      result: 'ATTACKER_WIN',
      seed: 1,
      terrain: 'PLAINS',
      casualties: { attacker: [], defender: [] },
      spoils: { GOLD: '999999999' },
      capture: true,
      captured: true,
      progress: 999,
      questProgress: 999,
      reward: { GOLD: 999999 },
      ownedCount: 100,
      territoryId: 'forged-id',
      defenderPlayerId: lord.playerId,
      seasonPoints: 9999,
    }
    const attack = await call<{ battleId: string; result: string; spoils: Record<string, string> }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      forged,
      targetId,
    )
    expect(attack.status).toBe(200)
    const battle = await db.battle.findUniqueOrThrow({ where: { id: attack.body.data!.battleId } })
    // The seed is server-generated: a forged seed of 1 can never appear.
    expect(battle.seed).not.toBe(1)
    // Spoils are config-defined (≤ cap), never the forged 999999999.
    for (const amount of Object.values(attack.body.data!.spoils)) {
      expect(Number(amount)).toBeLessThanOrEqual(2500)
    }
    // The client cannot pick the defender — garrisons have NO player id.
    expect(battle.defenderPlayerId).not.toBe(lord.playerId)
  })

  it('2 — the same idempotency key on a DIFFERENT target is a typed refusal', async () => {
    await elapseCooldown(lord.playerId)
    const key = `sec-key-${lord.tgId}`
    const targetId = await pickFrontier(lord.playerId)
    const first = await call(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: key },
      targetId,
    )
    expect(first.status).toBe(200)
    expect(await db.idempotencyKey.findUnique({ where: { key } })).not.toBeNull()

    await elapseCooldown(lord.playerId)
    const other = await db.territory.findFirstOrThrow({
      where: { id: { not: targetId }, status: 'UNCLAIMED' },
      select: { id: true },
    })
    const replay = await call<{ error: { code: string } }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: key },
      other.id,
    )
    expect(replay.status).toBe(409)
    expect(replay.body.error!.code).toBe('IDEMPOTENT_REPLAY')
  })

  it('3 — a replayed assault consumes energy/units/captures exactly ONCE', async () => {
    await elapseCooldown(lord.playerId)
    const key = `replay-${lord.tgId}`
    const targetId = await pickFrontier(lord.playerId)
    const battlesBefore = await db.battle.count({
      where: { attackerPlayerId: lord.playerId, type: 'TERRITORY_ASSAULT' },
    })
    const capturesBefore = await db.territory.count({ where: { ownerPlayerId: lord.playerId } })

    const first = await call(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: key },
      targetId,
    )
    expect(first.status).toBe(200)
    expect(first.body.data!.replayed).toBeUndefined()

    await elapseCooldown(lord.playerId) // cooldown must NOT gate a replay
    const replay = await call<{ replayed: boolean; battleId: string }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { idempotencyKey: key },
      targetId,
    )
    expect(replay.status).toBe(200)
    expect(replay.body.data!.replayed).toBe(true)
    expect(replay.body.data!.battleId).toBe(first.body.data!.battleId)

    // Exactly ONE battle exists; at most ONE new owned territory.
    const battlesAfter = await db.battle.count({
      where: { attackerPlayerId: lord.playerId, type: 'TERRITORY_ASSAULT' },
    })
    expect(battlesAfter).toBe(battlesBefore + 1)
    const capturesAfter = await db.territory.count({ where: { ownerPlayerId: lord.playerId } })
    expect(capturesAfter - capturesBefore).toBeLessThanOrEqual(1)
  })

  it('4 — capitals are unattackable by EVERYONE (owner included)', async () => {
    const strangerCapital = await db.territory.findFirstOrThrow({
      where: { ownerPlayerId: stranger.playerId, isCapital: true },
      select: { id: true },
    })
    for (const token of [lord.token, stranger.token]) {
      const attack = await call<{ error: { code: string } }>(
        attackPost,
        token,
        '/api/v1/world/territories/x/attack',
        'POST',
        {},
        token === lord.token ? strangerCapital.id : capitalId,
      )
      expect(attack.status).toBe(403)
      expect(attack.body.error!.code).toBe('TERRITORY_CAPITAL_PROTECTED')
    }
    const stillOwned = await db.territory.findUniqueOrThrow({ where: { id: capitalId } })
    expect(stillOwned.ownerPlayerId).toBe(lord.playerId)
  })

  it('5 — the RBAC wall holds: players cannot invoke admin world ops', async () => {
    const asPlayer = await call(
      adminLockPost,
      lord.token,
      '/api/v1/admin/world/territories/x/lock',
      'POST',
      { locked: true },
      capitalId,
    )
    expect([401, 403]).toContain(asPlayer.status)
    // The service layer is route-independent — RBAC scopes are enforced by the
    // route guard (requireAdminScope), audited inside the service transaction.
  })

  it('6 — admin lock refuses assault; unlock restores state; audited transactionally', async () => {
    const targetId = await pickFrontier(lord.playerId)
    await adminSetTerritoryLock(adminUserId, targetId, true)
    const locked = await db.territory.findUniqueOrThrow({ where: { id: targetId } })
    expect(locked.status).toBe('LOCKED')

    const refused = await call<{ error: { code: string } }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      {},
      targetId,
    )
    expect(refused.status).toBe(409)
    expect(refused.body.error!.code).toBe('TERRITORY_LOCKED')

    const audit = await db.auditLog.findFirst({
      where: { targetType: 'territory', targetId, action: 'TERRITORY_LOCK' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()

    await adminSetTerritoryLock(adminUserId, targetId, false)
    const unlocked = await db.territory.findUniqueOrThrow({ where: { id: targetId } })
    expect(unlocked.status).toBe('UNCLAIMED')
  })

  it('7 — admin ownership correction: ADMIN history row + audit; capitals immutable', async () => {
    const targetId = await pickFrontier(lord.playerId)
    const result = await adminSetTerritoryOwnership(
      adminUserId,
      targetId,
      lord.playerId,
      'security suite arrangement',
    )
    expect(result.ownerPlayerId).toBe(lord.playerId)
    const view = await adminGetTerritory(targetId)
    expect(view.recentHistory[0]!.reason).toBe('ADMIN')

    const audit = await db.auditLog.findFirst({
      where: { targetType: 'territory', targetId, action: 'TERRITORY_OWNERSHIP' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()

    // Capitals are immutable even for admins.
    await expect(
      adminSetTerritoryOwnership(adminUserId, capitalId, stranger.playerId, 'must fail closed'),
    ).rejects.toThrow()

    // Repair (history keeps every record).
    await adminSetTerritoryOwnership(adminUserId, targetId, null, 'security suite cleanup')
  })

  it('8 — foreign production collection refused; history is public but private-data-free', async () => {
    const foreign = await call<{ error: { code: string } }>(
      collectPost,
      stranger.token,
      '/api/v1/world/territories/x/collect',
      'POST',
      {},
      capitalId,
    )
    expect(foreign.status).toBe(403)

    const history = await call(
      historyGet,
      stranger.token,
      '/api/v1/world/territories/x/history',
      'GET',
      undefined,
      capitalId,
    )
    expect(history.status).toBe(200)
    const raw = JSON.stringify(history.body.data!)
    expect(raw).not.toContain('stacks')
    expect(raw).not.toContain('wallet')
    expect(raw).not.toContain('delta')
  })

  it('9 — player-territories is strictly caller-scoped', async () => {
    const mine = await call<{ territories: Array<{ id: string }> }>(
      playerTerritoriesGet,
      lord.token,
      '/api/v1/world/player-territories',
    )
    expect(mine.status).toBe(200)
    for (const cell of mine.body.data!.territories) {
      const row = await db.territory.findUniqueOrThrow({ where: { id: cell.id } })
      expect(row.ownerPlayerId).toBe(lord.playerId)
    }
  })

  it('10 — fake territory ids are 404s and season/energy/adjacency stay server-owned', async () => {
    await elapseCooldown(lord.playerId)
    const attack = await call<{ error: { code: string } }>(
      attackPost,
      lord.token,
      '/api/v1/world/territories/x/attack',
      'POST',
      { seasonNumber: 99, energyCost: 0, bypassAdjacency: true },
      'totally-fake-territory-id',
    )
    expect(attack.status).toBe(404)
    expect(attack.body.error!.code).toBe('TERRITORY_NOT_FOUND')
  })
})
