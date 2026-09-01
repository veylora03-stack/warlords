/**
 * Integration tests — Player System (Phase 4): routes + services + DB.
 *
 * Route handlers are invoked directly with constructed Request objects, so
 * the FULL stack is exercised: Zod validation → auth guard → services →
 * transactions → envelope. Real crypto, real DB, zero mocks.
 *
 * Covered scenarios:
 *  1. unauthorized API access (anonymous + garbage token) → 401
 *  2. first-login chain: Telegram User → User → Player → City → Initial
 *     Resources (wallet = ledger faucet, 17 buildings, starter army,
 *     level 1 / xp 0, power EXACTLY from real state, energy, zero stats)
 *  3. duplicate registration → idempotent (same player, no double faucet)
 *  4. concurrent registration (service-level + route-level races) → converge
 *  5. XP grants → level-ups + notifications + cap clamping
 *  6. power integrity → derived from state, recalculated after mutation
 *  7. statistics write path validation
 *  8. energy lazy regeneration
 *
 * Test identities live in the isolated 9100003… telegramId range and are
 * removed in afterAll (cascades: player, wallet, city, sessions…).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createHmac } from 'node:crypto'
import { db } from '../../../src/lib/db'
import { POST as telegramPost } from '../../../src/app/api/v1/auth/telegram/route'
import { GET as profileGet } from '../../../src/app/api/v1/player/profile/route'
import { GET as statisticsGet } from '../../../src/app/api/v1/player/statistics/route'
import { GET as stateGet } from '../../../src/app/api/v1/player/state/route'
import {
  ensurePlayer,
  runRegistrationTransaction,
} from '../../../src/lib/game/services/player-registration.service'
import { grantXp, XP_CAPS } from '../../../src/lib/game/services/progression.service'
import { drainNotificationQueue } from '../../../src/lib/game/services/notification.service'
import { recordPlayerStats, readPlayerStats } from '../../../src/lib/game/services/stats.service'
import {
  computePlayerPower,
  recalculatePlayerPower,
} from '../../../src/lib/game/services/power.service'
import {
  LEVELING,
  CUMULATIVE_XP_BY_LEVEL,
  MAX_TOTAL_XP,
} from '../../../src/lib/game/config/leveling'
import { ENERGY } from '../../../src/lib/game/config/energy'
import { STARTER_WALLET } from '../../../src/lib/game/config/starter'
import { emptyPlayerStats } from '../../../src/lib/game/config/stats'
import type { ApiEnvelope } from '../../../src/types/api'
import { purgeTestUsersByTelegramPrefix } from '../../helpers/cleanup'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const JWT_SECRET = process.env['JWT_SECRET']

if (!BOT_TOKEN || !JWT_SECRET) {
  throw new Error(
    'Integration player tests require TELEGRAM_BOT_TOKEN and JWT_SECRET in the environment (.env).',
  )
}

const IP_BASE = '198.51.101.'
let ipCounter = 1
const nextIp = (): string => `${IP_BASE}${ipCounter++}`

let tgCounter = 9100003001
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
    query_id: `AAPH400000AAAA${telegramId.slice(-4)}${seq}`,
    auth_date: String(Math.floor(Date.now() / 1000) - 60 - seq),
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: `PlayerLord${telegramId.slice(-3)}`,
      username: `player_lord_${telegramId.slice(-4)}`,
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

function authedGet(path: string, token: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': nextIp() },
  })
}

interface PlayerProfileData {
  id: string
  name: string
  level: number
  xp: string
  xpIntoLevel: number
  xpForNextLevel: number
  levelProgressBps: number
  power: string
  powerBreakdown: { units: number; buildings: number; technologies: number }
  honor: string
  reputation: string
  reputationScore: number
  energy: number
  energyMax: number
  energyNextRegenAtMs: number | null
  city: { id: string; name: string; x: number; y: number } | null
}

interface PlayerStateData {
  profile: PlayerProfileData
  wallet: { gold: string; wood: string; iron: string; food: string; crystal: string }
  army: Array<{ unitId: string; name: string; class: string; tier: number; count: number }>
  buildingCount: number
}

async function parse<T>(res: Response): Promise<ApiEnvelope<T>> {
  return (await res.json()) as ApiEnvelope<T>
}

async function exchange(tgId: string, seq = 0): Promise<{ token: string; playerId: string }> {
  const res = await telegramPost(telegramRequest(buildInitData(tgId, seq)))
  expect(res.status).toBe(200)
  const body = await parse<{ token: string; player: { id: string } | null }>(res)
  expect(body.ok).toBe(true)
  if (!body.ok || !body.data.player) throw new Error('exchange did not return a player')
  return { token: body.data.token, playerId: body.data.player.id }
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const chainTgId = nextTgId() // first-login chain + duplicates
const dupTgId = nextTgId()
const raceTgId = nextTgId()
const xpTgId = nextTgId()
const statTgId = nextTgId()
const energyTgId = nextTgId()

let chainToken = ''
let chainPlayerId = ''

beforeAll(async () => {
  const exchanged = await exchange(chainTgId, 0)
  chainToken = exchanged.token
  chainPlayerId = exchanged.playerId
})

afterAll(async () => {
  // Cascades remove players, wallets, cities, buildings, units, sessions…
  await purgeTestUsersByTelegramPrefix(db, '9100003')
  await db.$disconnect()
})

// ── 1. Authorization ─────────────────────────────────────────────────────────

describe('GET /api/v1/player/* — authorization middleware', () => {
  const paths = [
    '/api/v1/player/profile',
    '/api/v1/player/statistics',
    '/api/v1/player/state',
  ] as const

  for (const path of paths) {
    it(`anonymous ${path} → 401 UNAUTHORIZED`, async () => {
      const res = await fetch(new Request(`http://localhost:3000${path}`))
      expect(res.status).toBe(401)
      const body = await parse(res)
      expect(body.ok).toBe(false)
      if (!body.ok) expect(body.error.code).toBe('UNAUTHORIZED')
    })

    it(`garbage bearer ${path} → 401`, async () => {
      const res = await fetch(
        new Request(`http://localhost:3000${path}`, {
          headers: { authorization: 'Bearer not-a-real-token' },
        }),
      )
      expect(res.status).toBe(401)
    })
  }

  it('unauthored handler surface — only GET is exported (no client write path)', async () => {
    const profile = await import('../../../src/app/api/v1/player/profile/route')
    const state = await import('../../../src/app/api/v1/player/state/route')
    for (const mod of [profile, state]) {
      const exported = Object.keys(mod).filter((k) => k !== 'dynamic')
      expect(exported).toEqual(['GET'])
    }
  })
})

// ── 2. First-login chain ─────────────────────────────────────────────────────

describe('first-login chain — Telegram User → User → Player → City → Initial Resources', () => {
  it('GET /player/state returns the complete bootstrapped state', async () => {
    const res = await stateGet(authedGet('/api/v1/player/state', chainToken))
    expect(res.status).toBe(200)
    const body = await parse<PlayerStateData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return

    const { profile, wallet, army, buildingCount } = body.data

    // Initial resources — exactly the starter wallet (BigInt → strings).
    expect(wallet).toEqual({
      gold: String(STARTER_WALLET.GOLD),
      wood: String(STARTER_WALLET.WOOD),
      iron: String(STARTER_WALLET.IRON),
      food: String(STARTER_WALLET.FOOD),
      crystal: String(STARTER_WALLET.CRYSTAL),
    })

    // City + 17 starter buildings.
    expect(profile.city).not.toBeNull()
    expect(typeof profile.city!.x).toBe('number')
    expect(buildingCount).toBe(17)

    // Starter army (Phase 7 roster): 20 swordsmen + 10 archers.
    const swordsman = army.find((u) => u.unitId === 'swordsman')
    const archer = army.find((u) => u.unitId === 'archer')
    expect(swordsman?.count).toBe(20)
    expect(archer?.count).toBe(10)

    // Progression: level 1, zero XP, curve position reported.
    expect(profile.level).toBe(1)
    expect(profile.xp).toBe('0')
    expect(profile.xpIntoLevel).toBe(0)
    expect(profile.xpForNextLevel).toBe(LEVELING.baseXp)
    expect(profile.levelProgressBps).toBe(0)

    // Power: computed from REAL state (never hand-set) — exact starter value.
    expect(profile.power).toBe('5030')
    expect(profile.powerBreakdown).toEqual({ units: 3350, buildings: 1680, technologies: 0 })

    // Honor / reputation / energy initial values.
    expect(profile.honor).toBe('0')
    expect(profile.reputation).toBe('NEUTRAL')
    expect(profile.reputationScore).toBe(0)
    expect(profile.energy).toBe(100)
    expect(profile.energyMax).toBe(ENERGY.max)
  })

  it('GET /player/statistics returns zero-filled typed counters', async () => {
    const res = await statisticsGet(authedGet('/api/v1/player/statistics', chainToken))
    expect(res.status).toBe(200)
    const body = await parse<{ playerId: string; statistics: Record<string, number> }>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.statistics).toEqual(emptyPlayerStats())
  })

  it('stored Player.power column matches the freshly computed state', async () => {
    const player = await db.player.findUniqueOrThrow({
      where: { id: chainPlayerId },
      select: { power: true },
    })
    const fresh = await computePlayerPower(db, chainPlayerId)
    expect(player.power).toBe(5030n)
    expect(fresh.total).toBe(5030)
  })

  it('ledger invariant — exactly 5 BOOTSTRAP faucet rows back the wallet', async () => {
    const ledger = await db.resourceTransaction.findMany({
      where: { playerId: chainPlayerId },
      select: { resource: true, delta: true, balanceAfter: true, reason: true },
    })
    expect(ledger.length).toBe(5)
    for (const row of ledger) {
      expect(row.reason).toBe('BOOTSTRAP')
      expect(row.balanceAfter).toBe(row.delta)
    }
  })
})

// ── 3. Duplicate registration ────────────────────────────────────────────────

describe('duplicate registration — idempotent, never forks a second player', () => {
  it('re-login with fresh initData re-attaches to the SAME player', async () => {
    const before = {
      players: await db.player.count({ where: { userId: (await findUserId(chainTgId))! } }),
      ledger: await db.resourceTransaction.count({ where: { playerId: chainPlayerId } }),
    }
    expect(before.players).toBe(1)
    expect(before.ledger).toBe(5)

    // A genuinely NEW initData (new auth_date/query_id) → new session, SAME player.
    const { token, playerId } = await exchange(chainTgId, 1)
    expect(playerId).toBe(chainPlayerId)

    // State unchanged: no second player, no double faucet, no extra city.
    const userId = (await findUserId(chainTgId))!
    expect(await db.player.count({ where: { userId } })).toBe(1)
    expect(await db.city.count({ where: { player: { userId } } })).toBe(1)
    expect(await db.resourceWallet.count({ where: { player: { userId } } })).toBe(1)
    expect(await db.resourceTransaction.count({ where: { playerId: chainPlayerId } })).toBe(5)

    // The new session token works on the player APIs.
    const res = await profileGet(authedGet('/api/v1/player/profile', token))
    expect(res.status).toBe(200)
    const body = await parse<PlayerProfileData>(res)
    if (body.ok) expect(body.data.id).toBe(chainPlayerId)
  })

  it('direct ensurePlayer on an existing player short-circuits (created=false)', async () => {
    let userId = await findUserId(dupTgId)
    if (!userId) userId = (await createUser(dupTgId)).userId
    const first = await db.$transaction((tx) => ensurePlayer(tx, { userId, name: 'DupLord' }))
    expect(first.created).toBe(true)

    const again = await db.$transaction((tx) => ensurePlayer(tx, { userId, name: 'DupLord' }))
    expect(again.created).toBe(false)
    expect(again.playerId).toBe(first.playerId)

    // The bootstrap ran exactly once.
    expect(await db.city.count({ where: { player: { userId } } })).toBe(1)
    expect(await db.resourceTransaction.count({ where: { playerId: first.playerId } })).toBe(5)
  })
})

// ── 4. Concurrent registration ───────────────────────────────────────────────

describe('concurrent registration — races converge on exactly one player', () => {
  it('service-level: N parallel ensurePlayer transactions → ONE player', async () => {
    const { userId } = await createUser(raceTgId)

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runRegistrationTransaction((tx) => ensurePlayer(tx, { userId, name: 'RaceLord' })),
      ),
    )

    const created = results.filter((r) => r.created)
    expect(created.length).toBe(1)
    expect(new Set(results.map((r) => r.playerId)).size).toBe(1)

    // Exactly one full bootstrap in the database.
    expect(await db.player.count({ where: { userId } })).toBe(1)
    expect(await db.city.count({ where: { player: { userId } } })).toBe(1)
    expect(await db.resourceWallet.count({ where: { player: { userId } } })).toBe(1)
    expect(await db.resourceTransaction.count({ where: { playerId: results[0]!.playerId } })).toBe(
      5,
    )
  }, 30_000)

  it('route-level: N parallel first logins for the same Telegram id → all 200, ONE player', async () => {
    const tgId = nextTgId()
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        telegramPost(telegramRequest(buildInitData(tgId, i + 10))),
      ),
    )
    for (const res of responses) {
      expect(res.status).toBe(200)
    }

    const user = await db.user.findUnique({
      where: { telegramId: tgId },
      include: { player: true },
    })
    expect(user).not.toBeNull()
    expect(user!.player).not.toBeNull()
    expect(await db.player.count({ where: { userId: user!.id } })).toBe(1)
    expect(await db.city.count({ where: { player: { userId: user!.id } } })).toBe(1)
    expect(await db.resourceTransaction.count({ where: { playerId: user!.player!.id } })).toBe(5)
  }, 30_000)
})

// ── 5. XP / Level system ─────────────────────────────────────────────────────

describe('XP & level progression — server-side grants only', () => {
  it('grant below the boundary updates XP without a level-up', async () => {
    const { playerId } = await exchange(xpTgId, 0)
    const result = await db.$transaction((tx) =>
      grantXp(tx, { playerId, amount: 40, source: 'test:quest' }),
    )
    expect(result.level).toBe(1)
    expect(result.levelsGained).toBe(0)
    expect(result.leveledUp).toBe(false)
    expect(result.xp).toBe(40)

    const player = await db.player.findUniqueOrThrow({ where: { id: playerId } })
    expect(player.xp).toBe(40n)
    expect(player.level).toBe(1)
  }, 20_000)

  it('grant crossing the boundary levels up and emits an outbox notification', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: xpTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id

    const result = await db.$transaction(
      (tx) => grantXp(tx, { playerId, amount: 60, source: 'test:quest' }), // 40 + 60 = 100 = level 2
    )
    expect(result.leveledUp).toBe(true)
    expect(result.levelsGained).toBe(1)
    expect(result.level).toBe(2)

    // The level-up notice is ENQUEUED (Phase 22 engine) — the inbox row
    // lands after the worker drains.
    const queued = await db.notificationQueue.findFirst({
      where: { playerId, type: 'RANK_CHANGE', dedupeKey: `level_up:${playerId}:2` },
    })
    expect(queued).not.toBeNull()
    expect(queued!.status).toBe('PENDING')

    await drainNotificationQueue({ workerId: 'player-test', telegramConfig: { token: null } })

    const notification = await db.notification.findFirst({
      where: { playerId, type: 'RANK_CHANGE' },
      orderBy: { createdAt: 'desc' },
    })
    expect(notification).not.toBeNull()
    expect(notification!.title).toContain('Level 2')

    // Profile API reflects the derived progression.
    const { token } = await exchange(xpTgId, 1)
    const res = await profileGet(authedGet('/api/v1/player/profile', token))
    const body = await parse<PlayerProfileData>(res)
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.level).toBe(2)
      expect(body.data.xp).toBe('100')
      expect(body.data.xpIntoLevel).toBe(0)
      expect(body.data.xpForNextLevel).toBe(CUMULATIVE_XP_BY_LEVEL[2]! - CUMULATIVE_XP_BY_LEVEL[1]!)
    }
  }, 20_000)

  it('rejects non-positive, fractional and overflowing amounts (never client-shaped)', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: xpTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id
    for (const amount of [0, -5, 1.5, Number.NaN]) {
      expect(
        db.$transaction((tx) => grantXp(tx, { playerId, amount, source: 'test:bad' })),
      ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    }
  }, 20_000)

  it('caps at the configured max level and clamps further XP', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: xpTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id

    const result = await db.$transaction((tx) =>
      grantXp(tx, { playerId, amount: MAX_TOTAL_XP, source: 'test:cap' }),
    )
    expect(result.level).toBe(XP_CAPS.maxLevel)
    expect(result.atMaxLevel).toBe(true)
    expect(result.xp).toBe(MAX_TOTAL_XP)

    const again = await db.$transaction((tx) =>
      grantXp(tx, { playerId, amount: 9_999, source: 'test:cap-again' }),
    )
    expect(again.xp).toBe(MAX_TOTAL_XP)
    expect(again.level).toBe(XP_CAPS.maxLevel)

    const player = await db.player.findUniqueOrThrow({ where: { id: playerId } })
    expect(player.xp).toBe(BigInt(MAX_TOTAL_XP))
    expect(player.level).toBe(LEVELING.maxLevel)
  }, 20_000)
})

// ── 6. Power integrity ───────────────────────────────────────────────────────

describe('power — always derived from real state, never from clients', () => {
  it('recalculatePlayerPower mirrors added state exactly', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: chainTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id

    // Mutate state directly (as the training service would, in-tx).
    const newPower = await db.$transaction(async (tx) => {
      await tx.playerUnit.update({
        where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
        data: { count: { increment: 10 } },
      })
      return recalculatePlayerPower(tx, playerId)
    })

    // swordsman base power is 136/unit → +10 units = +1360.
    expect(newPower).toBe(5030 + 1360)

    const fresh = await computePlayerPower(db, playerId)
    expect(fresh.total).toBe(newPower)

    const stored = await db.player.findUniqueOrThrow({
      where: { id: playerId },
      select: { power: true },
    })
    expect(stored.power).toBe(BigInt(newPower))

    // Restore the starter state for the duplicate-registration assertions above.
    await db.$transaction(async (tx) => {
      await tx.playerUnit.update({
        where: { playerId_unitId: { playerId, unitId: 'swordsman' } },
        data: { count: { decrement: 10 } },
      })
      await recalculatePlayerPower(tx, playerId)
    })
  }, 20_000)
})

// ── 7. Statistics ────────────────────────────────────────────────────────────

describe('statistics — append-only validated counters', () => {
  it('records increments and serves them through the API', async () => {
    const { playerId } = await exchange(statTgId, 0)
    const stats = await db.$transaction((tx) =>
      recordPlayerStats(tx, playerId, {
        unitsTrained: 10,
        battlesWon: 2,
        resourcesCollected: 500,
      }),
    )
    expect(stats['unitsTrained']).toBe(10)
    expect(stats['battlesWon']).toBe(2)

    // A second increment accumulates.
    await db.$transaction((tx) => recordPlayerStats(tx, playerId, { unitsTrained: 5 }))
    const final = await db.$transaction((tx) => readPlayerStats(tx, playerId))
    expect(final['unitsTrained']).toBe(15)

    const { token } = await exchange(statTgId, 1)
    const res = await statisticsGet(authedGet('/api/v1/player/statistics', token))
    const body = await parse<{ statistics: Record<string, number> }>(res)
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.statistics['unitsTrained']).toBe(15)
      expect(body.data.statistics['battlesWon']).toBe(2)
      expect(body.data.statistics['resourcesCollected']).toBe(500)
      expect(body.data.statistics['questsCompleted']).toBe(0) // untouched counter stays typed
    }
  }, 20_000)

  it('rejects unknown keys, zero/negative/fractional deltas and empty payloads', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: statTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id
    expect(
      db.$transaction((tx) => recordPlayerStats(tx, playerId, { hackerStat: 5 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(
      db.$transaction((tx) => recordPlayerStats(tx, playerId, { battlesWon: 0 })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(
      db.$transaction((tx) => recordPlayerStats(tx, playerId, { battlesWon: -1 })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(
      db.$transaction((tx) => recordPlayerStats(tx, playerId, { battlesWon: 1.5 })),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
    expect(db.$transaction((tx) => recordPlayerStats(tx, playerId, {}))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  }, 20_000)
})

// ── 8. Energy lazy regeneration ──────────────────────────────────────────────

describe('energy — lazy-tick regeneration on read', () => {
  it('GET /player/profile advances energy by elapsed whole ticks and carries the partial', async () => {
    const { playerId, token } = await exchange(energyTgId, 0)

    // Simulate consumption + a 2.5-interval gap (like the pure-function test).
    const backdated = new Date(Date.now() - 2.5 * ENERGY.regenIntervalSec * 1000)
    await db.player.update({
      where: { id: playerId },
      data: { energy: 40, energyUpdatedAt: backdated },
    })

    const res = await profileGet(authedGet('/api/v1/player/profile', token))
    const body = await parse<PlayerProfileData>(res)
    expect(body.ok).toBe(true)
    if (!body.ok) return
    expect(body.data.energy).toBe(42) // 40 + 2 whole ticks

    // Immediate second read: the partial interval is preserved (no double regen).
    const again = await profileGet(authedGet('/api/v1/player/profile', token))
    const againBody = await parse<PlayerProfileData>(again)
    if (againBody.ok) expect(againBody.data.energy).toBe(42)
  }, 20_000)

  it('never regenerates above the cap and nulls the next-regen marker', async () => {
    const user = await db.user.findUnique({
      where: { telegramId: energyTgId },
      include: { player: true },
    })
    const playerId = user!.player!.id
    await db.player.update({
      where: { id: playerId },
      data: {
        energy: ENERGY.max - 1,
        energyUpdatedAt: new Date(Date.now() - 10 * ENERGY.regenIntervalSec * 1000),
      },
    })

    const { token } = await exchange(energyTgId, 1)
    const res = await profileGet(authedGet('/api/v1/player/profile', token))
    const body = await parse<PlayerProfileData>(res)
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.energy).toBe(ENERGY.max)
      expect(body.data.energyNextRegenAtMs).toBeNull()
    }
  }, 20_000)
})

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findUserId(telegramId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { telegramId }, select: { id: true } })
  return user?.id ?? null
}

async function createUser(telegramId: string): Promise<{ userId: string }> {
  const user = await db.user.create({
    data: { telegramId, firstName: 'RaceLord', lastLoginAt: new Date() },
    select: { id: true },
  })
  return { userId: user.id }
}
