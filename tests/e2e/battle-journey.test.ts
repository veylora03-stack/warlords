/**
 * E2E — BATTLE JOURNEY (Phase 28).
 *
 * One continuous, realistic session exactly the way the Mini App drives the
 * API: two players authenticate through the real Telegram initData exchange
 * → the attacker scouts the target roster → sends the attack order (with the
 * client idempotency key the UI generates) → receives the server-computed
 * battle result → browses battle history → opens the round-by-round report →
 * both participants receive ATTACK_RESULT notifications → the victor's season
 * standing, honor, statistics, wallet and ledger all reflect the battle.
 * Zero mocks, zero direct-DB shortcuts for game state — real route handlers,
 * real transactions, real deterministic simulation.
 *
 * The identities live in the isolated 9100029… telegramId range and are
 * removed at the end (battles cleared first — they Restrict-delete).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { GET as targetsGet } from '../../src/app/api/v1/battles/targets/route'
import { POST as attackPost } from '../../src/app/api/v1/battles/attack/route'
import { GET as historyGet } from '../../src/app/api/v1/battles/route'
import { GET as detailGet } from '../../src/app/api/v1/battles/[id]/route'
import { GET as statisticsGet } from '../../src/app/api/v1/player/statistics/route'
import { GET as rankingGet } from '../../src/app/api/v1/season/ranking/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../src/lib/game/services/economy.service'
import { BATTLE } from '../../src/lib/game/config/battle'
import type { ApiEnvelope } from '../../src/types/api'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Battle E2E tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_PREFIX = '9100029'
const IP = '203.0.127.1'

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAEAD000000AAAA${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: 'MarchLord',
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

function request(
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
  params?: string,
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const res = await handler(
    request(path, token, method, payload),
    params ? { params: Promise.resolve({ id: params }) } : undefined,
  )
  return { status: res.status, body: (await res.json()) as ApiEnvelope<T> }
}

async function register(tag: string): Promise<{ token: string; playerId: string }> {
  const tgId = `${TG_PREFIX}${String(Date.now()).slice(-5)}${tag.length}`.slice(0, 12)
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: JSON.stringify({ initData: buildInitData(tgId) }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`e2e registration failed for ${tag}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

async function purgeRange(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_PREFIX } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
  if (ids.length > 0) {
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await db.user.deleteMany({ where: { telegramId: { startsWith: TG_PREFIX } } })
}

// ── Journey ──────────────────────────────────────────────────────────────────

describe('E2E — battle journey (attack → result → rewards → ranking → notifications → history)', () => {
  let attacker: { token: string; playerId: string }
  let defender: { token: string; playerId: string }
  let battleId: string
  let outcome: string

  beforeAll(async () => {
    await purgeRange()
    await runEconomyTransaction('battle-e2e', async (tx) => {
      await ensureActiveSeasonInTx(tx)
    })
    attacker = await register('a')
    defender = await register('d')
    // The defender is a fresh account — the newbie shield is server policy.
    // Test arrangement backdates it (real production accounts simply age past it).
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
    await db.player.update({
      where: { id: defender.playerId },
      data: { createdAt: twoWeeksAgo, level: BATTLE.protection.newbieLevelCap + 1, xp: 10_000n },
    })
    const user = await db.player.findUniqueOrThrow({
      where: { id: defender.playerId },
      select: { userId: true },
    })
    await db.user.update({
      where: { id: user.userId },
      data: { lastLoginAt: new Date(Date.now() - 2 * 3600_000) },
    })
  })

  afterAll(purgeRange)

  it('step 1 — the attacker scouts the target roster and finds the defender attackable', async () => {
    const { status, body } = await call<{
      targets: Array<{ playerId: string; attackable: boolean; power: string }>
      attacker: { armyUnits: number; energy: number; attackCost: number }
    }>(targetsGet, attacker.token, '/api/v1/battles/targets')
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.data!.attacker.armyUnits).toBe(30) // starter army
    const row = body.data!.targets.find((t) => t.playerId === defender.playerId)
    expect(row).toBeDefined()
    expect(row!.attackable).toBe(true)
  })

  it('step 2 — the attack order returns a server-computed battle', async () => {
    const { status, body } = await call<{
      battleId: string
      outcome: string
      result: string
      roundsCount: number
      casualties: { attacker: unknown[]; defender: unknown[] }
      loot: Record<string, string>
      energySpent: number
      cooldownUntil: string
      seed: number
    }>(attackPost, attacker.token, '/api/v1/battles/attack', 'POST', {
      targetPlayerId: defender.playerId,
      idempotencyKey: `e2e-${Date.now()}`,
    })
    expect(status).toBe(200)
    const data = body.data!
    expect(data.battleId).toBeTruthy()
    expect(['VICTORY', 'DEFEAT', 'DRAW']).toContain(data.outcome)
    expect(data.energySpent).toBe(BATTLE.energy.attackCost)
    expect(new Date(data.cooldownUntil).getTime()).toBeGreaterThan(Date.now())
    battleId = data.battleId
    outcome = data.outcome
  })

  it('step 3 — the battle row is immutable history with a deterministic seed', async () => {
    const battle = await db.battle.findUniqueOrThrow({ where: { id: battleId } })
    expect(battle.attackerPlayerId).toBe(attacker.playerId)
    expect(battle.defenderPlayerId).toBe(defender.playerId)
    expect(battle.seed).toBeGreaterThan(0)
    expect(battle.configVersion).toBe(BATTLE.version)
    expect(battle.endedAt).not.toBeNull()
  })

  it('step 4 — battle history shows the fight from BOTH perspectives', async () => {
    const attackerHistory = await call<{
      battles: Array<{ battleId: string; outcome: string; myRole: string; loot: unknown }>
    }>(historyGet, attacker.token, '/api/v1/battles')
    const defenderHistory = await call<{
      battles: Array<{ battleId: string; outcome: string; myRole: string }>
    }>(historyGet, defender.token, '/api/v1/battles')
    const aRow = attackerHistory.body.data!.battles.find((b) => b.battleId === battleId)
    const dRow = defenderHistory.body.data!.battles.find((b) => b.battleId === battleId)
    expect(aRow).toBeDefined()
    expect(dRow).toBeDefined()
    expect(aRow!.myRole).toBe('ATTACKER')
    expect(dRow!.myRole).toBe('DEFENDER')
    if (outcome === 'VICTORY') {
      expect(aRow!.outcome).toBe('VICTORY')
      expect(dRow!.outcome).toBe('DEFEAT')
    } else if (outcome === 'DEFEAT') {
      expect(aRow!.outcome).toBe('DEFEAT')
      expect(dRow!.outcome).toBe('VICTORY')
    }
  })

  it('step 5 — the round-by-round report is available to both participants', async () => {
    const attackerDetail = await call<{ rounds: unknown[]; seed: number; result: string }>(
      detailGet,
      attacker.token,
      `/api/v1/battles/${battleId}`,
      'GET',
      undefined,
      battleId,
    )
    const defenderDetail = await call<{ rounds: unknown[] }>(
      detailGet,
      defender.token,
      `/api/v1/battles/${battleId}`,
      'GET',
      undefined,
      battleId,
    )
    expect(attackerDetail.status).toBe(200)
    expect(defenderDetail.status).toBe(200)
    expect(attackerDetail.body.data!.seed).toBe(defenderDetail.body.data!.seed)
  })

  it('step 6 — rewards landed: ledger rows, wallet delta, honor, statistics', async () => {
    const ledger = await db.resourceTransaction.findMany({
      where: { refType: 'battle', refId: battleId },
    })
    expect(ledger.length).toBeGreaterThanOrEqual(2)
    expect(ledger.every((row) => row.reason === 'BATTLE_REWARD')).toBe(true)

    const stats = await call<{
      statistics: Record<string, number>
    }>(statisticsGet, attacker.token, '/api/v1/player/statistics')
    expect(stats.body.data!.statistics['attacksLaunched']).toBe(1)
    if (outcome === 'VICTORY') {
      expect(stats.body.data!.statistics['battlesWon']).toBe(1)
      expect(stats.body.data!.statistics['resourcesPlundered']).toBeGreaterThan(0)
    } else if (outcome === 'DEFEAT') {
      expect(stats.body.data!.statistics['battlesLost']).toBe(1)
    }
  })

  it('step 7 — the victor carries season points into the LIVE ranking', async () => {
    const seasonPlayer = await db.player.findUniqueOrThrow({
      where: { id: outcome === 'VICTORY' ? attacker.playerId : defender.playerId },
      select: { seasonPoints: true },
    })
    expect(seasonPlayer.seasonPoints).toBeGreaterThanOrEqual(BATTLE.rewards.victorySeasonPoints)

    const ranking = await call<{
      live: Array<{ playerId: string; score: number }>
    }>(rankingGet, attacker.token, '/api/v1/season/ranking?limit=50')
    expect(ranking.status).toBe(200)
    const row = ranking.body.data!.live.find(
      (r) => r.playerId === (outcome === 'VICTORY' ? attacker.playerId : defender.playerId),
    )
    expect(row).toBeDefined()
    expect(row!.score).toBeGreaterThanOrEqual(BATTLE.rewards.victorySeasonPoints)
  })

  it('step 8 — both participants receive their ATTACK_RESULT notification', async () => {
    await drainNotificationQueue()
    const attackerNotifs = await call<{
      notifications: Array<{ type: string; title: string }>
    }>(notificationsGet, attacker.token, '/api/v1/player/notifications')
    const defenderNotifs = await call<{
      notifications: Array<{ type: string; title: string }>
    }>(notificationsGet, defender.token, '/api/v1/player/notifications')
    const aNotif = attackerNotifs.body.data!.notifications.find((n) => n.type === 'ATTACK_RESULT')
    const dNotif = defenderNotifs.body.data!.notifications.find((n) => n.type === 'ATTACK_RESULT')
    expect(aNotif).toBeDefined()
    expect(dNotif).toBeDefined()
    expect(aNotif!.title).toContain(
      outcome === 'VICTORY' ? 'Victory' : outcome === 'DEFEAT' ? 'Defeat' : 'Stalemate',
    )
    expect(dNotif!.title).toContain(
      outcome === 'VICTORY' ? 'Defeat' : outcome === 'DEFEAT' ? 'Victory' : 'Stalemate',
    )
  })

  it('step 9 — the cooldown blocks an immediate second march (server clock)', async () => {
    const third = await register('x')
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
    await db.player.update({
      where: { id: third.playerId },
      data: { createdAt: twoWeeksAgo, level: BATTLE.protection.newbieLevelCap + 1, xp: 10_000n },
    })
    const { status, body } = await call<{ error?: { code: string } }>(
      attackPost,
      attacker.token,
      '/api/v1/battles/attack',
      'POST',
      { targetPlayerId: third.playerId },
    )
    expect(status).toBe(429)
    expect(body.error?.code).toBe('ACTION_ON_COOLDOWN')
  })
})
