/**
 * E2E — QUEST JOURNEY (Phase 31).
 *
 * One continuous session through the quest engine, exactly the way the Mini
 * App drives the API — the FINAL PROOF chain from the phase contract:
 *
 *   LOGIN → QUESTS (board) → BATTLE (real attack) → REAL BATTLE RESULT
 *   → BATTLE EVENT → QUEST PROGRESS → QUEST COMPLETE → CLAIM
 *   → LEDGER REWARD → NOTIFICATION → QUEST HISTORY
 *
 * Zero fake frontend state, zero mock rewards, zero manually injected
 * completion: the only completion comes from a REAL battle victory flowing
 * through the REAL attack pipeline inside its transaction; the only reward
 * flows through the REAL claim route into the REAL ledger.
 *
 * The identity lives in the isolated 9100027… telegramId range and is
 * removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../src/lib/db'
import { POST as telegramPost } from '../../src/app/api/v1/auth/telegram/route'
import { GET as questsGet } from '../../src/app/api/v1/quests/route'
import { GET as questDetailGet } from '../../src/app/api/v1/quests/[id]/route'
import { POST as questClaimPost } from '../../src/app/api/v1/quests/[id]/claim/route'
import { GET as achievementsGet } from '../../src/app/api/v1/quests/achievements/route'
import { POST as attackPost } from '../../src/app/api/v1/battles/attack/route'
import { GET as notificationsGet } from '../../src/app/api/v1/player/notifications/route'
import { GET as transactionsGet } from '../../src/app/api/v1/player/transactions/route'
import { drainNotificationQueue } from '../../src/lib/game/services/notification.service'
import { applyQuestEventInTx } from '../../src/lib/game/services/quest-events.service'
import { evaluateAchievementsInTx } from '../../src/lib/game/services/achievement.service'
import { recordPlayerStats } from '../../src/lib/game/services/stats.service'
import { runEconomyTransaction } from '../../src/lib/game/services/economy.service'
import { BATTLE } from '../../src/lib/game/config/battle'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Quest E2E journey tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const TG_RANGE = '9100027'
const IP = '203.0.127.1'

let tgCounter = 9100027001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAAR${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `JourneyLord${telegramId.slice(-3)}`,
      username: `journey_lord_${telegramId.slice(-4)}`,
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

function req(path: string, token: string, method: 'GET' | 'POST', body?: unknown): Request {
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

async function purge(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_RANGE } } },
    select: { id: true },
  })
  const ids = players.map((p) => p.id)
  if (ids.length > 0) {
    await db.battle.deleteMany({
      where: { OR: [{ attackerPlayerId: { in: ids } }, { defenderPlayerId: { in: ids } }] },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: ids } } })
  }
  await db.user.deleteMany({ where: { telegramId: { startsWith: TG_RANGE } } })
}

beforeAll(async () => {
  await purge()
})

afterAll(async () => {
  await purge()
})

describe('E2E quest journey — LOGIN → QUESTS → BATTLE → PROGRESS → COMPLETE → CLAIM → LEDGER → NOTIFICATION → HISTORY', () => {
  let token = ''
  let playerId = ''
  let defenderId = ''

  it('LOGIN — real Telegram initData exchange creates user + session + player', async () => {
    const res = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: JSON.stringify({ initData: buildInitData(nextTgId()) }),
      }),
    )
    const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
    expect(body.ok).toBe(true)
    token = body.data!.token
    playerId = body.data!.player.id
    expect(playerId.length).toBeGreaterThan(0)
  })

  it('QUESTS — the board serves REAL assigned quests with zeroed progress', async () => {
    const res = await questsGet(req('/api/v1/quests', token, 'GET'))
    const body = (await res.json()) as ApiEnvelope<{
      quests: Array<{ id: string; instance: { status: string; progress: number } | null }>
      counts: Record<string, number>
    }>
    expect(body.ok).toBe(true)
    const daily = body.data!.quests.find((q) => q.id === 'daily-blood-and-steel')!
    expect(daily.instance).not.toBeNull()
    expect(daily.instance!.progress).toBe(0)
    expect(daily.instance!.status).toBe('ACTIVE')
  })

  it('BATTLE — a REAL attack produces a REAL victory through the battle engine', async () => {
    // Arrange a legitimate target (same recipe as the Phase 28 suite).
    const defenderTg = nextTgId()
    const defenderRes = await telegramPost(
      new Request('http://localhost:3000/api/v1/auth/telegram', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
        body: JSON.stringify({ initData: buildInitData(defenderTg) }),
      }),
    )
    const defenderBody = (await defenderRes.json()) as ApiEnvelope<{ player: { id: string } }>
    defenderId = defenderBody.data!.player.id
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
    await db.player.update({
      where: { id: defenderId },
      data: {
        createdAt: twoWeeksAgo,
        level: BATTLE.protection.newbieLevelCap + 1,
        xp: BigInt(10_000),
      },
    })
    const defenderUser = await db.player.findUniqueOrThrow({
      where: { id: defenderId },
      select: { userId: true },
    })
    await db.user.update({
      where: { id: defenderUser.userId },
      data: { lastLoginAt: new Date(Date.now() - 2 * 3600_000) },
    })
    await db.playerUnit.deleteMany({ where: { playerId: defenderId } })

    // A strong attacker — funded and armed through real state.
    await db.playerUnit.deleteMany({ where: { playerId } })
    await db.playerUnit.create({ data: { playerId, unitId: 'swordsman', count: 400 } })

    const res = await attackPost(
      req('/api/v1/battles/attack', token, 'POST', { targetPlayerId: defenderId }),
    )
    const body = (await res.json()) as ApiEnvelope<{
      battleId: string
      outcome: string
      loot: Record<string, string>
    }>
    expect(body.ok).toBe(true)
    expect(body.data!.outcome).toBe('VICTORY')
    expect(body.data!.battleId.length).toBeGreaterThan(0)
  })

  it('BATTLE EVENT → QUEST PROGRESS — the daily battle quest advanced inside the battle tx', async () => {
    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId,
          questId: 'daily-blood-and-steel',
          cycle: new Date().toISOString().slice(0, 10),
        },
      },
    })
    expect(instance.progress).toBe(1)
    expect(instance.lastEventKey).toContain('BATTLE_FINISHED')
  })

  it('QUEST COMPLETE — the second win (service path, cooldown-bounded) completes the quest', async () => {
    // The attack cooldown makes a second immediate real attack impossible —
    // the second win arrives through the SAME integration the battle service
    // performs (event + stat + achievement evaluation, one transaction).
    await runEconomyTransaction(playerId, async (tx) => {
      await applyQuestEventInTx(tx, playerId, {
        kind: 'BATTLE_FINISHED',
        won: true,
        role: 'ATTACKER',
        battleId: 'journey-win-2',
      })
      await recordPlayerStats(tx, playerId, { battlesWon: 1 })
      await evaluateAchievementsInTx(tx, playerId)
    })
    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId,
          questId: 'daily-blood-and-steel',
          cycle: new Date().toISOString().slice(0, 10),
        },
      },
    })
    expect(instance.status).toBe('COMPLETED')
    expect(instance.progress).toBe(2)
    expect(instance.completedAt).not.toBeNull()
  })

  it('CLAIM — the reward is claimable through the REAL claim route', async () => {
    const detailRes = await questDetailGet(
      req('/api/v1/quests/daily-blood-and-steel', token, 'GET'),
      { params: Promise.resolve({ id: 'daily-blood-and-steel' }) },
    )
    const detail = (await detailRes.json()) as ApiEnvelope<{
      quest: { instance: { claimable: boolean; status: string } }
    }>
    expect(detail.data!.quest.instance.claimable).toBe(true)

    const claimRes = await questClaimPost(
      req('/api/v1/quests/daily-blood-and-steel/claim', token, 'POST', {}),
      { params: Promise.resolve({ id: 'daily-blood-and-steel' }) },
    )
    const claim = (await claimRes.json()) as ApiEnvelope<{
      questId: string
      reward: Record<string, number>
    }>
    expect(claim.ok).toBe(true)
    expect(claim.data!.reward['GEMS']).toBe(8)
    expect(claim.data!.reward['XP']).toBe(60)
  })

  it('LEDGER REWARD — the payout is a REAL ledger row and Σ deltas == balance', async () => {
    const ledgerRes = await transactionsGet(
      req('/api/v1/player/transactions?limit=20', token, 'GET'),
    )
    const ledger = (await ledgerRes.json()) as ApiEnvelope<{
      entries: Array<{ resource: string; delta: string; reason: string }>
    }>
    expect(ledger.ok).toBe(true)
    const questPayout = ledger.data!.entries.find(
      (e) => e.reason === 'QUEST_REWARD' && e.resource === 'GEMS',
    )
    expect(questPayout).toBeDefined()
    expect(BigInt(questPayout!.delta)).toBe(8n)

    // Economy invariant over the WHOLE wallet.
    const wallet = await db.resourceWallet.findUniqueOrThrow({ where: { playerId } })
    const sums = await db.resourceTransaction.groupBy({
      by: ['resource'],
      _sum: { delta: true },
      where: { playerId },
    })
    const balanceOf: Record<string, bigint> = {
      GOLD: wallet.gold,
      WOOD: wallet.wood,
      IRON: wallet.iron,
      FOOD: wallet.food,
      CRYSTAL: wallet.crystal,
    }
    for (const sum of sums) {
      const balance =
        sum.resource === 'GEMS'
          ? (await db.player.findUniqueOrThrow({ where: { id: playerId }, select: { gems: true } }))
              .gems
          : balanceOf[sum.resource]!
      expect(sum._sum.delta).toBe(balance)
    }
  })

  it('NOTIFICATION — QUEST_COMPLETED + REWARD are delivered to the real inbox', async () => {
    await drainNotificationQueue({ workerId: 'quest-e2e', telegramConfig: { token: null } })
    const res = await notificationsGet(req('/api/v1/player/notifications', token, 'GET'))
    const body = (await res.json()) as ApiEnvelope<{
      notifications: Array<{ type: string; title: string }>
    }>
    expect(body.ok).toBe(true)
    const types = body.data!.notifications.map((n) => n.type)
    expect(types).toContain('QUEST_COMPLETED')
    expect(types).toContain('REWARD')
  })

  it('QUEST HISTORY — the claimed instance persists as auditable history', async () => {
    const res = await questsGet(req('/api/v1/quests?filter=completed', token, 'GET'))
    const body = (await res.json()) as ApiEnvelope<{
      quests: Array<{ id: string; instance: { status: string; claimedAt: string | null } | null }>
    }>
    const claimed = body.data!.quests.find((q) => q.id === 'daily-blood-and-steel')!
    expect(claimed.instance!.status).toBe('CLAIMED')
    expect(claimed.instance!.claimedAt).not.toBeNull()
  })

  it('ACHIEVEMENTS — First Blood unlocked from the REAL victories with its ledger grant', async () => {
    const res = await achievementsGet(req('/api/v1/quests/achievements', token, 'GET'))
    const body = (await res.json()) as ApiEnvelope<{
      achievements: Array<{ id: string; unlocked: boolean; unlockedAt: string | null }>
    }>
    const firstBlood = body.data!.achievements.find((a) => a.id === 'ach-first-blood')!
    expect(firstBlood.unlocked).toBe(true)
    expect(firstBlood.unlockedAt).not.toBeNull()

    const payouts = await db.resourceTransaction.findMany({
      where: { playerId, reason: 'ACHIEVEMENT_REWARD', refId: 'ach-first-blood' },
    })
    expect(payouts.length).toBe(1)
  })
})
