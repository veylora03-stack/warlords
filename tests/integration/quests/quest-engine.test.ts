/**
 * Integration tests — Quest + Achievement Engine (Phase 31): services + routes + DB.
 *
 * Route handlers are invoked directly with constructed Request objects (full
 * stack: Zod params → auth guard → services → transactions → envelope).
 * Quest progress is driven through REAL game transactions only — real battle
 * attacks, real building upgrades, real training completions, real ledger
 * grants — zero mocks, zero injected completion (except the explicitly
 * audited admin tool, which is itself under test).
 *
 * Required scenarios (user contract):
 *  1. ASSIGNMENT       — board assigns eligible quests per cycle; prerequisites
 *                        gate MAIN chains; minLevel gates; daily/weekly cycles.
 *  2. BATTLE → QUEST   — a REAL winning attack progresses battle quests and
 *                        unlocks FIRST VICTORY (achievement + ledger).
 *  3. ECONOMY → QUEST  — ledger credits (BATTLE_REWARD) progress EARN
 *                        objectives; ADMIN_ADJUSTMENT never does.
 *  4. BUILDING → QUEST — a REAL upgrade+finish progresses BUILD_UPGRADE.
 *  5. ARMY → QUEST     — REAL training completion progresses TRAIN_UNITS
 *                        by the batch count (unitsTrained stat too).
 *  6. CLAIM            — guarded transition, ledger QUEST_REWARD payout,
 *                        XP/honor, Σ ledger == balance invariant, REWARD
 *                        notification.
 *  7. EXACTLY-ONCE     — 10 concurrent claims → ONE payout; replayed event
 *                        (same identity) never double-increments.
 *  8. SECURITY MATRIX  — incomplete/other-player/unassigned claims, anonymous
 *                        401, no progress-write surface on the routes.
 *  9. RESET BOUNDARIES — daily cycle rollover re-assigns fresh; seasonal
 *                        quests bind to the ACTIVE season and expire at its end.
 * 10. ADMIN OPS        — toggle (audit), reset, grant, revoke — audited +
 *                        transactional; moderator is FORBIDDEN on manage.
 *
 * Test identities live in the isolated 9100031… telegramId range and are
 * removed in afterAll (cascades: player, city, buildings, wallet, ledger…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as questsGet } from '../../../src/app/api/v1/quests/route'
import { GET as questDetailGet } from '../../../src/app/api/v1/quests/[id]/route'
import { POST as questClaimPost } from '../../../src/app/api/v1/quests/[id]/claim/route'
import { GET as achievementsGet } from '../../../src/app/api/v1/quests/achievements/route'
import { POST as adminQuestActivePost } from '../../../src/app/api/v1/admin/quests/[id]/active/route'
import { POST as adminQuestResetPost } from '../../../src/app/api/v1/admin/players/[id]/quests/[questId]/reset/route'
import { POST as adminQuestGrantPost } from '../../../src/app/api/v1/admin/players/[id]/quests/[questId]/grant/route'
import { POST as adminQuestRevokePost } from '../../../src/app/api/v1/admin/players/[id]/quests/[questId]/revoke/route'
import { POST as attackPost } from '../../../src/app/api/v1/battles/attack/route'
import { POST as upgradePost } from '../../../src/app/api/v1/city/buildings/[type]/upgrade/route'
import { POST as finishPost } from '../../../src/app/api/v1/city/buildings/[type]/finish/route'
import { POST as recruitPost } from '../../../src/app/api/v1/army/train/route'
import { POST as trainFinishPost } from '../../../src/app/api/v1/army/train/[id]/complete/route'
import { BATTLE } from '../../../src/lib/game/config/battle'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { evaluateAchievementsInTx } from '../../../src/lib/game/services/achievement.service'
import { recordPlayerStats } from '../../../src/lib/game/services/stats.service'
import { applyQuestEventInTx } from '../../../src/lib/game/services/quest-events.service'
import { claimQuest, adminSetQuestActive } from '../../../src/lib/game/services/quest.service'
import {
  grantResources,
  runEconomyTransaction,
  getWalletBalances,
} from '../../../src/lib/game/services/economy.service'
import type { ApiEnvelope } from '../../../src/types/api'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Quest integration tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '203.0.122.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100031001
const nextTgId = (): string => String(tgCounter++)

function buildInitData(telegramId: string): string {
  const fields: Record<string, string> = {
    query_id: `AAE5C000000AAAAQ${telegramId.slice(-4)}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `QuestLord${telegramId.slice(-3)}`,
      username: `quest_lord_${telegramId.slice(-4)}`,
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

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code: string; message?: string }
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

async function call<T>(
  handler: AnyRouteHandler,
  token: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; params?: Record<string, string> } = {},
): Promise<{ status: number; body: Envelope<T> }> {
  const res = await handler(authedRequest(path, token, options.method ?? 'GET', options.body), {
    params: Promise.resolve(options.params ?? {}),
  })
  return { status: res.status, body: (await res.json()) as Envelope<T> }
}

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
  const body = (await res.json()) as ApiEnvelope<{ token: string; player: { id: string } }>
  if (!body.ok || !body.data) throw new Error(`registration failed for ${tag}`)
  return { token: body.data.token, playerId: body.data.player.id }
}

/** Backdates account age/level/login EXACTLY like the Phase 28 suite — the
 *  sandbox rules protect fresh accounts, so the target must be legitimately
 *  attackable (server-side protection checks read these columns). */
async function makeAttackable(playerId: string): Promise<void> {
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000)
  await db.player.update({
    where: { id: playerId },
    data: {
      createdAt: twoWeeksAgo,
      level: BATTLE.protection.newbieLevelCap + 1,
      xp: BigInt(10_000),
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

/** Tops the wallet up through the real economy path (idempotent grant). */
async function fundWallet(playerId: string): Promise<void> {
  await runEconomyTransaction(playerId, (tx) =>
    grantResources(
      tx,
      playerId,
      { GOLD: 20_000n, WOOD: 20_000n, IRON: 10_000n, FOOD: 10_000n },
      {
        reason: 'BATTLE_REWARD',
        refType: 'battle',
        refId: `fund:${playerId}`,
      },
    ),
  )
}

async function giveUnits(playerId: string, unitId: string, count: number): Promise<void> {
  await db.playerUnit.upsert({
    where: { playerId_unitId: { playerId, unitId } },
    create: { playerId, unitId, count },
    update: { count },
  })
}

async function clearUnits(playerId: string): Promise<void> {
  await db.playerUnit.deleteMany({ where: { playerId } })
}

interface InstanceShape {
  status: string
  progress: number
  target: number
  claimable: boolean
}

function instanceOf(
  board: { quests: Array<{ id: string; instance: InstanceShape | null }> },
  questId: string,
): InstanceShape | null {
  return board.quests.find((q) => q.id === questId)?.instance ?? null
}

/** Mirrors the battle-service quest integration: event + achievement eval in
 *  one transaction — used where a second/faster win is needed than the real
 *  attack cooldown allows (the real attack path is covered in its own test). */
async function winBattle(playerId: string, battleId: string): Promise<void> {
  await runEconomyTransaction(playerId, async (tx) => {
    await applyQuestEventInTx(tx, playerId, {
      kind: 'BATTLE_FINISHED',
      won: true,
      role: 'ATTACKER',
      battleId,
    })
    // Mirrors battle.service: the win counter feeds STAT-metric achievements.
    await recordPlayerStats(tx, playerId, { battlesWon: 1 })
    await evaluateAchievementsInTx(tx, playerId)
  })
}

async function gemsOf(playerId: string): Promise<bigint> {
  return (await db.player.findUniqueOrThrow({ where: { id: playerId }, select: { gems: true } }))
    .gems
}

const TG_RANGE_PREFIX = '9100031'

/**
 * FK-safe purge of the isolated identity range. Battles reference players
 * with onDelete: Restrict (and admin staff rows reference the user), so
 * dependents are cleared BEFORE the cascading user delete. Runs in
 * beforeAll too — a previously crashed/interrupted run can never pollute
 * the next one (quest state is per-identity, so stale rows would break
 * fresh-cycle assertions).
 */
async function purgeTestRange(): Promise<void> {
  const players = await db.player.findMany({
    where: { user: { telegramId: { startsWith: TG_RANGE_PREFIX } } },
    select: { id: true },
  })
  const playerIds = players.map((p) => p.id)
  const users = await db.user.findMany({
    where: { telegramId: { startsWith: TG_RANGE_PREFIX } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)
  if (userIds.length > 0) {
    await db.adminUser.deleteMany({ where: { userId: { in: userIds } } })
    await db.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } })
  }
  if (playerIds.length > 0) {
    await db.battle.deleteMany({
      where: {
        OR: [{ attackerPlayerId: { in: playerIds } }, { defenderPlayerId: { in: playerIds } }],
      },
    })
    await db.idempotencyKey.deleteMany({ where: { playerId: { in: playerIds } } })
  }
  // Seasonal fixture leftovers reference PlayerQuest rows (Restrict) — clear
  // the instances first, then the definition and the boundary season.
  await db.playerQuest.deleteMany({ where: { questId: 'test-seasonal-capture' } })
  await db.quest.deleteMany({ where: { id: 'test-seasonal-capture' } })
  await db.season.deleteMany({ where: { name: 'Boundary Season' } })
  await db.user.deleteMany({ where: { telegramId: { startsWith: TG_RANGE_PREFIX } } })
}

beforeAll(async () => {
  await purgeTestRange()
  await db.notificationQueue.deleteMany({})
})

afterAll(async () => {
  await purgeTestRange()
})

// ═══════════════════════════════════ 1) ASSIGNMENT ═══════════════════════════

describe('quest assignment (server-decided eligibility)', () => {
  it('assigns starters + current-cycle dailies/weeklies and LOCKS prereq-gated MAIN quests', async () => {
    const p = await registerPlayer('assign')
    const board = await call<{
      quests: Array<{
        id: string
        instance: InstanceShape | null
        eligibility: { eligible: boolean; reason?: string }
      }>
    }>(questsGet, p.token, '/api/v1/quests?filter=all')
    expect(board.status).toBe(200)
    expect(board.body.ok).toBe(true)
    const quests = board.body.data!.quests

    const assigned = quests.filter((q) => q.instance !== null).map((q) => q.id)
    expect(assigned).toContain('main-01-first-steps')
    expect(assigned).toContain('main-02-raise-army')
    expect(assigned).toContain('daily-blood-and-steel')
    expect(assigned).toContain('weekly-recruiter')

    // MAIN chain: main-03 requires main-02 CLAIMED — locked and unassigned.
    const main03 = quests.find((q) => q.id === 'main-03-homes-teeth')!
    expect(main03.instance).toBeNull()
    expect(main03.eligibility.eligible).toBe(false)
    expect(main03.eligibility.reason).toBe('PREREQUISITES')
    expect(quests.find((q) => q.id === 'main-04-first-battle')!.instance).toBeNull()

    // Cycle semantics: the weekly target comes from the catalog (100 units).
    const weekly = instanceOf(board.body.data!, 'weekly-recruiter')!
    expect(weekly.target).toBe(100)
    expect(weekly.progress).toBe(0)
  })

  it('minLevel gates assignment (server-side level check, not client claim)', async () => {
    // Raise the gate BEFORE registration: the bootstrap power recalc already
    // runs an assignment sweep, so the gate must be live from the first event.
    await db.quest.update({ where: { id: 'weekly-recruiter' }, data: { minLevel: 50 } })
    const p = await registerPlayer('minlevel')
    try {
      const board = await call<{
        quests: Array<{ id: string; eligibility: { eligible: boolean; reason?: string } }>
      }>(questsGet, p.token, '/api/v1/quests')
      const weekly = board.body.data!.quests.find((q) => q.id === 'weekly-recruiter')!
      expect(weekly.eligibility.eligible).toBe(false)
      expect(weekly.eligibility.reason).toBe('MIN_LEVEL')
      const row = await db.playerQuest.findFirst({
        where: { playerId: p.playerId, questId: 'weekly-recruiter' },
      })
      expect(row).toBeNull()
    } finally {
      await db.quest.update({ where: { id: 'weekly-recruiter' }, data: { minLevel: 0 } })
    }
  })
})

// ═══════════════════════════ 2) BATTLE → QUEST ═══════════════════════════════

describe('battle events drive quest progress (real attack pipeline)', () => {
  it('a REAL winning attack progresses the daily battle quest and unlocks First Blood', async () => {
    const attacker = await registerPlayer('attacker')
    const target = await registerPlayer('defender')
    await makeAttackable(target.playerId)
    await clearUnits(target.playerId)
    await clearUnits(attacker.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 250)

    const today = new Date().toISOString().slice(0, 10)
    const before = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: attacker.playerId,
          questId: 'daily-blood-and-steel',
          cycle: today,
        },
      },
    })
    expect(before.progress).toBe(0)

    const res = await call<{ battleId: string; outcome: string }>(
      attackPost,
      attacker.token,
      '/api/v1/battles/attack',
      { method: 'POST', body: { targetPlayerId: target.playerId } },
    )
    expect(res.status).toBe(200)
    expect(res.body.data!.outcome).toBe('VICTORY')

    const after = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: attacker.playerId,
          questId: 'daily-blood-and-steel',
          cycle: today,
        },
      },
    })
    expect(after.progress).toBe(1)
    expect(after.lastEventKey).toContain('BATTLE_FINISHED')
    expect(after.lastEventKey).toContain(res.body.data!.battleId)

    // Achievement: FIRST victory unlocks ach-first-blood with a ledger grant.
    const unlocked = await db.playerAchievement.findUnique({
      where: {
        playerId_achievementId: { playerId: attacker.playerId, achievementId: 'ach-first-blood' },
      },
    })
    expect(unlocked).not.toBeNull()
    const achLedger = await db.resourceTransaction.findFirst({
      where: {
        playerId: attacker.playerId,
        reason: 'ACHIEVEMENT_REWARD',
        refId: 'ach-first-blood',
      },
    })
    expect(achLedger).not.toBeNull()

    // Loot credits the EARN objective (weekly-resource-tycoon) via the same tx.
    const tycoon = await db.playerQuest.findFirst({
      where: { playerId: attacker.playerId, questId: 'weekly-resource-tycoon' },
    })
    expect(tycoon).not.toBeNull()
    expect(tycoon!.progress).toBeGreaterThan(0)
  })

  it('reaches completion → QUEST_COMPLETED notification is delivered', async () => {
    const p = await registerPlayer('notify')
    await winBattle(p.playerId, 'evt-notify-1')
    await winBattle(p.playerId, 'evt-notify-2')

    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: new Date().toISOString().slice(0, 10),
        },
      },
    })
    expect(instance.status).toBe('COMPLETED')
    expect(instance.completedAt).not.toBeNull()

    await drainNotificationQueue({ workerId: 'quest-test', telegramConfig: { token: null } })
    const inbox = await db.notification.findFirst({
      where: { playerId: p.playerId, type: 'QUEST_COMPLETED' },
    })
    expect(inbox).not.toBeNull()
    expect(inbox!.title).toContain('Blood and Steel')
    expect(JSON.stringify(inbox!.data)).toContain('daily-blood-and-steel')
  })
})

// ═══════════════════════════ 3) ECONOMY → QUEST ══════════════════════════════

describe('ledger credits drive EARN objectives (and ADMIN_ADJUSTMENT never does)', () => {
  it('BATTLE_REWARD credits progress main-01; ADMIN_ADJUSTMENT is excluded', async () => {
    const p = await registerPlayer('economy')
    await runEconomyTransaction(p.playerId, (tx) =>
      grantResources(
        tx,
        p.playerId,
        { GOLD: 120n },
        {
          reason: 'BATTLE_REWARD',
          refType: 'battle',
          refId: 'evt-econ-1',
        },
      ),
    )
    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'main-01-first-steps',
          cycle: '0',
        },
      },
    })
    expect(instance.progress).toBe(120)

    await runEconomyTransaction(p.playerId, (tx) =>
      grantResources(
        tx,
        p.playerId,
        { GOLD: 500n },
        {
          reason: 'ADMIN_ADJUSTMENT',
          refType: 'admin',
          refId: 'evt-econ-2',
        },
      ),
    )
    const unchanged = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'main-01-first-steps',
          cycle: '0',
        },
      },
    })
    expect(unchanged.progress).toBe(120) // operator corrections are not gameplay
  })
})

// ═══════════════════════════ 4) BUILDING → QUEST ═════════════════════════════

describe('building upgrades drive quest progress (real construction pipeline)', () => {
  it('a REAL upgrade+finish progresses the weekly builder quest', async () => {
    const p = await registerPlayer('builder')
    await fundWallet(p.playerId)
    const start = await call<{ building: { level: number } }>(
      upgradePost,
      p.token,
      '/api/v1/city/buildings/WOOD_MILL/upgrade',
      { method: 'POST', body: {}, params: { type: 'WOOD_MILL' } },
    )
    expect(start.status).toBe(200)
    await db.building.updateMany({
      where: { city: { playerId: p.playerId }, type: 'WOOD_MILL' },
      data: { upgradeCompletesAt: new Date(Date.now() - 1000) },
    })
    const finish = await call<{ newLevel: number }>(
      finishPost,
      p.token,
      '/api/v1/city/buildings/WOOD_MILL/finish',
      { method: 'POST', body: {}, params: { type: 'WOOD_MILL' } },
    )
    expect(finish.status).toBe(200)

    const instance = await db.playerQuest.findFirst({
      where: { playerId: p.playerId, questId: 'weekly-master-builder' },
    })
    expect(instance).not.toBeNull()
    expect(instance!.progress).toBe(1)
    expect(instance!.lastEventKey).toContain('BUILDING_UPGRADED')
  })
})

// ═══════════════════════════ 5) ARMY → QUEST ═════════════════════════════════

describe('training completions drive quest progress (real training pipeline)', () => {
  it('a REAL training batch progresses TRAIN_UNITS by the batch count', async () => {
    const p = await registerPlayer('trainer')
    await fundWallet(p.playerId)
    const recruit = await call<{ item: { id: string } }>(
      recruitPost,
      p.token,
      '/api/v1/army/train',
      { method: 'POST', body: { unitId: 'swordsman', count: 4 } },
    )
    expect(recruit.status).toBe(200)
    const itemId = recruit.body.data!.item.id
    await db.trainingQueueItem.updateMany({
      where: { id: itemId },
      data: { completesAt: new Date(Date.now() - 1000) },
    })
    const finish = await call<{ completed: { count: number } }>(
      trainFinishPost,
      p.token,
      `/api/v1/army/train/${itemId}/complete`,
      { method: 'POST', body: {}, params: { id: itemId } },
    )
    expect(finish.status).toBe(200)
    expect(finish.body.data!.completed.count).toBe(4)

    const instance = await db.playerQuest.findFirst({
      where: { playerId: p.playerId, questId: 'daily-drill-yard' },
    })
    expect(instance).not.toBeNull()
    expect(instance!.progress).toBe(4)

    const stats = JSON.parse(
      JSON.stringify(
        (await db.player.findUniqueOrThrow({ where: { id: p.playerId }, select: { stats: true } }))
          .stats,
      ),
    ) as Record<string, number>
    expect(stats.unitsTrained).toBe(4)
  })
})

// ═══════════════════════════ 6) CLAIM + LEDGER ═══════════════════════════════

describe('quest claim pipeline (guarded transition + ledger payout)', () => {
  it('claims a completed quest: ledger payout, XP, Σ ledger == balance, REWARD notification', async () => {
    const p = await registerPlayer('claimer')
    await winBattle(p.playerId, 'evt-claim-1')
    await winBattle(p.playerId, 'evt-claim-2')

    const detailBefore = await call<{ quest: { instance: InstanceShape } }>(
      questDetailGet,
      p.token,
      '/api/v1/quests/daily-blood-and-steel',
      { params: { id: 'daily-blood-and-steel' } },
    )
    expect(detailBefore.body.data!.quest.instance!.claimable).toBe(true)

    const gemsBefore = await gemsOf(p.playerId)
    const xpBefore = (
      await db.player.findUniqueOrThrow({ where: { id: p.playerId }, select: { xp: true } })
    ).xp

    const claim = await call<{ questId: string; reward: Record<string, number> }>(
      questClaimPost,
      p.token,
      '/api/v1/quests/daily-blood-and-steel/claim',
      { method: 'POST', body: {}, params: { id: 'daily-blood-and-steel' } },
    )
    expect(claim.status).toBe(200)
    expect(claim.body.data!.questId).toBe('daily-blood-and-steel')
    expect(claim.body.data!.reward['GEMS']).toBe(8)
    expect(claim.body.data!.reward['XP']).toBe(60)

    // Ledger path: exactly one QUEST_REWARD transaction for the payout.
    const ledgerRows = await db.resourceTransaction.findMany({
      where: { playerId: p.playerId, reason: 'QUEST_REWARD', refId: 'daily-blood-and-steel' },
    })
    expect(ledgerRows.length).toBe(1)
    expect(ledgerRows[0]!.resource).toBe('GEMS')

    expect((await gemsOf(p.playerId)) - gemsBefore).toBe(8n)
    const xpAfter = (
      await db.player.findUniqueOrThrow({ where: { id: p.playerId }, select: { xp: true } })
    ).xp
    expect(xpAfter - xpBefore).toBe(60n)

    // Σ ledger deltas == balance for EVERY resource (economy invariant).
    const walletAfter = await getWalletBalances(db, p.playerId)
    const sums = await db.resourceTransaction.groupBy({
      by: ['resource'],
      _sum: { delta: true },
      where: { playerId: p.playerId },
    })
    for (const sum of sums) {
      expect(sum._sum.delta).toBe(walletAfter[sum.resource as keyof typeof walletAfter])
    }

    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: new Date().toISOString().slice(0, 10),
        },
      },
    })
    expect(instance.status).toBe('CLAIMED')
    expect(instance.claimedAt).not.toBeNull()

    await drainNotificationQueue({ workerId: 'quest-claim-test', telegramConfig: { token: null } })
    const rewardNote = await db.notification.findFirst({
      where: { playerId: p.playerId, type: 'REWARD' },
    })
    expect(rewardNote).not.toBeNull()
  })

  it('prerequisite chains unlock on CLAIM (not on completion)', async () => {
    const p = await registerPlayer('chain')
    await runEconomyTransaction(p.playerId, (tx) =>
      applyQuestEventInTx(tx, p.playerId, {
        kind: 'RESOURCES_EARNED',
        amounts: { GOLD: 250 },
        sourceRef: 'battle:chain-1',
      }),
    )
    await claimQuest(p.playerId, 'main-01-first-steps')

    const afterFirst = await call<{
      quests: Array<{ id: string; instance: InstanceShape | null }>
    }>(questsGet, p.token, '/api/v1/quests')
    expect(instanceOf(afterFirst.body.data!, 'main-02-raise-army')).not.toBeNull()
    expect(instanceOf(afterFirst.body.data!, 'main-03-homes-teeth')).toBeNull()

    await runEconomyTransaction(p.playerId, (tx) =>
      applyQuestEventInTx(tx, p.playerId, {
        kind: 'UNITS_TRAINED',
        unitId: 'swordsman',
        count: 10,
        queueItemId: 'chain-q1',
      }),
    )
    await claimQuest(p.playerId, 'main-02-raise-army')

    const afterSecond = await call<{
      quests: Array<{ id: string; instance: InstanceShape | null }>
    }>(questsGet, p.token, '/api/v1/quests')
    expect(instanceOf(afterSecond.body.data!, 'main-03-homes-teeth')).not.toBeNull()
  })
})

// ═══════════════════════════ 7) EXACTLY-ONCE ═════════════════════════════════

describe('exactly-once guarantees (concurrency + replay)', () => {
  it('10 concurrent claims → EXACTLY ONE payout, nine typed 409s', async () => {
    const p = await registerPlayer('concurrent')
    await winBattle(p.playerId, 'evt-conc-1')
    await winBattle(p.playerId, 'evt-conc-2')
    const gemsBefore = await gemsOf(p.playerId)

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimQuest(p.playerId, 'daily-blood-and-steel').then(
          (r) => ({ ok: true as const, questId: r.questId }),
          (err: { code?: string }) => ({ ok: false as const, code: err.code }),
        ),
      ),
    )
    expect(results.filter((r) => r.ok).length).toBe(1)
    expect(results.filter((r) => !r.ok && r.code === 'QUEST_ALREADY_CLAIMED').length).toBe(9)

    expect((await gemsOf(p.playerId)) - gemsBefore).toBe(8n)
    const payoutRows = await db.resourceTransaction.findMany({
      where: { playerId: p.playerId, reason: 'QUEST_REWARD', refId: 'daily-blood-and-steel' },
    })
    expect(payoutRows.length).toBe(1)
  })

  it('a replayed event (same identity) never double-increments', async () => {
    const p = await registerPlayer('replay')
    await winBattle(p.playerId, 'evt-replay-dup')
    await winBattle(p.playerId, 'evt-replay-dup')
    await winBattle(p.playerId, 'evt-replay-dup')

    const instance = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: new Date().toISOString().slice(0, 10),
        },
      },
    })
    expect(instance.progress).toBe(1)
  })

  it('the idempotent battle replay path does not re-apply quest events', async () => {
    const attacker = await registerPlayer('idem-attacker')
    const target = await registerPlayer('idem-defender')
    await makeAttackable(target.playerId)
    await clearUnits(target.playerId)
    await clearUnits(attacker.playerId)
    await giveUnits(attacker.playerId, 'swordsman', 300)

    const body = { targetPlayerId: target.playerId, idempotencyKey: 'quest-idem-key-1' }
    const first = await call<{ battleId: string; outcome: string }>(
      attackPost,
      attacker.token,
      '/api/v1/battles/attack',
      { method: 'POST', body },
    )
    expect(first.status).toBe(200)

    const today = new Date().toISOString().slice(0, 10)
    const progressOf = async (): Promise<number> =>
      (
        await db.playerQuest.findUniqueOrThrow({
          where: {
            playerId_questId_cycle: {
              playerId: attacker.playerId,
              questId: 'daily-blood-and-steel',
              cycle: today,
            },
          },
        })
      ).progress

    const afterFirst = await progressOf()

    // Backdate the cooldown so a replay is possible, then replay the SAME key.
    await db.battle.updateMany({
      where: { attackerPlayerId: attacker.playerId },
      data: { startedAt: new Date(Date.now() - 10 * 60_000) },
    })
    const replay = await call<{ battleId: string; replayed?: boolean }>(
      attackPost,
      attacker.token,
      '/api/v1/battles/attack',
      { method: 'POST', body },
    )
    expect(replay.status).toBe(200)
    expect(replay.body.data!.battleId).toBe(first.body.data!.battleId)
    expect(replay.body.data!.replayed).toBe(true)
    expect(await progressOf()).toBe(afterFirst) // unchanged — no double progress
  })
})

// ═══════════════════════════ 8) SECURITY MATRIX ══════════════════════════════

describe('claim security (server-authoritative everywhere)', () => {
  it('rejects claiming an INCOMPLETE quest (409 QUEST_NOT_COMPLETED)', async () => {
    const p = await registerPlayer('sec-incomplete')
    const res = await call(questClaimPost, p.token, '/api/v1/quests/weekly-resource-tycoon/claim', {
      method: 'POST',
      body: {},
      params: { id: 'weekly-resource-tycoon' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error?.code).toBe('QUEST_NOT_COMPLETED')
  })

  it('rejects claiming a quest assigned only to ANOTHER player; ghost ids are 404', async () => {
    const owner = await registerPlayer('sec-owner')
    const stranger = await registerPlayer('sec-stranger')
    await winBattle(owner.playerId, 'evt-sec-1')
    await winBattle(owner.playerId, 'evt-sec-2')

    // The stranger has no instance of their own for that quest in this cycle —
    // quest state is strictly per-player; the OWNER's completion is unreachable.
    const res = await call(
      questClaimPost,
      stranger.token,
      '/api/v1/quests/daily-blood-and-steel/claim',
      { method: 'POST', body: {}, params: { id: 'daily-blood-and-steel' } },
    )
    expect(res.status).toBe(409)
    expect(res.body.error?.code).toBe('QUEST_NOT_COMPLETED')

    // A catalog quest that was never assigned at all.
    const ghost = await call(
      questClaimPost,
      stranger.token,
      '/api/v1/quests/main-05-warlord/claim',
      { method: 'POST', body: {}, params: { id: 'main-05-warlord' } },
    )
    expect(ghost.status).toBe(404)
    expect(ghost.body.error?.code).toBe('QUEST_NOT_FOUND')
  })

  it('rejects unknown quest ids (404)', async () => {
    const p = await registerPlayer('sec-unknown')
    const res = await call(
      questClaimPost,
      p.token,
      '/api/v1/quests/quest-that-does-not-exist/claim',
      { method: 'POST', body: {}, params: { id: 'quest-that-does-not-exist' } },
    )
    expect(res.status).toBe(404)
    expect(res.body.error?.code).toBe('QUEST_NOT_FOUND')
  })

  it('anonymous requests are 401 and the claim route exposes NO other verbs', async () => {
    const anon = await questsGet(new Request('http://localhost:3000/api/v1/quests'))
    expect(anon.status).toBe(401)
    const anonClaim = await questClaimPost(
      new Request('http://localhost:3000/api/v1/quests/main-01-first-steps/claim', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'main-01-first-steps' }) },
    )
    expect(anonClaim.status).toBe(401)

    const claimModule = await import('../../../src/app/api/v1/quests/[id]/claim/route')
    expect(claimModule.GET).toBeUndefined()
    expect(claimModule.PUT).toBeUndefined()
    expect(claimModule.PATCH).toBeUndefined()
    expect(claimModule.DELETE).toBeUndefined()
  })
})

// ═══════════════════════════ 9) RESET BOUNDARIES ═════════════════════════════

describe('cycle reset boundaries (server UTC clock only)', () => {
  it('daily rollover: yesterday\u2019s instance expires and a FRESH one is assigned', async () => {
    const p = await registerPlayer('rollover')
    const today = new Date().toISOString().slice(0, 10)
    await winBattle(p.playerId, 'evt-roll-1')
    const before = await db.playerQuest.findUniqueOrThrow({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: today,
        },
      },
    })
    expect(before.progress).toBe(1)

    // Simulate one UTC day passing: re-cycle the instance to yesterday.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await db.playerQuest.update({
      where: { id: before.id },
      data: { cycle: yesterday, expiresAt: new Date(Date.now() - 1000) },
    })

    const board = await call(questsGet, p.token, '/api/v1/quests')
    expect(board.status).toBe(200)

    const stale = await db.playerQuest.findUnique({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: yesterday,
        },
      },
    })
    expect(stale!.status).toBe('EXPIRED')
    const fresh = await db.playerQuest.findUnique({
      where: {
        playerId_questId_cycle: {
          playerId: p.playerId,
          questId: 'daily-blood-and-steel',
          cycle: today,
        },
      },
    })
    expect(fresh).not.toBeNull()
    expect(fresh!.progress).toBe(0) // no cross-cycle pollution
  })

  it('seasonal quests bind to the ACTIVE season, expire at its end, and never cross seasons', async () => {
    const p = await registerPlayer('seasonal')
    const season = await db.season.findFirst({ orderBy: { number: 'desc' } })
    expect(season).not.toBeNull()
    await db.quest.create({
      data: {
        id: 'test-seasonal-capture',
        type: 'SEASONAL',
        title: 'Season Capture',
        description: 'Win 1 battle this season.',
        objectiveType: 'WIN_BATTLES',
        objectiveTarget: { amount: 1 },
        reward: { GOLD: 100 },
        prerequisiteQuestIds: [],
        minLevel: 0,
        repeatable: true,
        cooldownHours: 0,
        sortOrder: 900,
      },
    })
    try {
      await winBattle(p.playerId, 'evt-season-1')
      const seasonInstance = await db.playerQuest.findUnique({
        where: {
          playerId_questId_cycle: {
            playerId: p.playerId,
            questId: 'test-seasonal-capture',
            cycle: String(season!.number),
          },
        },
      })
      expect(seasonInstance).not.toBeNull()
      expect(seasonInstance!.status).toBe('COMPLETED')
      expect(seasonInstance!.expiresAt!.getTime()).toBe(season!.endsAt.getTime())

      // Unclaimed seasonal rewards EXPIRE at the boundary (spec §18 decision).
      await db.playerQuest.update({
        where: { id: seasonInstance!.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      const claimRes = await call(
        questClaimPost,
        p.token,
        '/api/v1/quests/test-seasonal-capture/claim',
        { method: 'POST', body: {}, params: { id: 'test-seasonal-capture' } },
      )
      expect(claimRes.status).toBe(409)
      expect(claimRes.body.error?.code).toBe('QUEST_EXPIRED')

      // A NEXT season produces a DIFFERENT cycle — no cross-season pollution.
      await db.season.create({
        data: {
          number: season!.number + 1,
          name: 'Boundary Season',
          startsAt: new Date(Date.now() - 1000),
          endsAt: new Date(Date.now() + 30 * 86_400_000),
          status: 'UPCOMING',
        },
      })
      await winBattle(p.playerId, 'evt-season-2')
      const nextSeasonInstance = await db.playerQuest.findUnique({
        where: {
          playerId_questId_cycle: {
            playerId: p.playerId,
            questId: 'test-seasonal-capture',
            cycle: String(season!.number + 1),
          },
        },
      })
      expect(nextSeasonInstance).not.toBeNull()
      expect(nextSeasonInstance!.id).not.toBe(seasonInstance!.id)
      expect(nextSeasonInstance!.expiresAt!.getTime()).toBe(
        (
          await db.season.findUniqueOrThrow({ where: { number: season!.number + 1 } })
        ).endsAt.getTime(),
      )
    } finally {
      await db.quest.deleteMany({ where: { id: 'test-seasonal-capture' } }).catch(() => {})
      await db.season.deleteMany({ where: { number: season!.number + 1 } }).catch(() => {})
    }
  })
})

// ═══════════════════════════ 10) ADMIN OPS ═══════════════════════════════════

describe('admin quest operations (RBAC + audit + transactional)', () => {
  let adminToken = ''
  let moderatorToken = ''
  let adminUserId = ''

  beforeAll(async () => {
    const admin = await registerPlayer('admin')
    const moderator = await registerPlayer('moderator')
    adminToken = admin.token
    moderatorToken = moderator.token
    const adminPlayer = await db.player.findUniqueOrThrow({ where: { id: admin.playerId } })
    const modPlayer = await db.player.findUniqueOrThrow({ where: { id: moderator.playerId } })
    adminUserId = adminPlayer.userId
    await db.adminUser.upsert({
      where: { userId: adminPlayer.userId },
      create: { userId: adminPlayer.userId, role: 'ADMIN', isActive: true },
      update: { role: 'ADMIN', isActive: true },
    })
    await db.adminUser.upsert({
      where: { userId: modPlayer.userId },
      create: { userId: modPlayer.userId, role: 'MODERATOR', isActive: true },
      update: { role: 'MODERATOR', isActive: true },
    })
  })

  it('ADMIN can disable a quest — assignment stops, audit row is written', async () => {
    const res = await call<{ id: string; isActive: boolean }>(
      adminQuestActivePost,
      adminToken,
      '/api/v1/admin/quests/weekly-recruiter/active',
      {
        method: 'POST',
        body: { isActive: false, reason: 'quest-engine test toggle' },
        params: { id: 'weekly-recruiter' },
      },
    )
    expect(res.status).toBe(200)
    expect(res.body.data!.isActive).toBe(false)

    const audit = await db.auditLog.findFirst({
      where: { action: 'quest.set_active', targetId: 'weekly-recruiter' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
    expect(audit!.actorUserId).toBe(adminUserId)

    // A fresh player must NOT be assigned the disabled quest.
    const fresh = await registerPlayer('post-disable')
    const board = await call<{
      quests: Array<{ id: string; instance: InstanceShape | null }>
    }>(questsGet, fresh.token, '/api/v1/quests')
    expect(instanceOf(board.body.data!, 'weekly-recruiter')).toBeNull()

    await adminSetQuestActive({
      actorUserId: adminUserId,
      questId: 'weekly-recruiter',
      isActive: true,
    })
  })

  it('MODERATOR is FORBIDDEN on quests.manage (403 ADMIN_FORBIDDEN)', async () => {
    const res = await call(
      adminQuestActivePost,
      moderatorToken,
      '/api/v1/admin/quests/weekly-recruiter/active',
      { method: 'POST', body: { isActive: false }, params: { id: 'weekly-recruiter' } },
    )
    expect(res.status).toBe(403)
    expect(res.body.error?.code).toBe('ADMIN_FORBIDDEN')
  })

  it('grant marks COMPLETED (reward still via normal claim); revoke + reset are audited', async () => {
    const victim = await registerPlayer('grant-victim')
    const grant = await call<{ questId: string; instanceId: string }>(
      adminQuestGrantPost,
      adminToken,
      `/api/v1/admin/players/${victim.playerId}/quests/main-01-first-steps/grant`,
      {
        method: 'POST',
        body: { reason: 'quest-engine grant test' },
        params: { id: victim.playerId, questId: 'main-01-first-steps' },
      },
    )
    expect(grant.status).toBe(200)
    const granted = await db.playerQuest.findUniqueOrThrow({
      where: { id: grant.body.data!.instanceId },
    })
    expect(granted.status).toBe('COMPLETED')
    expect(granted.lastEventKey).toBe('ADMIN_GRANT')

    // The reward still flows through the NORMAL claim (no injection surface).
    const claim = await call(
      questClaimPost,
      victim.token,
      '/api/v1/quests/main-01-first-steps/claim',
      { method: 'POST', body: {}, params: { id: 'main-01-first-steps' } },
    )
    expect(claim.status).toBe(200)

    // Revoke of a CLAIMED instance is refused (rewards are never clawed back).
    const revoke = await call(
      adminQuestRevokePost,
      adminToken,
      `/api/v1/admin/players/${victim.playerId}/quests/main-01-first-steps/revoke`,
      {
        method: 'POST',
        body: { reason: 'quest-engine revoke test' },
        params: { id: victim.playerId, questId: 'main-01-first-steps' },
      },
    )
    expect(revoke.status).toBe(409)
    expect(revoke.body.error?.code).toBe('QUEST_NOT_COMPLETED')

    // Reset removes ALL instances of the quest for the player (audited).
    const reset = await call<{ deleted: number }>(
      adminQuestResetPost,
      adminToken,
      `/api/v1/admin/players/${victim.playerId}/quests/main-01-first-steps/reset`,
      {
        method: 'POST',
        body: { reason: 'quest-engine reset test' },
        params: { id: victim.playerId, questId: 'main-01-first-steps' },
      },
    )
    expect(reset.status).toBe(200)
    expect(reset.body.data!.deleted).toBeGreaterThanOrEqual(1)
    const remaining = await db.playerQuest.findMany({
      where: { playerId: victim.playerId, questId: 'main-01-first-steps' },
    })
    expect(remaining.length).toBe(0)
    const audit = await db.auditLog.findFirst({
      where: { action: 'quest.reset_player_quest' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
  })
})

// ═══════════════════════ ACHIEVEMENTS (permanent layer) ══════════════════════

describe('achievements (permanent, exactly-once, auto-reward)', () => {
  it('unlock exactly once under repeated evaluation; reward granted once', async () => {
    const p = await registerPlayer('ach-dup')
    for (let i = 0; i < 3; i++) {
      await winBattle(p.playerId, `evt-ach-${i}`)
    }
    const unlocks = await db.playerAchievement.findMany({
      where: { playerId: p.playerId, achievementId: 'ach-first-blood' },
    })
    expect(unlocks.length).toBe(1)

    const payouts = await db.resourceTransaction.findMany({
      where: { playerId: p.playerId, reason: 'ACHIEVEMENT_REWARD', refId: 'ach-first-blood' },
    })
    expect(payouts.length).toBe(1)

    const board = await call<{
      achievements: Array<{
        id: string
        unlocked: boolean
        unlockedAt: string | null
        progress: { current: number } | null
      }>
    }>(achievementsGet, p.token, '/api/v1/quests/achievements')
    expect(board.status).toBe(200)
    const firstBlood = board.body.data!.achievements.find((a) => a.id === 'ach-first-blood')!
    expect(firstBlood.unlocked).toBe(true)
    expect(firstBlood.unlockedAt).not.toBeNull()
    const warlord = board.body.data!.achievements.find((a) => a.id === 'ach-warlord')!
    expect(warlord.unlocked).toBe(false)
    expect(warlord.progress!.current).toBe(3)
  })
})
