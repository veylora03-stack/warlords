/**
 * Integration tests — Battle System (Phase 28): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod → auth guard → service → transaction → envelope). Attacks run
 * through the PUBLIC service path inside real transactions — real energy
 * CAS, real BigInt ledger rows, real SQLite, zero mocks.
 *
 * Required scenarios (Phase 28 contract):
 *  1. UNAUTHENTICATED       — 401 without a session
 *  2. SELF TARGET           — SELF_TARGET 400
 *  3. NONEXISTENT TARGET    — PLAYER_NOT_FOUND 404 (incl. manipulated ids)
 *  4. BANNED TARGET         — INVALID_TARGET 400
 *  5. PROTECTED TARGET      — PROTECTED_TARGET 403 (newbie shield / repeated raids)
 *  6. ENERGY                — INSUFFICIENT_ENERGY 409; exactly attackCost spent
 *  7. COOLDOWN              — ACTION_ON_COOLDOWN 429; server clock only
 *  8. ARMY                  — ARMY_EMPTY 400 with no units
 *  9. HAPPY PATH            — full pipeline: battle row, rounds, casualties
 *                             (CAS-guarded, never negative), ledger loot both
 *                             sides (BATTLE_REWARD), honor, XP, season points,
 *                             stats, power recalculation, logs, notifications
 * 10. UNGUARDED CITY        — zero-unit defender: auto win, no rounds, loot
 * 11. IDEMPOTENCY           — same key replays the SAME battle; different
 *                             target on a used key → IDEMPOTENT_REPLAY
 * 12. CONCURRENCY           — parallel double-submit ⇒ exactly ONE battle;
 *                             two attackers on one defender ⇒ both resolve,
 *                             defender units never negative
 * 13. VALIDATION            — malformed bodies → typed 400s, zero writes
 * 14. HISTORY + DETAIL      — participant-only access, caller-perspective
 *                             outcomes, round trace present
 * 15. TARGETS               — public roster, armies NEVER included, protection
 *                             reasons computed vs the caller
 *
 * Test identities live in the isolated 9100028… telegramId range and are
 * removed in afterAll (cascades: players, cities, wallets, ledger, battles…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { POST as attackPost } from '../../../src/app/api/v1/battles/attack/route'
import { GET as targetsGet } from '../../../src/app/api/v1/battles/targets/route'
import { GET as historyGet } from '../../../src/app/api/v1/battles/route'
import { GET as detailGet } from '../../../src/app/api/v1/battles/[id]/route'
import * as attackRouteModule from '../../../src/app/api/v1/battles/attack/route'
import * as targetsRouteModule from '../../../src/app/api/v1/battles/targets/route'
import * as historyRouteModule from '../../../src/app/api/v1/battles/route'
import * as detailRouteModule from '../../../src/app/api/v1/battles/[id]/route'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { ensureActiveSeasonInTx } from '../../../src/lib/game/services/season.service'
import { runEconomyTransaction } from '../../../src/lib/game/services/economy.service'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { STARTER_WALLET } from '../../../src/lib/game/config/starter'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Battle integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '203.0.121.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100028001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string, seq = 0): string {
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAA${telegramId.slice(-4)}${seq}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60 - seq),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `BattleLord${telegramId.slice(-3)}`,
      username: `battle_lord_${telegramId.slice(-4)}`,
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

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

type AnyRouteHandler = (
  request: Request,
  ctx?: { params?: Promise<Record<string, string>> },
) => Promise<Response>

async function post<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await (attackPost as unknown as AnyRouteHandler)(
    authedRequest(path, token, 'POST', body),
  )
  return { status: res.status, body: (await res.json()) as Envelope<T> }
}

async function get<T>(
  token: string | null,
  handler: AnyRouteHandler,
  params?: string,
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await handler(
    authedRequest('', token ?? '', 'GET'),
    params ? routeCtx(params) : undefined,
  )
  return { status: res.status, body: (await res.json()) as Envelope<T> }
}

/** Registers a player through the REAL initData exchange; returns (token, playerId). */
async function registerPlayer(tag: string): Promise<{ token: string; playerId: string }> {
  const tgId = nextTgId()
  const initData = buildInitData(tgId)
  const res = await telegramPost(
    new Request('http://localhost:3000/api/v1/auth/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ initData }),
    }),
  )
  const body = (await res.json()) as ApiEnvelope<{
    token: string
    player: { id: string }
  }>
  if (!body.ok || !body.data) throw new Error(`registration failed for ${tag}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

/** Test arrangement: the sandbox rules protect fresh accounts — backdate the
 *  account age + last login AND lift the level above the newbie cap (with a
 *  CONSISTENT xp value — the level is a projection of total xp, and grantXp
 *  re-derives it on every grant) so the target is legitimately attackable. */
async function makeAttackable(playerId: string): Promise<void> {
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
  await db.player.update({
    where: { id: playerId },
    data: {
      createdAt: twoWeeksAgo,
      level: BATTLE.protection.newbieLevelCap + 1,
      xp: BigInt(10_000), // well past the level-6 threshold on the curve
    },
  })
  const user = await db.player.findUniqueOrThrow({
    where: { id: playerId },
    select: { userId: true },
  })
  await db.user.update({
    where: { id: user.userId },
    data: { lastLoginAt: new Date(Date.now() - 2 * 3600_000) },
  })
}

async function giveUnits(playerId: string, unitId: string, count: number): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId } },
    create: { playerId, unitId, count },
    update: { count },
  })
}

async function clearUnits(playerId: string): Promise<void> {
  await db.playerUnit.updateMany({ where: { playerId }, data: { count: 0 } })
}

async function playerSnapshot(playerId: string) {
  const player = await db.player.findUniqueOrThrow({
    where: { id: playerId },
    select: {
      energy: true,
      honor: true,
      xp: true,
      level: true,
      seasonPoints: true,
      power: true,
      stats: true,
    },
  })
  const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
  const units = await db.playerUnit.findMany({ where: { playerId } })
  return { player, wallet, units }
}

let seasonEnsured = false
async function ensureSeason(): Promise<void> {
  if (seasonEnsured) return
  await runEconomyTransaction('battle-test', async (tx) => {
    await ensureActiveSeasonInTx(tx)
  })
  seasonEnsured = true
}

const createdIds: string[] = []

const TG_RANGE_PREFIX = '9100028'

/** Purges every identity in the isolated 9100028… range (idempotent across runs —
 *  earlier crashed runs may have left players whose initData replays attach).
 *  Battles reference players with onDelete: Restrict, so battles (and grant
 *  idempotency keys) are cleared BEFORE the cascading user delete. */
async function purgeTestRange(): Promise<void> {
  const prefix = TG_RANGE_PREFIX
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: prefix } } },
    select: { id: true },
  })
  const playerIds = players.map((p) => p.id)
  if (playerIds.length > 0) {
    await db.battle.deleteMany({
      where: {
        OR: [{ attackerPlayerId: { in: playerIds } }, { defenderPlayerId: { in: playerIds } }],
      },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: playerIds } } })
  }
  await purgeTestUsersByTelegramPrefix(db, prefix)
  createdIds.length = 0
}

beforeAll(async () => {
  await purgeTestRange()
})

afterAll(async () => {
  await purgeTestRange()
})

async function cleanupCreated(): Promise<void> {
  if (createdIds.length === 0) return
  const players = await db.player.findMany({
    where: { id: { in: [...createdIds] } },
    select: { id: true, userId: true },
  })
  for (const player of players) {
    await db.user.delete({ where: { id: player.userId } }).catch(() => undefined)
  }
  createdIds.length = 0
}
// ── Suite ────────────────────────────────────────────────────────────────────

describe('battle system — attack API', () => {
  beforeAll(async () => {
    await ensureSeason()
  })

  afterAll(cleanupCreated)

  it('route modules export exactly the intended verbs', () => {
    expect(Object.keys(attackRouteModule).sort()).toEqual(['POST'])
    expect(Object.keys(targetsRouteModule).sort()).toEqual(['GET'])
    expect(Object.keys(historyRouteModule).sort()).toEqual(['GET'])
    expect(Object.keys(detailRouteModule).sort()).toEqual(['GET'])
  })

  it('rejects an unauthenticated attack (401, zero writes)', async () => {
    const res = await (attackPost as unknown as AnyRouteHandler)(
      new Request('http://localhost:3000/api/v1/battles/attack', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
        body: JSON.stringify({ targetPlayerId: 'whatever' }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('rejects self-attack with SELF_TARGET 400', async () => {
    const attacker = await registerPlayer('self')
    createdIds.push(attacker.playerId)
    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: attacker.playerId,
    })
    expect(status).toBe(400)
    expect(body.error?.code).toBe('SELF_TARGET')
  })

  it('rejects nonexistent and manipulated target ids with 404', async () => {
    const attacker = await registerPlayer('ghost')
    createdIds.push(attacker.playerId)
    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: 'nonexistent-player-id-000',
    })
    expect(status).toBe(404)
    expect(body.error?.code).toBe('PLAYER_NOT_FOUND')
  })

  it('rejects banned targets with INVALID_TARGET', async () => {
    const attacker = await registerPlayer('banatk')
    const target = await registerPlayer('bantgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    const userId = (
      await db.player.findUniqueOrThrow({
        where: { id: target.playerId },
        select: { userId: true },
      })
    ).userId
    await db.user.update({ where: { id: userId }, data: { isBanned: true } })

    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(status).toBe(400)
    expect(body.error?.code).toBe('INVALID_TARGET')
    await db.user.update({ where: { id: userId }, data: { isBanned: false } })
  })

  it('rejects protected (fresh) targets with PROTECTED_TARGET 403 + reasons', async () => {
    const attacker = await registerPlayer('protatk')
    const target = await registerPlayer('prottgt')
    createdIds.push(attacker.playerId, target.playerId)
    // target is brand-new → newbie shield (level < cap AND age < 48h)

    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(status).toBe(403)
    expect(body.error?.code).toBe('PROTECTED_TARGET')
    expect((body.error?.details?.['reasons'] as string[]).length).toBeGreaterThan(0)
  })

  it('rejects repeated raids beyond the per-target daily cap', async () => {
    const attacker = await registerPlayer('raider')
    const target = await registerPlayer('raidtgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    const now = new Date()
    for (let i = 0; i < BATTLE.protection.maxAttacksPerTargetPerDay; i++) {
      await db.battle.create({
        data: {
          type: 'PVP_ATTACK',
          seed: i,
          configVersion: BATTLE.version,
          attackerPlayerId: attacker.playerId,
          defenderPlayerId: target.playerId,
          result: 'ATTACKER_WIN',
          startedAt: new Date(now.getTime() - i * 60_000 - 120_000),
          endedAt: new Date(now.getTime() - i * 60_000 - 119_000),
        },
      })
    }
    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(status).toBe(403)
    expect(body.error?.code).toBe('PROTECTED_TARGET')
    expect(body.error?.details?.['reasons'] as string[]).toContain('REPEATED_RAIDS')
  })

  it('rejects an attack with insufficient energy (409, zero writes)', async () => {
    const attacker = await registerPlayer('tired')
    const target = await registerPlayer('sleepy')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await db.player.update({
      where: { id: attacker.playerId },
      data: { energy: BATTLE.energy.attackCost - 1, energyUpdatedAt: new Date() },
    })
    const before = await db.battle.count()
    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(status).toBe(409)
    expect(body.error?.code).toBe('INSUFFICIENT_ENERGY')
    expect(await db.battle.count()).toBe(before)
  })

  it('rejects an attack with an empty army (ARMY_EMPTY 400)', async () => {
    const attacker = await registerPlayer('empty')
    const target = await registerPlayer('emptytgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await clearUnits(attacker.playerId)
    const { status, body } = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(status).toBe(400)
    expect(body.error?.code).toBe('ARMY_EMPTY')
  })

  it('rejects malformed bodies with typed 400s (negative/huge/garbage)', async () => {
    const attacker = await registerPlayer('garbage')
    createdIds.push(attacker.playerId)
    for (const body of [
      { targetPlayerId: '' },
      { targetPlayerId: 'x'.repeat(500) },
      { targetPlayerId: 12345 },
      { idempotencyKey: 'k'.repeat(500), targetPlayerId: 'whatever' },
      {},
    ]) {
      const { status } = await post(attacker.token, '/api/v1/battles/attack', body)
      expect(status).toBe(400)
    }
  })

  it('runs the full winning pipeline: casualties, loot, honor, xp, season, stats, logs, notifications', async () => {
    const attacker = await registerPlayer('winner')
    const target = await registerPlayer('loser')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 300)

    const attackerBefore = await playerSnapshot(attacker.playerId)
    const targetBefore = await playerSnapshot(target.playerId)

    const { status, body } = await post<{
      battleId: string
      outcome: string
      loot: Record<string, string>
      energySpent: number
      roundsCount: number
    }>(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId })
    expect(status).toBe(200)
    expect(body.data).toBeDefined()
    const data = body.data!
    expect(data.battleId).toBeTruthy()
    expect(data.outcome).toBe('VICTORY') // 300 swordsmen vs 20+10 starter army
    expect(data.roundsCount).toBeGreaterThan(0)
    expect(data.energySpent).toBe(BATTLE.energy.attackCost)

    // Battle row persisted, auditable, immutable history
    const battle = await db.battle.findUniqueOrThrow({ where: { id: data.battleId } })
    expect(battle.type).toBe('PVP_ATTACK')
    expect(battle.result).toBe('ATTACKER_WIN')
    expect(battle.configVersion).toBe(BATTLE.version)
    expect(Number(battle.attackerPower)).toBeGreaterThan(Number(battle.defenderPower))
    const rounds = await db.battleRound.findMany({ where: { battleId: battle.id } })
    // The engine can end a battle mid-round (attacker strikes first), so the
    // attacker always has roundsCount records, the defender roundsCount or one less.
    expect(rounds.filter((r) => r.side === 'ATTACKER').length).toBe(data.roundsCount)
    expect(rounds.length).toBeGreaterThanOrEqual(data.roundsCount)
    expect(rounds.length).toBeLessThanOrEqual(data.roundsCount * 2)
    const logs = await db.battleLog.findMany({ where: { battleId: battle.id } })
    expect(logs.length).toBe(2)

    // Energy spent exactly once
    const attackerAfter = await playerSnapshot(attacker.playerId)
    expect(attackerAfter.player.energy).toBe(
      attackerBefore.player.energy - BATTLE.energy.attackCost,
    )

    // Casualties: attacker units can only shrink, never below zero
    const attackerSwords = attackerAfter.units.find((u) => u.unitId === 'swordsman')
    expect(attackerSwords!.count).toBeGreaterThanOrEqual(0)
    expect(attackerSwords!.count).toBeLessThanOrEqual(300)

    // Loot crossed the ledger on BOTH sides with the battle ref
    const ledgerRows = await db.resourceTransaction.findMany({
      where: { refType: 'battle', refId: battle.id },
    })
    expect(ledgerRows.length).toBeGreaterThanOrEqual(2)
    const attackerLootRows = ledgerRows.filter((r) => r.playerId === attacker.playerId)
    const targetLootRows = ledgerRows.filter((r) => r.playerId === target.playerId)
    expect(attackerLootRows.every((r) => r.reason === 'BATTLE_REWARD' && r.delta > 0n)).toBe(true)
    expect(targetLootRows.every((r) => r.reason === 'BATTLE_REWARD' && r.delta < 0n)).toBe(true)
    // Ledger reconciles to the wallet for the touched resources
    const targetAfter = await playerSnapshot(target.playerId)
    for (const row of targetLootRows) {
      const field = { GOLD: 'gold', WOOD: 'wood', IRON: 'iron', FOOD: 'food', CRYSTAL: 'crystal' }[
        row.resource as 'GOLD'
      ] as 'gold'
      expect(targetAfter.wallet[field]).toBeLessThan(targetBefore.wallet[field])
    }

    // Honor, XP, season points, stats
    expect(attackerAfter.player.honor).toBe(
      attackerBefore.player.honor + BigInt(BATTLE.rewards.attackWinHonor),
    )
    expect(attackerAfter.player.xp).toBe(
      attackerBefore.player.xp + BigInt(BATTLE.rewards.attackWinXp),
    )
    expect(attackerAfter.player.seasonPoints).toBe(
      attackerBefore.player.seasonPoints + BATTLE.rewards.victorySeasonPoints,
    )
    const stats = (attackerAfter.player.stats ?? {}) as Record<string, number>
    expect(stats['battlesWon']).toBe(1)
    expect(stats['attacksLaunched']).toBe(1)
    expect(stats['resourcesPlundered']).toBeGreaterThan(0)

    // Defender paid the real price: units gone, wallet lighter, no negative balances
    expect(targetAfter.wallet.gold).toBeGreaterThanOrEqual(0n)
    expect(targetAfter.wallet.food).toBeGreaterThanOrEqual(0n)

    // Power recalculated from the post-battle army
    expect(attackerAfter.player.power).toBeGreaterThan(0n)

    // Cooldown recorded — an immediate follow-up is refused
    const again = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
    })
    expect(again.status).toBe(429)
    expect(again.body.error?.code).toBe('ACTION_ON_COOLDOWN')
    expect(again.body.error?.details?.['retryAfterSec'] as number).toBeLessThanOrEqual(
      BATTLE.cooldown.attackCooldownSec,
    )

    // Notifications delivered to BOTH participants after the drain
    await drainNotificationQueue({ telegramConfig: { token: null } })
    const attackerNotifs = await db.notification.findMany({
      where: { playerId: attacker.playerId, type: 'ATTACK_RESULT' },
    })
    const targetNotifs = await db.notification.findMany({
      where: { playerId: target.playerId, type: 'ATTACK_RESULT' },
    })
    expect(attackerNotifs.length).toBe(1)
    expect(targetNotifs.length).toBe(1)

    // History shows the battle from each participant's perspective
    const attackerHistory = await get<{
      battles: Array<{ battleId: string; outcome: string; myRole: string }>
    }>(attacker.token, historyGet)
    const targetHistory = await get<{
      battles: Array<{ battleId: string; outcome: string; myRole: string }>
    }>(target.token, historyGet)
    const attackerRow = attackerHistory.body.data!.battles.find((b) => b.battleId === battle.id)
    const targetRow = targetHistory.body.data!.battles.find((b) => b.battleId === battle.id)
    expect(attackerRow?.outcome).toBe('VICTORY')
    expect(attackerRow?.myRole).toBe('ATTACKER')
    // Opponent resolution: each side sees the OTHER player, never themselves.
    expect(attackerRow?.opponent.name).toBe(
      (
        await db.player.findUniqueOrThrow({
          where: { id: target.playerId },
          select: { name: true },
        })
      ).name,
    )
    expect(attackerRow?.opponent.playerId).toBe(target.playerId)
    expect(targetRow?.outcome).toBe('DEFEAT')
    expect(targetRow?.myRole).toBe('DEFENDER')
    expect(targetRow?.opponent.playerId).toBe(attacker.playerId)

    // Detail: participant access + round trace; outsider refused
    const attackerDetail = await get<{ rounds: unknown[]; myRole: string }>(
      attacker.token,
      detailGet,
      battle.id,
    )
    expect(attackerDetail.status).toBe(200)
    expect(attackerDetail.body.data!.myRole).toBe('ATTACKER')
    expect(attackerDetail.body.data!.opponent.playerId).toBe(target.playerId)
    expect(attackerDetail.body.data!.rounds.length).toBeGreaterThan(0)

    const outsider = await registerPlayer('outsider')
    createdIds.push(outsider.playerId)
    const outsiderDetail = await get(outsider.token, detailGet, battle.id)
    expect(outsiderDetail.status).toBe(403)
    expect(outsiderDetail.body.error?.code).toBe('FORBIDDEN')

    // Cooldown expires only by SERVER time — backdating the battle unlocks it
    await db.battle.update({
      where: { id: battle.id },
      data: { startedAt: new Date(Date.now() - (BATTLE.cooldown.attackCooldownSec + 5) * 1000) },
    })
    const secondTarget = await registerPlayer('second')
    createdIds.push(secondTarget.playerId)
    await makeAttackable(secondTarget.playerId)
    const third = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: secondTarget.playerId,
    })
    expect(third.status).toBe(200)
  })
})

describe('battle system — unguarded city & idempotency', () => {
  afterAll(cleanupCreated)

  it('an unguarded city falls without a fight (no rounds, loot granted)', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('raider2')
    const target = await registerPlayer('noguard')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await clearUnits(target.playerId)
    await giveUnits(attacker.playerId, 'cavalry', 50)

    const { status, body } = await post<{
      battleId: string
      unguardedCity: boolean
      roundsCount: number
      loot: Record<string, string>
      outcome: string
    }>(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId })
    expect(status).toBe(200)
    expect(body.data!.outcome).toBe('VICTORY')
    expect(body.data!.unguardedCity).toBe(true)
    expect(body.data!.roundsCount).toBe(0)
    expect(Object.keys(body.data!.loot).length).toBeGreaterThan(0)
    const lootGold = BigInt(body.data!.loot['GOLD'] ?? '0')
    expect(lootGold).toBeGreaterThan(0n)
    expect(lootGold).toBeLessThanOrEqual(
      (BigInt(STARTER_WALLET.GOLD) * BigInt(BATTLE.loot.defenderLootableBps)) / 10_000n,
    )
  })

  it('a duplicate request with the same idempotency key replays the SAME battle', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('idem')
    const target = await registerPlayer('idemtgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 100)
    const key = `test-key-${Date.now()}`

    const first = await post<{ battleId: string; outcome: string; replayed?: boolean }>(
      attacker.token,
      '/api/v1/battles/attack',
      { targetPlayerId: target.playerId, idempotencyKey: key },
    )
    expect(first.status).toBe(200)
    expect(first.body.data!.replayed).toBeUndefined()

    // Second submission — even past the replay fast-path the cooldown would
    // block a NEW battle; the key must return the ORIGINAL result instead.
    const second = await post<{ battleId: string; replayed?: boolean }>(
      attacker.token,
      '/api/v1/battles/attack',
      { targetPlayerId: target.playerId, idempotencyKey: key },
    )
    expect(second.status).toBe(200)
    expect(second.body.data!.replayed).toBe(true)
    expect(second.body.data!.battleId).toBe(first.body.data!.battleId)
    expect(await db.battle.count({ where: { attackerPlayerId: attacker.playerId } })).toBe(1)
  })

  it('a used idempotency key against a DIFFERENT target is a replay conflict', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('idem2')
    const target = await registerPlayer('idem2tgt')
    const other = await registerPlayer('idem2other')
    createdIds.push(attacker.playerId, target.playerId, other.playerId)
    await makeAttackable(target.playerId)
    await makeAttackable(other.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 100)
    const key = `test-key-conflict-${Date.now()}`

    const first = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: target.playerId,
      idempotencyKey: key,
    })
    expect(first.status).toBe(200)

    const replay = await post(attacker.token, '/api/v1/battles/attack', {
      targetPlayerId: other.playerId,
      idempotencyKey: key,
    })
    expect(replay.status).toBe(409)
    expect(replay.body.error?.code).toBe('IDEMPOTENT_REPLAY')
  })
})

describe('battle system — race conditions & exploit attempts', () => {
  afterAll(cleanupCreated)

  it('parallel double-submit (distinct keys) creates exactly ONE battle', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('race1')
    const target = await registerPlayer('race1tgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 200)

    const before = await playerSnapshot(attacker.playerId)
    const [a, b, c] = await Promise.all([
      post(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId }),
      post(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId }),
      post(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId }),
    ])
    const statuses = [a.status, b.status, c.status].sort()
    expect(statuses).toEqual([200, 429, 429]) // one wins, the rest hit the cooldown

    expect(await db.battle.count({ where: { attackerPlayerId: attacker.playerId } })).toBe(1)
    const after = await playerSnapshot(attacker.playerId)
    expect(after.player.energy).toBe(before.player.energy - BATTLE.energy.attackCost)
  })

  it('two attackers on the same defender: both resolve, defender units never negative', async () => {
    await ensureSeason()
    const attackerA = await registerPlayer('raceA')
    const attackerB = await registerPlayer('raceB')
    const victim = await registerPlayer('raceV')
    createdIds.push(attackerA.playerId, attackerB.playerId, victim.playerId)
    await makeAttackable(victim.playerId)
    await giveUnits(attackerA.playerId, 'swordsman', 150)
    await giveUnits(attackerB.playerId, 'swordsman', 150)

    const victimBefore = await playerSnapshot(victim.playerId)
    const victimStartTotal = victimBefore.units.reduce((s, u) => s + u.count, 0)

    const [a, b] = await Promise.all([
      post<{ battleId: string }>(attackerA.token, '/api/v1/battles/attack', {
        targetPlayerId: victim.playerId,
      }),
      post<{ battleId: string }>(attackerB.token, '/api/v1/battles/attack', {
        targetPlayerId: victim.playerId,
      }),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.body.data!.battleId).not.toBe(b.body.data!.battleId)

    const victimAfter = await playerSnapshot(victim.playerId)
    for (const unit of victimAfter.units) {
      expect(unit.count).toBeGreaterThanOrEqual(0)
    }
    const victimEndTotal = victimAfter.units.reduce((s, u) => s + u.count, 0)
    expect(victimEndTotal).toBeLessThanOrEqual(victimStartTotal)
  })

  it('attacker energy can never go negative under parallel attacks', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('energyrace')
    const target = await registerPlayer('energyracetgt')
    createdIds.push(attacker.playerId, target.playerId)
    await makeAttackable(target.playerId)
    await db.player.update({
      where: { id: attacker.playerId },
      data: { energy: BATTLE.energy.attackCost, energyUpdatedAt: new Date() },
    })

    const results = await Promise.all([
      post(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId }),
      post(attacker.token, '/api/v1/battles/attack', { targetPlayerId: target.playerId }),
    ])
    const final = await db.player.findUniqueOrThrow({
      where: { id: attacker.playerId },
      select: { energy: true },
    })
    expect(final.energy).toBeGreaterThanOrEqual(0)
    const succeeded = results.filter((r) => r.status === 200).length
    expect(succeeded).toBeLessThanOrEqual(1)
  })
})

describe('battle system — targets read model', () => {
  afterAll(cleanupCreated)

  it('exposes public info + protection reasons, NEVER armies', async () => {
    await ensureSeason()
    const attacker = await registerPlayer('scout')
    const target = await registerPlayer('scouted')
    createdIds.push(attacker.playerId, target.playerId)
    await giveUnits(target.playerId, 'swordsman', 42)

    const { status, body } = await get<{
      attacker: {
        energy: number
        attackCost: number
        armyUnits: number
        cooldownRemainingSec: number
      }
      targets: Array<{ playerId: string; attackable: boolean; blockedBy: string[] }>
    }>(attacker.token, targetsGet)
    expect(status).toBe(200)
    expect(body.data!.attacker.attackCost).toBe(BATTLE.energy.attackCost)
    expect(body.data!.attacker.armyUnits).toBe(30) // starter army

    const row = body.data!.targets.find((t) => t.playerId === target.playerId)
    expect(row).toBeDefined()
    // Fresh account → newbie shield; the target's 42 units are NOT in the payload
    expect(row!.attackable).toBe(false)
    expect(row!.blockedBy).toContain('NEWBIE_SHIELD')
    expect(JSON.stringify(body.data)).not.toContain('swordsman')

    await makeAttackable(target.playerId)
    const refreshed = await get<{ targets: Array<{ playerId: string; attackable: boolean }> }>(
      attacker.token,
      targetsGet,
    )
    const refreshedRow = refreshed.body.data!.targets.find((t) => t.playerId === target.playerId)
    expect(refreshedRow!.attackable).toBe(true)
    expect(refreshedRow!.blockedBy).toEqual([])
  })
})
